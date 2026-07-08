"""Proxima — Dynamic Execution Engine.
Executes Python code in a persistent environment with safety checking and recovery fallback.
"""
import subprocess
import os
import re
import sys
import json
import tempfile
import platform
import threading

DANGEROUS_PATTERNS = [
    (r'\.unlink\s*\(', 'File deletion (.unlink)'),
    (r'\.rmtree\s*\(', 'Recursive folder deletion (.rmtree)'),
    (r'\bos\.remove\s*\(', 'File deletion (os.remove)'),
    (r'\bos\.rmdir\s*\(', 'Directory deletion (os.rmdir)'),
    (r'\bos\.removedirs\s*\(', 'Recursive directory deletion (os.removedirs)'),
    (r'\bshutil\.rmtree\s*\(', 'Recursive folder deletion (shutil.rmtree)'),
    (r'\bshutil\.move\s*\(', 'File/folder move (shutil.move)'),
    (r'\bsend2trash\b', 'Send to trash'),
    (r'\brm\s+(-[rRf]|--recursive|--force)', 'Shell: recursive/force delete'),
    (r'\brmdir\b', 'Shell: directory removal'),
    (r'\bdel\s+[/\\]', 'Shell: Windows delete'),
    (r'\bRemove-Item\b', 'PowerShell: Remove-Item'),
    (r'\b[Ff]ormat[\s-]([Vv]olume|[a-zA-Z]:)', 'Disk formatting'),
    (r'\b(mkfs|fdisk|parted|diskpart)\b', 'Disk partitioning'),
    (r'\b(shutdown|restart|reboot)\s', 'System shutdown/restart'),
    (r'\bStop-Computer\b', 'PowerShell: shutdown'),
    (r'\bRestart-Computer\b', 'PowerShell: restart'),
    (r'\b(reg\s+(add|delete)|regedit)\b', 'Registry modification'),
    (r'\bNew-ItemProperty\b.*HKLM', 'Registry write (PowerShell)'),
    (r'\bchmod\s+[0-7]{3,4}\b', 'Permission change'),
    (r'\bicacls\b.*\bgrant\b', 'Windows permission change'),
    (r'\bpip\s+uninstall\b', 'Package uninstall'),
    (r'\bnpm\s+(uninstall|remove)\b', 'Package uninstall'),
    (r'\bgit\s+push\s+.*--force', 'Git force push'),
    (r'\bgit\s+(reset\s+--hard|clean\s+-[fd])', 'Git destructive reset/clean'),
    (r'\bgit\s+branch\s+-[dD]\b', 'Git branch delete'),
    (r'\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b', 'Database drop'),
    (r'\bTRUNCATE\s+TABLE\b', 'Database truncate'),
    (r'\bDELETE\s+FROM\b', 'Database delete rows'),
    (r'\b(iptables|netsh\s+advfirewall|ufw)\b', 'Firewall modification'),
    (r'\b(taskkill|Stop-Process)\b', 'Kill process'),
    (r'\bkill\s*\(', 'Kill process (Python)'),
    (r'\bos\.kill\s*\(', 'Kill process (os.kill)'),
    (r'\bsetx\b', 'System environment variable change'),
    (r'\b\[Environment\]::SetEnvironmentVariable\b', 'System env var (PowerShell)'),
    (r'(?:open|write_file|write_file_raw|edit_file|write_text|write_bytes|writelines|Path)\s*\(\s*[\'"](?:/etc/|/usr/|/boot/|/sys/|/System/|C:[\\/]+Windows[\\/]|C:[\\/]+Program Files)', 'Writing system files'),
    (r'\b(ssh-keygen|gpg\s+--delete)\b', 'SSH/GPG key operation'),
]


def check_safety(code: str, config: dict = None) -> list:
    """Checks code for dangerous operations using blocked patterns."""
    warnings = []
    for pattern, desc in DANGEROUS_PATTERNS:
        if re.search(pattern, code, re.IGNORECASE):
            warnings.append(desc)
    if config:
        for user_pattern in config.get("blocked_patterns", []):
            user_pattern = user_pattern.strip()
            if user_pattern and user_pattern in code:
                warnings.append(f"Blocked pattern: {user_pattern}")
    return list(set(warnings))


def check_web_misuse(code: str) -> str | None:
    """Checks for raw keyboard or mouse simulation misuse in browser tasks."""
    has_keyboard_tool = any(k in code for k in ['pyautogui', 'pyperclip', 'keyboard'])
    
    web_signals = [
        '.com', 'http', 'browser', 'chrome', 'firefox', 'tab', 'address bar',
        'url', 'website', 'page', 'reddit', 'google', 'youtube', 'gmail',
    ]
    has_web = any(wp in code.lower() for wp in web_signals)
    
    has_typing = any(k in code for k in [
        'typewrite', 'pyautogui.write(', 'hotkey', 'pyperclip.copy', 'pyperclip.paste',
        "press('enter')", "press('tab')",
    ])
    
    if has_keyboard_tool and (has_web or has_typing):
        return (
            "⚠ Raw keyboard simulation detected — this sends keystrokes to the TERMINAL, not the browser!\n"
            "  Use ChromeBrowser instead — it controls Chrome via CDP protocol:\n"
            "  from proxima_agent.tools.browser_cdp import ChromeBrowser\n"
            "  b = ChromeBrowser()\n"
            "  b.goto('url')  b.write_text('field', 'value')  b.click_text('button')  b.type_text('text')"
        )
    return None


def sanitize_code(code: str) -> str:
    """Sanitizes code by fixing URLs and swapping webbrowser modules."""
    code = re.sub(
        r"""(['"])\(+(https?://[^)'"]+?)\)+\1""",
        r'\1\2\1',
        code
    )
    code = re.sub(
        r"""(['"])\[.*?\]\((https?://[^)]+)\)\1""",
        r'\1\2\1',
        code
    )
    
    if 'webbrowser' in code and 'webbrowser.open' in code:
        def _swap_webbrowser(mo):
            raw = mo.group(1)
            raw = re.sub(r'^\(+', '', raw)
            raw = re.sub(r'\)+$', '', raw)
            return f"b.goto({json.dumps(raw)})"

        new_code = re.sub(
            r"webbrowser\.open\s*\(\s*['\"]([^'\"]+)['\"]\s*\)",
            _swap_webbrowser,
            code,
        )
        if new_code != code:
            prelude = ""
            if 'ChromeBrowser' not in code:
                prelude += "from proxima_agent.tools.browser_cdp import ChromeBrowser\n"
            if not re.search(r'^\s*b\s*=', code, re.MULTILINE):
                prelude += "b = ChromeBrowser()\n"
            new_code = re.sub(r'^\s*import\s+webbrowser\s*$', '', new_code, flags=re.MULTILINE)
            new_code = re.sub(r'^\s*from\s+webbrowser\s+import[^\n]*$', '', new_code, flags=re.MULTILINE)
            code = prelude + new_code
    
    if 'from proxima_agent.tools.browser import Browser' in code:
        code = code.replace(
            'from proxima_agent.tools.browser import Browser',
            'from proxima_agent.tools.browser_cdp import ChromeBrowser'
        )
        code = code.replace('Browser()', 'ChromeBrowser()')

    return code


EXECUTE_SCHEMA = {
    "type": "function",
    "function": {
        "name": "execute",
        "description": (
            "Execute Python code on the local machine. Full access: files, shell, "
            "browser (ChromeBrowser), desktop apps (Desktop), screenshots, network. "
            "Output captured from stdout via print(). System asks user approval for "
            "dangerous operations automatically."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "Python code to execute. Must be complete and runnable."
                },
                "description": {
                    "type": "string",
                    "description": "Brief description of what this code does (shown to user)"
                },
            },
            "required": ["code"]
        }
    }
}

MAX_OUTPUT = 15000


def _max_output() -> int:
    """Resolves output character limit from config."""
    try:
        from .. import config
        return config.get_limit("max_exec_output_chars", MAX_OUTPUT)
    except Exception:
        return MAX_OUTPUT


def _agent_tmp_dir() -> str:
    """Returns a writable directory for temporary execution files."""
    d = os.path.join(os.path.expanduser("~"), ".proxima-agent", "exec")
    try:
        os.makedirs(d, exist_ok=True)
        return d
    except Exception:
        return tempfile.gettempdir()


def _safe_cwd() -> str:
    """Resolves the safe working directory for code execution."""
    try:
        from .. import config
        ws = config.get_workspace_dir()
        if os.path.isdir(ws):
            return ws
    except Exception:
        pass
    try:
        cwd = os.getcwd()
        if os.path.isdir(cwd):
            return cwd
    except Exception:
        pass
    return os.path.expanduser("~")


def _truncate_output(output: str) -> str:
    """Truncates output to length limit."""
    _cap = _max_output()
    if len(output) > _cap:
        half = _cap // 2
        output = (
            output[:half]
            + f"\n\n... [truncated {len(output) - _cap} chars] ...\n\n"
            + output[-half:]
        )
    return output


def _format_result(stdout: str, stderr: str, success: bool) -> str:
    """Formats stdout and stderr outputs into execution result string."""
    parts = []
    if stdout.strip():
        parts.append(stdout.strip())
    if stderr.strip():
        parts.append(f"[stderr]\n{stderr.strip()}")
    output = "\n".join(parts) if parts else "(no output)"
    output = _truncate_output(output)
    status = "✓" if success else "✗ exit=1"
    return f"[{status}]\n{output}"


_STATE_LOST_BANNER = (
    "[SYSTEM: Execution environment was restarted. "
    "All previous variables/imports have been cleared. "
    "Re-initialize anything you need (e.g. b = ChromeBrowser()).]"
)


def _inject_state_banner(result: str, banner: str) -> str:
    """Injects state loss restart warning banner into execution result."""
    if not banner:
        return result
    head, sep, rest = result.partition("\n")
    if sep:
        return f"{head}\n{banner}\n{rest}"
    return f"{result}\n{banner}"


class _PersistentWorker:
    """Manages a long-lived worker process for persistent executions."""

    def __init__(self):
        self._proc: subprocess.Popen | None = None
        self._cmd_id: int = 0
        self._lock = threading.Lock()
        self._state_lost: bool = False
        self._last_exception_type: str | None = None

    def get_last_exception_type(self) -> str | None:
        """Gets exception type of the last code execution."""
        return self._last_exception_type

    @property
    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _start(self):
        """Starts worker process."""
        self._cleanup()

        worker_script = os.path.join(os.path.dirname(__file__), "_exec_worker.py")
        py = sys.executable or ("python" if platform.system() == "Windows" else "python3")

        self._proc = subprocess.Popen(
            [py, "-u", worker_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={
                **os.environ,
                "PYTHONIOENCODING": "utf-8",
                "PROXIMA_EXEC_CWD": _safe_cwd(),
            },
        )
        self._cmd_id = 0

        import queue
        self._out_queue = queue.Queue()

        out_queue = self._out_queue
        worker_proc = self._proc

        def _reader():
            try:
                while True:
                    line = worker_proc.stdout.readline()
                    if not line:
                        out_queue.put(None)
                        break
                    out_queue.put(line.strip())
            except Exception:
                out_queue.put(None)
        self._reader_thread = threading.Thread(target=_reader, daemon=True)
        self._reader_thread.start()

        def _drain_stderr():
            try:
                while True:
                    line = worker_proc.stderr.readline()
                    if not line:
                        break
            except Exception:
                pass
        self._stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _cleanup(self):
        """Kills active worker process."""
        if self._proc:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
            try:
                self._proc.kill()
                self._proc.wait(timeout=5)
            except Exception:
                pass
            self._proc = None

    def kill(self):
        """Kills the active execution worker."""
        with self._lock:
            self._cleanup()
            self._state_lost = False

    def execute(self, code: str) -> str:
        """Executes code block inside the persistent worker."""
        with self._lock:
            return self._execute_locked(code)

    def _execute_locked(self, code: str) -> str:
        """Runs execution flow on the persistent worker."""
        was_previously_alive = self._proc is not None
        if not self.is_alive:
            self._start()
            if was_previously_alive:
                self._state_lost = True

        banner = ""
        if self._state_lost:
            banner = _STATE_LOST_BANNER
            self._state_lost = False

        self._cmd_id += 1
        cmd = {"id": self._cmd_id, "code": code}

        try:
            self._proc.stdin.write(json.dumps(cmd) + "\n")
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError):
            self._state_lost = True
            self._cleanup()
            self._last_exception_type = "WorkerCrash"
            return _inject_state_banner(self._fallback_execute(code), banner)

        import queue
        import time as _time
        try:
            from .. import config
            exec_timeout = float(config.get_limit("max_exec_seconds", 300))
        except Exception:
            exec_timeout = 300.0
        deadline = _time.monotonic() + exec_timeout

        while True:
            remaining = deadline - _time.monotonic()
            if remaining <= 0:
                self._cleanup()
                self._state_lost = True
                self._last_exception_type = "TimeoutError"
                return _inject_state_banner(
                    "[✗ exit=1]\n"
                    f"ERROR: Code execution timed out after {exec_timeout:.0f} seconds.\n"
                    "The execution worker has been restarted, clearing all previous variables/imports.",
                    banner,
                )

            try:
                result_line = self._out_queue.get(timeout=remaining)
            except queue.Empty:
                continue

            if result_line is None:
                self._cleanup()
                self._state_lost = True
                self._last_exception_type = "WorkerCrash"
                self._start()
                return _inject_state_banner(self._fallback_execute(code), banner)

            try:
                r = json.loads(result_line)
            except (json.JSONDecodeError, ValueError):
                self._cleanup()
                self._state_lost = True
                self._last_exception_type = "WorkerCrash"
                return _inject_state_banner(self._fallback_execute(code), banner)

            if r.get("ready"):
                continue

            self._last_exception_type = r.get("exception_type")
            result = _format_result(
                r.get("stdout", ""),
                r.get("stderr", ""),
                r.get("success", False),
            )
            return _inject_state_banner(result, banner)

    def _fallback_execute(self, code: str) -> str:
        """Executes code block in one-shot fallback subprocess."""
        py = sys.executable or ("python" if platform.system() == "Windows" else "python3")
        hook_bootstrap = (
            "exec(\"try:\\n from proxima_agent.tools._exec_worker import "
            "bootstrap_runtime as _pxb; _pxb(globals())\\nexcept Exception: pass\")\n"
        )
        run_cwd = _safe_cwd()
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8",
            dir=_agent_tmp_dir()
        ) as f:
            f.write(hook_bootstrap + code)
            tmp = f.name

        try:
            result = subprocess.run(
                [py, tmp],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=run_cwd,
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                timeout=float(os.environ.get("PROXIMA_FALLBACK_EXEC_TIMEOUT", "300")),
            )
            if result.returncode != 0:
                stderr_str = result.stderr or ""
                last_line = ""
                for line in reversed(stderr_str.split("\n")):
                    if line.strip():
                        last_line = line.strip()
                        break
                match = re.search(r"\b([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Exit|Interrupt|timeout))\b", last_line)
                self._last_exception_type = match.group(1) if match else "FallbackError"
            else:
                self._last_exception_type = None

            return _format_result(
                result.stdout or "",
                result.stderr or "",
                result.returncode == 0,
            )
        except subprocess.TimeoutExpired:
            self._last_exception_type = "TimeoutError"
            return (
                "[✗ exit=1]\n"
                "ERROR: Code execution timed out. "
                "The one-shot fallback process was killed."
            )
        except Exception as e:
            self._last_exception_type = type(e).__name__
            return f"ERROR: {type(e).__name__}: {e}"
        finally:
            try:
                os.unlink(tmp)
            except Exception:
                pass


_worker = _PersistentWorker()


def execute_code(code: str) -> str:
    """Executes code block using persistent worker with fallback."""
    return _worker.execute(code)


def get_last_exception_type() -> str | None:
    """Gets exception type of the last code execution."""
    return _worker.get_last_exception_type()


def kill_worker():
    """Kills the active execution worker."""
    _worker.kill()
