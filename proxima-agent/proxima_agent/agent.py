"""Proxima Agent — Dynamic Execution Agent Loop.
Executes model-authored code with robust extraction, safety gating, and verification.
"""
import json
import re
import time as _time_mod
from openai import OpenAI
from rich.panel import Panel
from .tools import ALL_TOOLS
from .tools.execute import execute_code, check_safety, check_web_misuse, sanitize_code, kill_worker
from .tools.attach import consume_pending, clear_pending
from enum import Enum
from dataclasses import dataclass
from .brain import Brain
from .brain.bucket import BucketManager, BucketStatus
from .prompt import PromptManager
from .permissions import PermissionMode, check_permission

class TaskOutcomeReason(Enum):
    COMPLETED = "completed"
    MAX_ITERATIONS = "max_iterations"
    VERIFICATION_FAILED = "verification_failed"
    ABORTED = "aborted"
    USER_CANCELLED = "user_cancelled"
    GAVE_UP = "gave_up"
    EXECUTION_FAILED = "execution_failed"

@dataclass
class TaskOutcome:
    completed: bool
    reason: TaskOutcomeReason

MAX_TOOL_RESULT_CHARS = 10000
MAX_CONTEXT_MESSAGES = 30
MAX_AUTO_RETRIES = 3

import queue
import threading

_ACTIVE_API_THREADS = set()
_ABANDONED_THREADS = set()
_ACTIVE_THREADS_LOCK = threading.Lock()

_TELEMETRY = {
    "api_cancelled_count": 0,
    "abandoned_thread_count": 0,
    "max_concurrent_abandoned": 0,
}

def _prune_active_threads() -> int:
    """Safely prunes dead threads from registries and updates telemetry."""
    global _ACTIVE_API_THREADS, _ABANDONED_THREADS
    with _ACTIVE_THREADS_LOCK:
        dead_active = {t for t in _ACTIVE_API_THREADS if not t.is_alive()}
        _ACTIVE_API_THREADS.difference_update(dead_active)
        
        dead_abandoned = {t for t in _ABANDONED_THREADS if not t.is_alive()}
        _ABANDONED_THREADS.difference_update(dead_abandoned)
        
        _TELEMETRY["abandoned_thread_count"] = len(_ABANDONED_THREADS)
        _TELEMETRY["max_concurrent_abandoned"] = max(
            _TELEMETRY["max_concurrent_abandoned"],
            len(_ABANDONED_THREADS)
        )
        return len(_ACTIVE_API_THREADS)

def get_telemetry_stats() -> dict:
    """Returns a copy of telemetry stats."""
    _prune_active_threads()
    with _ACTIVE_THREADS_LOCK:
        return dict(_TELEMETRY)


def _call_api_with_cancellation(client, console, *args, **kwargs):
    """Executes a chat completion call in a background daemon thread to allow cancellation polling."""
    global _ACTIVE_API_THREADS, _ABANDONED_THREADS, _TELEMETRY
    
    active_count = _prune_active_threads()
        
    if active_count >= 3:
        _wait_start = _time_mod.time()
        while active_count >= 3 and (_time_mod.time() - _wait_start) < 2.0:
            _time_mod.sleep(0.1)
            active_count = _prune_active_threads()
            
        if active_count >= 3 and console:
            console.print("Some previous provider requests are still finishing in the background.")
            
    res_queue = queue.Queue()
    
    def _target():
        try:
            res = client.chat.completions.create(*args, **kwargs)
            res_queue.put((res, None))
        except Exception as e:
            res_queue.put((None, e))
        finally:
            try:
                me = threading.current_thread()
                with _ACTIVE_THREADS_LOCK:
                    _ACTIVE_API_THREADS.discard(me)
                    _ABANDONED_THREADS.discard(me)
            except Exception:
                pass
            
    t = threading.Thread(target=_target, daemon=True)
    with _ACTIVE_THREADS_LOCK:
        _ACTIVE_API_THREADS.add(t)
    t.start()
    
    while t.is_alive():
        if console and getattr(console, "is_cancelled", False):
            with _ACTIVE_THREADS_LOCK:
                _ABANDONED_THREADS.add(t)
                _TELEMETRY["api_cancelled_count"] += 1
            return None, True
        _time_mod.sleep(0.1)
        
    try:
        res, err = res_queue.get_nowait()
        if err:
            raise err
        return res, False
    except queue.Empty:
        return None, False


_TOOL_IMPORT_PATTERNS = {
    "browser_cdp": "browser",
    "ChromeBrowser": "browser",
    "desktop": "desktop",
    "Desktop": "desktop",
    "screen": "screen",
    "ocr": "screen",
    "code_env": "file",
    "shell": "shell",
    "subprocess": "shell",
}


def _detect_tools_in_code(code: str) -> set:
    """Detects which tools are referenced in code."""
    found = set()
    for pattern, env in _TOOL_IMPORT_PATTERNS.items():
        if pattern in code:
            found.add(env)
    return found


def _get_error_docs(code: str) -> str | None:
    """Fetches docs for tools used in failed code."""
    tools_needed = _detect_tools_in_code(code)
    if not tools_needed:
        return None

    from .prompt.tool_docs import fetch_help
    docs_parts = []
    for tool_env in tools_needed:
        try:
            doc = fetch_help(tool_env, "all")
            docs_parts.append(f"[TOOL DOCS — {tool_env.upper()}]\n{doc}")
        except Exception:
            pass

    if docs_parts:
        return "\n\n".join(docs_parts)
    return None

_VERIFY_SEPARATOR = "# --- verify ---"
_VERIFY_OUTPUT_MARKER = "=== VERIFY ==="


def _inject_verify_marker(code: str) -> str:
    """Replaces verify separator with a try/except guarded block."""
    if _VERIFY_SEPARATOR not in code:
        return code

    parts = code.split(_VERIFY_SEPARATOR, 1)
    step_code = parts[0].rstrip()
    verify_code = parts[1].strip()

    if not verify_code:
        return step_code

    indented = "\n".join(f"    {line}" for line in verify_code.split("\n"))

    return (
        f"{step_code}\n"
        f'print("\\n{_VERIFY_OUTPUT_MARKER}")\n'
        f"try:\n"
        f"{indented}\n"
        f"except Exception as _v_err:\n"
        f'    print(f"VERIFY_ERROR: {{_v_err}}")'
    )


_ERROR_SIGNALS = [
    "Traceback (most recent call last)",
    "SyntaxError:", "NameError:", "TypeError:", "ValueError:",
    "AttributeError:", "ImportError:", "ModuleNotFoundError:",
    "FileNotFoundError:", "PermissionError:", "OSError:",
    "KeyError:", "IndexError:", "RuntimeError:",
    "subprocess.CalledProcessError", "ConnectionError:",
    "TimeoutError:", "UnicodeDecodeError:",
]

_EXEC_OK_MARKER = "[✓]"
_EXEC_FAIL_MARKER = "[✗"


def _is_error(result: str) -> bool:
    """Returns True if the last code execution failed."""
    if not result:
        return False
    stripped = result.lstrip()
    if stripped.startswith(_EXEC_OK_MARKER):
        return False
    if stripped.startswith(_EXEC_FAIL_MARKER):
        return True
    return any(sig in result for sig in _ERROR_SIGNALS)


def _latest_verify_result(executions) -> str:
    """Returns the most recent execution output containing a VERIFY marker."""
    for rec in reversed(executions):
        res = rec.verify_markers
        if res and "VERIFY:" in res:
            return res
    return ""


def _latest_outcome_signal(executions):
    """Returns the most recent terminal verification signal."""
    for rec in reversed(executions):
        res = rec.verify_markers
        if not res:
            continue
        if "VERIFY:FAIL" in res or "VERIFY_ERROR" in res:
            return "FAIL"
        if "TASK:GAVE_UP" in res:
            return "GAVE_UP"
        if "VERIFY:PASS" in res:
            return "PASS"
        if "VERIFY:UNKNOWN" in res:
            return "UNKNOWN"
    return None


def _make_retry_prompt(code: str, error: str, attempt: int) -> str:
    """Generates an auto-retry prompt."""
    return (
        f"[SYSTEM — AUTO-RETRY {attempt}/{MAX_AUTO_RETRIES}]\n"
        f"Your code failed with this error:\n"
        f"```\n{error[:2000]}\n```\n\n"
        f"Failed code:\n"
        f"```python\n{code[:3000]}\n```\n\n"
        f"Fix the root cause and try a DIFFERENT approach. Do NOT repeat the same code."
    )


def _strip_markdown(text: str) -> str:
    """Strips markdown formatting for clean terminal display."""
    lines = []
    in_code_block = False
    
    for line in text.split('\n'):
        stripped = line.strip()
        
        if stripped.startswith('```'):
            in_code_block = not in_code_block
            continue
        
        if in_code_block:
            lines.append(line)
            continue
        
        if stripped.startswith('#'):
            line = re.sub(r'^(\s*)#{1,6}\s+', r'\1', line)
        
        line = re.sub(r'^(\s*)\*\s+', r'\1- ', line)
        line = re.sub(r'\*\*(.+?)\*\*', r'\1', line)
        line = re.sub(r'(?<!\S)\*(.+?)\*(?!\S)', r'\1', line)
        line = re.sub(r'`([^`]+)`', r'\1', line)
        lines.append(line)
    
    return '\n'.join(lines)


def create_client(config: dict) -> OpenAI:
    """Creates OpenAI client pointing to Proxima."""
    return OpenAI(
        base_url=config["api_url"],
        api_key=config["api_key"],
    )


def _truncate(text: str, limit: int = None) -> str:
    if limit is None:
        try:
            from .config import get_limit
            limit = get_limit("max_tool_result_chars", MAX_TOOL_RESULT_CHARS)
        except Exception:
            limit = MAX_TOOL_RESULT_CHARS
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n\n... [truncated {len(text) - limit} chars] ...\n\n" + text[-half:]


def _detect_execution_targets(code: str) -> set:
    """Detects which target systems the executed code interacted with."""
    targets = set()
    if "ChromeBrowser" in code or "browser_cdp" in code:
        targets.add("browser")
    if "Desktop" in code or "pyautogui" in code or "window_manager" in code:
        targets.add("desktop")
    if "subprocess" in code or "os.system(" in code or "os.popen(" in code:
        targets.add("shell")
    return targets or {"general"}


def _passive_context_snapshot(code: str, is_err: bool) -> str:
    """Generates a targeted context snapshot and appends past lessons."""
    targets = _detect_execution_targets(code)
    parts = [f"step_result: {'FAIL' if is_err else 'OK'}"]
    ctx_key = None

    if "browser" in targets:
        try:
            import urllib.request as _url_req
            from .config import CDP_URL
            req = _url_req.Request(f"{CDP_URL}/json", method="GET")
            with _url_req.urlopen(req, timeout=0.3) as resp:
                pages = json.loads(resp.read())
                if pages:
                    page = pages[0]
                    url = page.get("url", "")
                    title = page.get("title", "")
                    if url and not url.startswith("chrome://"):
                        parts.append(f"browser_url: {url[:150]}")
                        ctx_key = url
                    if title:
                        parts.append(f"browser_title: {title[:100]}")
        except Exception:
            pass

    if "desktop" in targets:
        try:
            from .tools.computer.window_manager import get_active_window
            win = get_active_window()
            if win:
                title = win.get("title", "")
                if title:
                    parts.append(f"active_window: {title[:120]}")
                    if ctx_key is None:
                        ctx_key = title
        except Exception:
            pass

    lesson_block = ""
    if ctx_key:
        try:
            from .brain import memory as _mem
            norm = _mem.normalize_key(ctx_key)
            global _LAST_LESSON_KEY
            if norm != _LAST_LESSON_KEY:
                block = _mem.format_for_prompt(_mem.recall(norm))
                if block:
                    lesson_block = "\n\n" + block
                _LAST_LESSON_KEY = norm
        except Exception:
            lesson_block = ""

    if len(parts) <= 1 and not lesson_block:
        return ""

    snapshot = "\n\n[CONTEXT]\n" + "\n".join(parts) if len(parts) > 1 else ""
    return snapshot + lesson_block


def _trim_messages(messages: list, max_msgs: int = MAX_CONTEXT_MESSAGES):
    if len(messages) <= max_msgs + 1:
        return
    system = messages[0] if messages[0]["role"] == "system" else None
    trimmed = messages[-(max_msgs):]

    def _has_tool_calls(m):
        return bool(m.get("tool_calls")) if isinstance(m, dict) else False

    while trimmed and trimmed[0].get("role") == "tool":
        trimmed.pop(0)

    while trimmed and trimmed[0].get("role") == "assistant" and _has_tool_calls(trimmed[0]):
        if len(trimmed) > 1 and trimmed[1].get("role") == "tool":
            break
        trimmed.pop(0)
        while trimmed and trimmed[0].get("role") == "tool":
            trimmed.pop(0)

    while trimmed and trimmed[-1].get("role") == "assistant" and _has_tool_calls(trimmed[-1]):
        trimmed.pop()

    messages.clear()
    if system:
        messages.append(system)
    messages.extend(trimmed)


def _execute_full_pipeline(
    code: str, desc: str, brain, console, messages: list,
    permission_mode, client, config: dict,
    tool_call_id: str = None,
    assistant_text: str = None,
    source: str = None,
    iteration: int = 0,
):
    """Executes the full pipeline from safety checks through execution and message formatting."""
    is_tool_msg = tool_call_id is not None

    if console:
        if hasattr(console, 'send_code_start'):
            console.send_code_start(code, desc)
        source_tag = f"  [dim]({source})[/dim]" if source else ""
        console.print(f"\n  [cyan]⚡ {desc}[/cyan]{source_tag}")
        _code_lines = code.strip().split("\n")
        for line in _code_lines[:10]:
            console.print(f"    [dim]{line}[/dim]")
        if len(_code_lines) > 10:
            console.print(f"    [dim]... ({len(_code_lines) - 10} more lines)[/dim]")

    code = sanitize_code(code)

    from .gate import gate_code, ALLOW, OVERRIDE
    _decision, _feedback = gate_code(
        code, desc,
        config=config,
        console=console,
        permission_mode=permission_mode,
        client=client,
        check_web=not is_tool_msg,
    )
    if _decision != ALLOW:
        if _decision == OVERRIDE:
            _model_msg = f"[USER OVERRIDE]: {_feedback}\nRewrite your code to follow this instruction instead."
            _ui_msg = f"OVERRIDE: {_feedback}"
        else:
            _model_msg = _feedback
            _ui_msg = _feedback
        if is_tool_msg:
            messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": _model_msg})
        else:
            messages.append({"role": "assistant", "content": assistant_text})
            messages.append({"role": "user", "content": _model_msg})
        if console and hasattr(console, 'send_code_result'):
            console.send_code_result(_ui_msg, False, 0.0)
        return

    code = _inject_verify_marker(code)

    _bm = _get_bucket_mgr()
    if _bm.current and _bm.current.is_active:
        _bm.current.activity = f"Running: {desc[:60]}"

    _exec_start = _time_mod.time()
    result = execute_code(code)
    _exec_duration = _time_mod.time() - _exec_start

    result = _truncate(result)
    is_err = _is_error(result)

    brain.record(code, desc, result, success=not is_err, duration=_exec_duration)

    record = brain.tracker.last_execution
    if record:
        reasons = []

        consecutive_err_count = 0
        for r in reversed(brain.tracker.executions):
            if not r.success:
                consecutive_err_count += 1
            else:
                break
        if consecutive_err_count >= 2:
            reasons.append("consecutive_errors")

        _RECOVERY_EXCEPTIONS = {
            "ImportError", "ModuleNotFoundError", 
            "ConnectionError", "ConnectionRefusedError", "ConnectionResetError", "ConnectionAbortedError",
            "TimeoutError", "URLError", "socket.timeout", "WorkerCrash", "CancelledError", "BrokenPipeError", "EOFError"
        }
        from .tools.execute import get_last_exception_type
        exc_type = get_last_exception_type()
        if exc_type in _RECOVERY_EXCEPTIONS:
            reasons.append("recovery_exception")

        _STRONG_EXPLORATION = {"list_tools(", "describe_tool(", "tool_help("}
        code_for_scan = record.full_code or record.code_snippet
        if any(p in code_for_scan for p in _STRONG_EXPLORATION):
            reasons.append("strong_exploration")

        if reasons:
            record.recovery_needed = True
            record.recovery_reasons = sorted(set(reasons))

    last_exec = brain.tracker.last_execution
    if last_exec and last_exec.is_step:
        bucket_mgr = _get_bucket_mgr()
        if bucket_mgr.current and bucket_mgr.current.is_active:
            verified = (
                "VERIFY:PASS" in result
                or (_VERIFY_OUTPUT_MARKER in result
                    and "PASS" in result.split(_VERIFY_OUTPUT_MARKER, 1)[-1][:200])
            )
            bucket_mgr.current.update_current_step(
                step_name=last_exec.step_name,
                success=not is_err,
                error=result[:120] if is_err else "",
                verified=verified,
            )

    if console:
        progress = f"[dim][{brain.progress}][/dim] " if brain.tracker.has_work_done else ""
        if is_err:
            console.print(f"    [red]✗ Error detected — model will auto-retry[/red] {progress}")
            preview = result[:400].replace("\n", "\n    ")
            console.print(f"    [dim]{preview}[/dim]")
        else:
            console.print(f"    [green]✓[/green] {progress}")
            if "VERIFY:PASS" in result:
                v_idx = result.index("VERIFY:PASS")
                s_preview = result[:v_idx].strip()[:200].replace("\n", "\n    ")
                console.print(f"    [dim]{s_preview}[/dim]")
                console.print(f"    [cyan]🔍 Verify:[/cyan] [green]PASS[/green]")
            elif "VERIFY:FAIL" in result:
                v_idx = result.index("VERIFY:FAIL")
                s_preview = result[:v_idx].strip()[:200].replace("\n", "\n    ")
                reason = result[v_idx:].split("\n")[0].replace("VERIFY:FAIL:", "").strip()
                console.print(f"    [dim]{s_preview}[/dim]")
                console.print(f"    [cyan]🔍 Verify:[/cyan] [red]FAIL: {reason[:100]}[/red]")
            elif "VERIFY:UNKNOWN" in result:
                v_idx = result.index("VERIFY:UNKNOWN")
                s_preview = result[:v_idx].strip()[:200].replace("\n", "\n    ")
                reason = result[v_idx:].split("\n")[0].replace("VERIFY:UNKNOWN:", "").strip()
                console.print(f"    [dim]{s_preview}[/dim]")
                console.print(f"    [cyan]🔍 Verify:[/cyan] [yellow]UNKNOWN: {reason[:100]}[/yellow]")
            elif _VERIFY_OUTPUT_MARKER in result:
                parts = result.split(_VERIFY_OUTPUT_MARKER, 1)
                s_preview = parts[0].strip()[:200].replace("\n", "\n    ")
                v_preview = parts[1].strip()[:200].replace("\n", "\n    ")
                console.print(f"    [dim]{s_preview}[/dim]")
                console.print(f"    [cyan]🔍 Verify:[/cyan] [dim]{v_preview}[/dim]")
            else:
                preview = result[:300].replace("\n", "\n    ")
                console.print(f"    [dim]{preview}[/dim]")
        if hasattr(console, 'send_code_result'):
            console.send_code_result(result, not is_err, _exec_duration)

    ctx = _passive_context_snapshot(code, is_err)

    def _enrich(r: str) -> str:
        """Enriches error output with tool details."""
        fix = (
            f"\n\n[SYSTEM: Code failed. Attempted: {desc}. "
            f"Analyze the error above, fix the root cause, and try a "
            f"DIFFERENT approach. Don't repeat the same mistake.]"
        )
        docs = _get_error_docs(code)
        if docs:
            fix += f"\n\nHere are the CORRECT tool docs — use these:\n{docs}"
        return f"{r}{fix}"

    if is_tool_msg:
        if is_err:
            result = _enrich(result)
        result += ctx
        messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": result})

    elif source == "tool_call_json":
        tc_id = f"local_{iteration}"
        tool_result = _enrich(result) if is_err else result
        tool_result += ctx
        messages.append({
            "role": "assistant", "content": None,
            "tool_calls": [{"id": tc_id, "type": "function",
                            "function": {"name": "execute", "arguments": json.dumps({"code": code})}}]
        })
        messages.append({"role": "tool", "tool_call_id": tc_id, "content": tool_result})

    else:
        messages.append({"role": "assistant", "content": assistant_text})
        if is_err:
            attempt = min(max(brain.tracker.failure_count, 1), MAX_AUTO_RETRIES)
            retry_msg = _make_retry_prompt(code, result, attempt)
            docs = _get_error_docs(code)
            if docs:
                retry_msg += f"\n\nHere are the CORRECT tool docs — use these:\n{docs}"
            messages.append({"role": "user", "content": f"{retry_msg}{ctx}"})
        else:
            messages.append({"role": "user", "content": f"[Sandbox Output]:\n{result}{ctx}"})


def _extract_code(text: str) -> tuple | None:
    """Extracts executable Python code from text response."""
    if not text or len(text) < 10:
        return None
    
    for pattern in [
        r'```python\s*\n([\s\S]*?)\n\s*```',
        r'```py\s*\n([\s\S]*?)\n\s*```',
    ]:
        m = re.search(pattern, text, re.IGNORECASE)
        if m and len(m.group(1).strip()) > 5:
            return (m.group(1).strip(), "Code block", "code_block")
    
    if '"tool_calls"' in text or ('"name"' in text and '"code"' in text):
        result = _parse_tool_call_json(text)
        if result:
            return result
    
    m = re.search(r'```\w*\s*\n([\s\S]*?)\n\s*```', text)
    if m:
        code = m.group(1).strip()
        python_signals = ['import ', 'print(', 'def ', 'from ', 'os.', 'Path(', 'subprocess', 'open(', 'Browser(']
        if any(sig in code for sig in python_signals) and len(code) > 10:
            return (code, "Code block", "code_block")
    
    m = re.search(r'```(?:python|py)\s*\n([\s\S]+)', text, re.IGNORECASE)
    if not m:
        m = re.search(r'```\w+\s*\n([\s\S]+)', text)
    if m:
        code = m.group(1).strip()
        if code.endswith('```'):
            code = code[:-3].strip()
        python_signals = ['import ', 'print(', 'def ', 'from ', 'os.', 'Path(', 'subprocess', 'open(', 'Browser(']
        if any(sig in code for sig in python_signals) and len(code) > 10:
            return (code, "Code block", "code_block")
    
    return None


def _parse_tool_call_json(text: str) -> tuple | None:
    """Extracts code from JSON tool_calls format."""
    
    def _extract_from_data(data):
        if "tool_calls" in data and data["tool_calls"]:
            tc = data["tool_calls"][0]
            fn = tc.get("function", tc)
            args = fn.get("arguments", {})
            if isinstance(args, str):
                try: args = json.loads(args)
                except Exception: pass
            if isinstance(args, dict):
                code = args.get("code", "")
                desc = args.get("description", "Executing...")
                if code and len(code) > 5:
                    return (code, desc, "tool_call_json")
        return None
    
    try:
        result = _extract_from_data(json.loads(text.strip()))
        if result: return result
    except Exception:
        pass
    
    m = re.search(r'```(?:json)?\s*\n?([\s\S]*?)\n?\s*```', text)
    if m:
        try:
            result = _extract_from_data(json.loads(m.group(1).strip()))
            if result: return result
        except Exception:
            pass
    
    for marker in ['{"tool_calls"', '"tool_calls"']:
        idx = text.find(marker)
        if idx < 0:
            continue
        brace = text.rfind('{', 0, idx + 1) if marker[0] != '{' else idx
        if brace < 0:
            continue
        depth = 0
        for i in range(brace, len(text)):
            if text[i] == '{': depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    try:
                        result = _extract_from_data(json.loads(text[brace:i+1]))
                        if result: return result
                    except Exception:
                        pass
                    break
    
    m = re.search(r'"code"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    if m:
        try:
            code = m.group(1)
            code = code.replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"').replace('\\\\', '\\')
            if len(code) > 10 and any(s in code for s in ['import ', 'print(', 'def ', 'from ', 'Browser(']):
                dm = re.search(r'"description"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
                desc = dm.group(1) if dm else "Executing..."
                return (code, desc, "code_field_extract")
        except Exception:
            pass
    
    return None

_session_brain: Brain | None = None
_session_prompt_mgr: PromptManager | None = None
_session_bucket_mgr: BucketManager | None = None
_session_recall = None

_LAST_LESSON_KEY: str | None = None

def _get_brain() -> Brain:
    """Returns the session Brain instance."""
    global _session_brain
    if _session_brain is None:
        _session_brain = Brain()
    return _session_brain

def _get_prompt_mgr() -> PromptManager:
    """Returns the session PromptManager instance."""
    global _session_prompt_mgr
    if _session_prompt_mgr is None:
        _session_prompt_mgr = PromptManager()
    return _session_prompt_mgr

def _get_bucket_mgr() -> BucketManager:
    """Returns the session BucketManager instance."""
    global _session_bucket_mgr
    if _session_bucket_mgr is None:
        _session_bucket_mgr = BucketManager()
    return _session_bucket_mgr

def _get_recall():
    """Returns the session RecallEngine instance."""
    global _session_recall
    if _session_recall is None:
        try:
            from .recall import RecallEngine
            _session_recall = RecallEngine()
        except Exception:
            pass
    return _session_recall


def _is_byok_mode(config: dict) -> bool:
    """Checks if the gateway is in BYOK/API mode."""
    import urllib.request as _url_req

    api_url = config.get("api_url", "http://127.0.0.1:3210/v1")
    base = api_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]

    try:
        req = _url_req.Request(
            f"{base}/v1/byok/enabled",
            headers={"Authorization": f"Bearer {config.get('api_key', '')}"},
        )
        with _url_req.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read())
            return bool(data.get("enabled", False))
    except Exception:
        return False


def _discover_providers(config: dict) -> dict:
    """Discovers available AI providers from the gateway."""
    import urllib.request
    import json as _json

    api_url = config.get("api_url", "http://127.0.0.1:3210/v1")
    api_key = config.get("api_key", "")
    self_model = config.get("model", "auto")

    base = api_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]

    try:
        req = urllib.request.Request(
            f"{base}/api/status",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = _json.loads(resp.read())

        available = data.get("enabledProviders", [])

        if self_model == "auto" and available:
            self_model = available[0]

        if "@" in self_model:
            self_base = self_model.split("@")[0]
        elif ":" in self_model:
            self_base = self_model.split(":")[0]
        else:
            self_base = self_model

        peers = [p for p in available if p != self_base]

        return {
            "available": available,
            "self": self_base,
            "peers": peers,
            "multi_agent_enabled": len(peers) > 0,
        }
    except Exception:
        return {
            "available": [],
            "self": self_model,
            "peers": [],
            "multi_agent_enabled": False,
        }


_session_skill_generated_this_task = False


def _session_post_turn(brain, config: dict, is_byok: bool,
                       user_message: str, outcome: TaskOutcome, client=None) -> None:
    """Runs post-turn hooks for Session Mode."""
    if is_byok:
        return

    if brain and getattr(brain, "_post_turn_ran", False):
        return
    if brain:
        brain._post_turn_ran = True

    global _session_skill_generated_this_task

    try:
        from .prompt.skills import backfill_telemetry, track_failure

        actual_tools = set()
        task_success = outcome.completed
        last_error = ""
        if brain and brain.tracker:
            for rec in brain.tracker.executions:
                snippet = rec.code_snippet.lower()
                if "chromebrowser" in snippet or "browser" in snippet:
                    actual_tools.add("browser")
                if "desktop" in snippet:
                    actual_tools.add("desktop")
                if "read_file" in snippet or "write_file" in snippet:
                    actual_tools.add("file")
                if "subprocess" in snippet or "shell" in snippet:
                    actual_tools.add("shell")
                if "screenshot" in snippet:
                    actual_tools.add("ocr")
                if "repo_intel" in snippet or "find_definition" in snippet:
                    actual_tools.add("repo")
                if "urlopen" in snippet or "http" in snippet:
                    actual_tools.add("network")
                if "grep" in snippet or "lint" in snippet:
                    actual_tools.add("coding")

                if not rec.success:
                    last_error = rec.result[:200] if rec.result else ""

        reflection_triggered = False
        if last_error:
            should_reflect = track_failure(last_error)
            if should_reflect:
                reflection_triggered = True
                _inject_reflection(brain, config, last_error, client)

        backfill_telemetry(
            actual_tools=sorted(actual_tools),
            success=task_success,
            reflection_triggered=reflection_triggered,
        )

        if task_success and actual_tools:
            try:
                from .prompt.dynamic_session_prompt import refine_classification_cache
                refine_classification_cache(user_message, actual_tools)
            except Exception:
                pass

        global _session_prompt_mgr
        if _session_prompt_mgr:
            injected_skills = getattr(_session_prompt_mgr, "_prev_skill_names", [])
            if injected_skills:
                from .prompt.skills import SkillStore
                store = SkillStore()
                try:
                    for name in injected_skills:
                        skill = store.get(name)
                        if skill is None:
                            continue
                        if skill.capabilities and not (set(skill.capabilities) & actual_tools):
                            continue
                        store.record_use(name, success=task_success)
                except Exception as e:
                    import logging
                    logging.getLogger(__name__).warning(
                        "Failed to record skill use: %s", e
                    )
                finally:
                    store.close()

    except Exception:
        pass

    if not _session_skill_generated_this_task:
        try:
            _maybe_generate_skill(brain, config, user_message, outcome.completed, client)
        except Exception:
            pass

_SKILL_SYNTH_TIMEOUT_S = 10.0


def _synthesize_skill(client, config: dict, system_prompt: str,
                      user_prompt: str) -> dict | None:
    """Synthesizes a skill candidate using the LLM client."""
    if client is None:
        return None
    try:
        bounded = client.with_options(
            max_retries=0, timeout=_SKILL_SYNTH_TIMEOUT_S
        )
        resp = bounded.chat.completions.create(
            model=config.get("model", "auto"),
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=300,
            temperature=0.0,
        )
        content = (resp.choices[0].message.content or "").strip()
        if content.startswith("```"):
            content = re.sub(r"^```(?:json)?\s*", "", content)
            content = re.sub(r"\s*```$", "", content)
        parsed = json.loads(content)
        if not isinstance(parsed, dict) or parsed.get("no_skill"):
            return None
        return parsed
    except Exception:
        return None


def _persist_candidate_skill(parsed: dict) -> bool:
    """Deduplicates and persists a candidate skill."""
    global _session_skill_generated_this_task
    if _session_skill_generated_this_task:
        return False
    name = (parsed.get("name") or "").strip()
    if not name:
        return False
    from .prompt.skills import SkillStore
    store = SkillStore()
    try:
        existing = store.fuzzy_name_match(name)
        if existing:
            parsed["name"] = existing.name
        store.save_candidate(parsed)
        _session_skill_generated_this_task = True
        store.purge_stale()
        return True
    except Exception:
        return False
    finally:
        store.close()


def _inject_reflection(brain, config: dict, error_msg: str,
                       client=None) -> None:
    """Generates a candidate skill from repeated failures."""
    exec_summary = ""
    if brain and brain.tracker:
        recent = brain.tracker.executions[-5:]
        parts = []
        for rec in recent:
            status = "OK" if rec.success else "FAIL"
            parts.append(f"[{status}] {rec.code_snippet[:80]}")
            if not rec.success and rec.result:
                parts.append(f"  Error: {rec.result[:100]}")
        exec_summary = "\n".join(parts)

    reflection_prompt = (
        "A task just failed repeatedly with this error:\n"
        f"{error_msg[:300]}\n\n"
        "Recent execution history:\n"
        f"{exec_summary}\n\n"
        "Analyze: What went wrong? What should the agent do differently next time?\n"
        "If you identify a reusable pattern, return JSON:\n"
        '{"name": "...", "trigger": [...], "capabilities": [...], '
        '"guidance": [...], "negative_guidance": [...], '
        '"failure_patterns": [...], "workflow": "..."}\n'
        'Otherwise return: {"no_skill": true, "reason": "..."}\n'
        "Return JSON only."
    )

    parsed = _synthesize_skill(
        client, config,
        "You analyze task execution failures and extract reusable patterns.",
        reflection_prompt,
    )
    if parsed and _persist_candidate_skill(parsed):
        import logging
        logging.getLogger(__name__).info(
            "Reflection generated candidate skill: %s", parsed.get("name", "?")
        )


def _maybe_generate_skill(brain, config: dict, user_message: str,
                          task_goal_achieved: bool, client=None) -> None:
    """Generates candidate skills from successful recovery arcs."""
    if not brain or not brain.tracker:
        return

    executions = brain.tracker.executions
    if not executions:
        return

    if not brain.tracker.had_recovery or not task_goal_achieved:
        return

    exec_lines = []
    for rec in executions[-8:]:
        status = "SUCCESS" if rec.success else "FAIL"
        exec_lines.append(f"[{status}] {rec.description[:60]}")
        if not rec.success and rec.result:
            exec_lines.append(f"  Error: {rec.result[:80]}")
        elif rec.success:
            exec_lines.append(f"  Worked: {rec.code_snippet[:80]}")
    exec_summary = "\n".join(exec_lines)

    skill_gen_prompt = (
        f"Task: {user_message[:200]}\n\n"
        "Execution history (failures then success):\n"
        f"{exec_summary}\n\n"
        "Extract a reusable pattern. Return JSON:\n"
        '{"name": "short_snake_name", "trigger": ["keyword1", "keyword2"], '
        '"capabilities": ["browser"|"desktop"|"coding"|"shell"|"file"|"network"|"ocr"|"repo"], '
        '"guidance": ["what worked (2-3 items)"], '
        '"negative_guidance": ["what to avoid"], '
        '"failure_patterns": ["errors encountered"], '
        '"verification": ["how to verify"], '
        '"workflow": "bug_fix"|"refactor"|"browser_research"|"desktop_automation"|"general"}\n'
        'If nothing reusable, return: {"no_skill": true}\n'
        "Return JSON only."
    )

    parsed = _synthesize_skill(
        client, config,
        "You extract reusable task patterns from execution histories. Be concise.",
        skill_gen_prompt,
    )
    if parsed and _persist_candidate_skill(parsed):
        import logging
        logging.getLogger(__name__).info(
            "Generated candidate skill: %s", parsed.get("name", "?")
        )


def reset_session():
    """Resets all session state."""
    global _session_brain, _session_prompt_mgr, _session_bucket_mgr, _session_recall, _LAST_LESSON_KEY
    global _ACTIVE_API_THREADS, _ABANDONED_THREADS, _TELEMETRY
    global _session_skill_generated_this_task
    _session_skill_generated_this_task = False
    with _ACTIVE_THREADS_LOCK:
        _ACTIVE_API_THREADS.clear()
        _ABANDONED_THREADS.clear()
        _TELEMETRY["api_cancelled_count"] = 0
        _TELEMETRY["abandoned_thread_count"] = 0
        _TELEMETRY["max_concurrent_abandoned"] = 0

    if _session_brain:
        _session_brain.reset()
    if _session_prompt_mgr:
        _session_prompt_mgr.reset()
    if _session_bucket_mgr:
        _session_bucket_mgr.reset()
    if _session_recall:
        try:
            _session_recall.reset()
        except Exception:
            pass
    _session_brain = None
    _session_prompt_mgr = None
    _session_bucket_mgr = None
    _session_recall = None
    _LAST_LESSON_KEY = None
    clear_pending()
    kill_worker()
    try:
        from .tools.system.shell_ops import kill_background_processes
        kill_background_processes()
    except Exception:
        pass

def run_agent_loop(client: OpenAI, config: dict, user_message: str, messages: list, console=None, permission_mode=None, file_path: str = None, conversation_id: str = None):
    """Core agent loop orchestrator."""
    if permission_mode is None:
        permission_mode = PermissionMode.SMART

    brain = _get_brain()
    prompt_mgr = _get_prompt_mgr()
    bucket_mgr = _get_bucket_mgr()

    try:
        import os
        from .tools.coding.repo_intel import get_repo_index
        repo_idx = get_repo_index(os.getcwd())
        if not repo_idx._is_indexing_active:
            import threading
            t = threading.Thread(target=repo_idx.index_workspace, daemon=True)
            t.start()
    except Exception as e:
        import logging
        logging.warning(f"Failed to start background repository indexer: {e}")

    recall = None
    is_byok = _is_byok_mode(config)
    global _session_skill_generated_this_task
    _session_skill_generated_this_task = False
    import os as _os_mod
    _os_mod.environ["PROXIMA_BYOK_MODE"] = "1" if is_byok else "0"
    if is_byok:
        recall = _get_recall()

    if recall and not recall.session_id:
        try:
            recall.start_session(
                model=config.get("model", ""),
                title=user_message[:80],
            )
        except Exception:
            pass

    multi_agent = config.get("multi_agent", False)
    _provider_info = {}

    if multi_agent:
        _provider_info = _discover_providers(config)
        if _provider_info.get("peers"):
            try:
                from .multi_agent import configure_peers as _cfg_peers
                _cfg_peers(
                    api_url=config.get("api_url", "http://127.0.0.1:3210/v1"),
                    api_key=config.get("api_key", ""),
                    available=_provider_info["available"],
                )
            except Exception:
                pass
    else:
        try:
            from .multi_agent import disable_peers as _dis_peers
            _dis_peers()
        except Exception:
            pass

    if multi_agent and _provider_info.get("peers"):
        prompt_mgr._multi_agent = True
        prompt_mgr._provider_info = _provider_info
    else:
        prompt_mgr._multi_agent = False

    prompt_mgr._byok_mode = is_byok

    bucket = bucket_mgr.new_bucket(user_message)

    if not bucket.is_active:
        brain.reset()

    _COMPLEX_SIGNALS = {
        "step", "steps", "first", "then", "after", "plan", "next",
        "multiple", "batch", "all", "each", "every", "setup",
        "finally", "and then", "lastly", "before", "once",
    }
    msg_lower = user_message.lower()
    word_count = len(user_message.split())
    is_complex = (
        len(user_message) > 120
        or word_count > 25
        or any(kw in msg_lower for kw in _COMPLEX_SIGNALS)
    )
    if is_complex:
        bucket.start_planning()
    else:
        bucket.start_ready()

    bucket_context = bucket_mgr.get_context()
    system_prompt = prompt_mgr.get_prompt(bucket_context, user_message=user_message,
                                           config=config)

    if permission_mode == PermissionMode.SUGGEST:
        from .permissions import SUGGEST_PROMPT
        system_prompt += f"\n{SUGGEST_PROMPT}"

    custom_instr = config.get("custom_instructions", "").strip()
    if custom_instr:
        system_prompt = (
            "## USER CUSTOM INSTRUCTIONS (always follow these):\n"
            f"{custom_instr}\n\n{system_prompt}"
        )

    try:
        lesson_block = brain.recall_lessons(ctx_key=user_message)
        if lesson_block:
            system_prompt += f"\n\n{lesson_block}"
    except Exception:
        pass

    if recall:
        try:
            insights_block = recall.get_insights_for_prompt(user_message)
            if insights_block:
                system_prompt += f"\n\n{insights_block}"
        except Exception:
            pass

    if messages and messages[0]["role"] == "system":
        messages[0]["content"] = system_prompt
    else:
        messages.insert(0, {"role": "system", "content": system_prompt})

    enhanced_message = brain.enhance_user_message(user_message)
    messages.append({"role": "user", "content": enhanced_message})

    iteration = 0
    max_iterations = config.get("max_tool_iterations", 50)

    def _is_cancelled():
        return bool(getattr(console, "is_cancelled", False))

    def _cancel_return():
        msg = "Stopped by user."
        if console:
            try:
                console.print(f"[yellow]⏹ {msg}[/yellow]")
            except Exception:
                pass
        outcome = TaskOutcome(completed=False, reason=TaskOutcomeReason.USER_CANCELLED)
        _session_post_turn(brain, config, is_byok, user_message, outcome, client)
        return msg

    max_consecutive_failures = int(config.get("max_consecutive_failures", MAX_AUTO_RETRIES * 2))
    max_api_retries = int(config.get("max_api_retries", 4))

    while iteration < max_iterations:
        iteration += 1

        if recall:
            try:
                recall.flush_new_messages(messages)
                recall.compact_if_needed(messages, client, config)
            except Exception:
                _trim_messages(messages)
        else:
            _trim_messages(messages)

        if multi_agent:
            try:
                from .multi_agent import drain_responses
                _completed = drain_responses()
                for _item in _completed:
                    _prov = _item["provider"]
                    _resp = _item["response"]
                    _elapsed = _item["elapsed"]
                    _status = _item["status"]
                    _inject = (
                        f"[SUB-AGENT {_prov.upper()} — {_status} in {_elapsed}]\n"
                        f"{_resp}"
                    )
                    messages.append({"role": "user", "content": _inject})
                    if console:
                        _icon = "✅" if _status == "completed" else "❌"
                        if hasattr(console, 'send_event'):
                            console.send_event('assistant_message',
                                content=f"{_icon} Sub-agent **{_prov}** delivered results ({_elapsed})")
                        else:
                            console.print(
                                f"  [cyan]{_icon} Sub-agent {_prov} "
                                f"delivered results ({_elapsed})[/cyan]"
                            )
            except Exception:
                pass

        if _is_cancelled():
            return _cancel_return()

        if brain.tracker.consecutive_failures >= max_consecutive_failures:
            stuck_msg = (
                f"Stopped after {brain.tracker.consecutive_failures} consecutive "
                f"failed attempts — the current approach isn't working. "
                f"Last error context is in the conversation above."
            )
            if console:
                console.print(f"[red]⛔ {stuck_msg}[/red]")
            outcome = TaskOutcome(completed=False, reason=TaskOutcomeReason.EXECUTION_FAILED)
            _session_post_turn(brain, config, is_byok, user_message, outcome, client)
            return stuck_msg

        turn_attachment = consume_pending()

        from .error_classifier import classify_api_error, ErrorKind
        from .retry_utils import jittered_backoff

        response = None
        api_attempt = 0
        while True:
            if _is_cancelled():
                return _cancel_return()
            try:
                if console and hasattr(console, 'send_event'):
                    console.send_event('thinking')

                extra_body = {}
                effective_file = turn_attachment or file_path
                if effective_file:
                    extra_body["filePath"] = effective_file
                if conversation_id:
                    extra_body["conversationId"] = conversation_id

                current_timeout = 45.0 if api_attempt == 0 else 20.0
                response, cancelled = _call_api_with_cancellation(
                    client,
                    console,
                    model=config.get("model", "auto"),
                    messages=messages,
                    tools=ALL_TOOLS,
                    temperature=config.get("temperature", 0.7),
                    extra_body=extra_body if extra_body else None,
                    timeout=current_timeout,
                )

                if cancelled:
                    return _cancel_return()

                if response is None:
                    raise TimeoutError("API call timed out or returned empty response.")

                if config.get("debug") and console and hasattr(console, 'send_event'):
                    try:
                        _dbg_req = {
                            "model": config.get("model", "auto"),
                            "messages_count": len(messages),
                            "temperature": config.get("temperature", 0.7),
                            "last_user_msg": (messages[-1].get("content", "") or "")[:200] if messages else "",
                        }
                        _dbg_resp = {
                            "finish_reason": response.choices[0].finish_reason if response.choices else None,
                            "content_preview": (response.choices[0].message.content or "")[:300] if response.choices and response.choices[0].message.content else "",
                            "tool_calls": len(response.choices[0].message.tool_calls or []) if response.choices and response.choices[0].message.tool_calls else 0,
                        }
                        console.send_event("debug_log", request=_dbg_req, response=_dbg_resp)
                    except Exception:
                        pass

                break

            except Exception as e:
                decision = classify_api_error(e)

                if not decision.retryable:
                    error_msg = f"API Error [{decision.kind.value}]: {e}\n{decision.hint}"
                    if console:
                        console.print(f"[red]{error_msg}[/red]")
                    outcome = TaskOutcome(completed=False, reason=TaskOutcomeReason.EXECUTION_FAILED)
                    _session_post_turn(brain, config, is_byok, user_message, outcome, client)
                    return error_msg

                api_attempt += 1

                if decision.kind == ErrorKind.EMPTY_RESPONSE:
                    effective_cap = min(max_api_retries, 1)
                else:
                    effective_cap = max_api_retries

                if api_attempt > effective_cap:
                    error_msg = (
                        f"API Error [{decision.kind.value}] after {api_attempt - 1} "
                        f"retr{'y' if api_attempt - 1 == 1 else 'ies'}: {e}"
                    )
                    if console:
                        console.print(f"[red]{error_msg}[/red]")
                    outcome = TaskOutcome(completed=False, reason=TaskOutcomeReason.EXECUTION_FAILED)
                    _session_post_turn(brain, config, is_byok, user_message, outcome, client)
                    return error_msg

                if decision.should_trim:
                    _trim_messages(messages, max_msgs=max(6, MAX_CONTEXT_MESSAGES // 2))

                base = 6.0 if decision.kind == ErrorKind.RATE_LIMIT else 2.0
                delay = jittered_backoff(api_attempt, base_delay=base)
                if console:
                    console.print(
                        f"[yellow]{decision.hint} "
                        f"(attempt {api_attempt}/{effective_cap}, retrying in {delay:.1f}s)[/yellow]"
                    )
                _waited = 0.0
                while _waited < delay:
                    if _is_cancelled():
                        return _cancel_return()
                    _step = min(0.25, delay - _waited)
                    _time_mod.sleep(_step)
                    _waited += _step

        choice = response.choices[0]
        msg = choice.message
        assistant_text = msg.content or ""

        if _is_cancelled():
            return _cancel_return()

        if permission_mode == PermissionMode.SUGGEST and assistant_text and console:
            from .permissions import detect_suggest_block, handle_suggest_ui
            suggest = detect_suggest_block(assistant_text)
            if suggest:
                if suggest["text_before"]:
                    display = _strip_markdown(suggest["text_before"])
                    console.print("[bold cyan]Proxima Agent:[/bold cyan]")
                    console.print(display)

                user_choice = handle_suggest_ui(suggest, console)

                messages.append({"role": "assistant", "content": assistant_text})
                if user_choice:
                    messages.append({"role": "user", "content": f"User chose: {user_choice}\nProceed with this approach now."})
                else:
                    messages.append({"role": "user", "content": "User skipped. Proceed with your best judgment."})
                continue

        if msg.tool_calls:
            if msg.content:
                brain.try_parse_plan(msg.content, task=user_message)
                if console:
                    if hasattr(console, 'send_event'):
                        console.send_event('assistant_message', content=msg.content)
                    else:
                        display_text = _strip_markdown(msg.content)
                        console.print("[bold cyan]Proxima Agent:[/bold cyan]")
                        console.print(display_text)

            messages.append({
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        }
                    }
                    for tc in msg.tool_calls
                ]
            })

            for tc in msg.tool_calls:
                tool_name = getattr(tc.function, "name", "") or ""
                if tool_name != "execute":
                    error_msg = (
                        f"[SYSTEM: Tool '{tool_name}' does not exist. "
                        f"The only available tool is 'execute' which runs Python code. "
                        f"Use execute() with ChromeBrowser, http_get, or other Python tools instead.]"
                    )
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": error_msg,
                    })
                    if console:
                        console.print(f"  [red]✗ Unknown tool '{tool_name}' — rejected[/red]")
                        if hasattr(console, 'send_code_result'):
                            console.send_code_result(error_msg, False, 0.0)
                    continue

                try:
                    args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    args = {}

                code = args.get("code", "")
                desc = args.get("description", "Executing code...")

                if not code or not code.strip():
                    empty_msg = "[SYSTEM: Empty code received. Nothing to execute. Write actual Python code.]"
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": empty_msg,
                    })
                    if console:
                        console.print(f"  [yellow]⚠ Empty code — skipped[/yellow]")
                        if hasattr(console, 'send_code_result'):
                            console.send_code_result(empty_msg, False, 0.0)
                    continue

                _execute_full_pipeline(
                    code, desc, brain, console, messages,
                    permission_mode, client, config,
                    tool_call_id=tc.id,
                )

            continue

        assistant_text = msg.content or ""

        extracted = _extract_code(assistant_text)

        if extracted:
            code, desc, source = extracted

            _execute_full_pipeline(
                code, desc, brain, console, messages,
                permission_mode, client, config,
                assistant_text=assistant_text, source=source, iteration=iteration,
            )

            continue

        if brain.should_verify() and brain.tracker.has_work_done and bucket.is_active:
            v_result = brain.process_verification(
                _latest_verify_result(brain.tracker.executions)
            )
            status = v_result.get("status", "NONE")

            if v_result["verified"]:
                bucket.mark_done("Verified (proof-based)")
                if console:
                    console.print(
                        f"  [green]✅ Task verified — proof: PASS[/green]"
                    )
            elif status == "FAIL":
                reason = v_result.get("reason", "")[:80]
                if console:
                    console.print(
                        f"  [red]❌ Verification FAILED: {reason}[/red]"
                    )
                bucket.mark_failed(f"Verification failed: {reason}")
            elif status == "UNKNOWN":
                if console:
                    console.print(
                        f"  [yellow]⚠ Verification: UNKNOWN — cannot independently verify[/yellow]"
                    )

        if brain.is_verified and bucket.is_active:
            bucket.mark_done("Verified by Brain")
            if console:
                console.print(f"  [green]Bucket DONE: {bucket.task[:50]}[/green]")

        if bucket.is_complete and recall:
            try:
                recall.extract_insights_from_conversation(
                    messages, client, config
                )
            except Exception:
                pass

        brain.try_parse_plan(assistant_text, task=user_message)

        if console:
            if hasattr(console, 'send_event'):
                console.send_event('assistant_message', content=assistant_text)
            else:
                title = "Proxima Agent"
                if brain.tracker.has_work_done:
                    title += f" [{brain.progress}]"
                if brain.is_verified:
                    title += " ✅"
                display_text = _strip_markdown(assistant_text)
                console.print(f"[bold cyan]{title}:[/bold cyan]")
                console.print(display_text)

        completed = True
        reason = TaskOutcomeReason.COMPLETED

        if brain.tracker.executions:
            signal = _latest_outcome_signal(brain.tracker.executions)

            if bucket.status == BucketStatus.FAILED or signal == "FAIL":
                completed = False
                reason = TaskOutcomeReason.VERIFICATION_FAILED
            elif signal == "GAVE_UP":
                completed = False
                reason = TaskOutcomeReason.GAVE_UP
            else:
                last_exec = brain.tracker.last_execution
                if last_exec and not last_exec.success:
                    completed = False
                    reason = TaskOutcomeReason.EXECUTION_FAILED
                        
        outcome = TaskOutcome(completed=completed, reason=reason)
        messages.append({"role": "assistant", "content": assistant_text})

        _session_post_turn(brain, config, is_byok, user_message, outcome, client)

        return assistant_text

    outcome = TaskOutcome(completed=False, reason=TaskOutcomeReason.MAX_ITERATIONS)
    _session_post_turn(brain, config, is_byok, user_message, outcome, client)

    return "ERROR: Max tool iterations reached."
