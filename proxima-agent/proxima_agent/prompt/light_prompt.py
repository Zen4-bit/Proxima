"""Proxima — Light Prompt.
Generates compact system prompts for subsequent turns in solo mode.
"""
from .principles import INTERACTION_PRINCIPLES_COMPACT

_TOOL_KEYWORDS = {
    "browser": {
        "browser", "website", "web", "open", "go to", "goto", "url",
        "chrome", "page", "search", "login", "gmail", "youtube", "google",
        "click", "navigate", "download", "link", "tab", "scroll",
        "form", "fill", "submit", "sign in", "sign up",
    },
    "desktop": {
        "notepad", "app", "window", "desktop", "application", "click button",
        "menu", "file manager", "calculator", "word", "excel", "paint",
        "ui", "interface", "type in", "dialog", "settings",
    },
    "file": {
        "file", "folder", "create", "write", "read", "save", "path",
        "directory", "copy", "move", "rename", "delete", "csv", "json",
        "txt", "pdf", "edit", "content",
    },
    "shell": {
        "command", "terminal", "run", "install", "pip", "npm",
        "subprocess", "powershell", "cmd", "script", "process",
        "git", "compile", "build",
    },
    "screen": {
        "screenshot", "screen", "capture", "see", "look", "ocr",
        "what's on", "show me", "visual",
    },
    "repo_intel": {
        "definition", "references", "callers", "implementations", "rename",
        "symbol", "subclass", "compress", "context", "repair", "rollback",
        "diagnostics", "status", "health", "analysis",
    },
}

_TOOL_HINTS = {
    "browser": (
        "BROWSER QUICK-REF: b = ChromeBrowser() | b.goto(url) | "
        "b.elements() → STRING (not list) | b.write_text('field', val) → one field | "
        "b.click_text('text') | b.read_content() → clean markdown | "
        "b.extract_records() → list of dicts | b.screenshot() | "
        "b.dump_interactive_elements() → JSON string of visible interactive elements (0 vision tokens) | "
        "b.tabs() → STRING | b.type_text/press/hotkey → needs focus, don't use for form fields"
    ),
    "desktop": (
        "DESKTOP QUICK-REF: d = Desktop() | d.windows() → list | "
        "d.connect('App') FIRST | d.elements() → grouped by role | "
        "d.write_text('field', val) → returns char count + verification | "
        "d.click('Button') | d.click_menu('File -> Save') | d.screenshot()"
    ),
    "file": (
        "FILE QUICK-REF: read_file('x.py') → line-numbered | "
        "read_file_raw('x.json') → exact bytes | write_file('out.txt', data) | "
        "grep('pattern', '.') | find_files('*.py', '.') | "
        "workspace('result.txt') → agent workspace path"
    ),
    "shell": (
        "SHELL QUICK-REF: subprocess.run([cmd], capture_output=True, text=True) | "
        "shell('command') from code_env | For long-running: subprocess.Popen()"
    ),
    "screen": (
        "SCREEN QUICK-REF: screenshot() → whole screen (no setup) | "
        "b.screenshot() → browser page | d.screenshot() → connected window | "
        "All auto-attach to model's next message"
    ),
    "repo_intel": (
        "REPO INTEL QUICK-REF: find_definition('symbol') | find_references('symbol') | "
        "find_callers('symbol') | find_implementations('Class') | "
        "rename_symbol('old', 'new', dry_run=False) | compress_context(['main.py']) | "
        "autonomous_repair_loop('file.py', 'inst', 'test_cmd')"
    ),
}


def _detect_relevant_tools(user_msg: str, bucket_ctx: str = "") -> set:
    """Detects relevant tool categories from message and context."""
    combined = f"{user_msg} {bucket_ctx}".lower()
    relevant = set()
    for category, keywords in _TOOL_KEYWORDS.items():
        if any(kw in combined for kw in keywords):
            relevant.add(category)
    return relevant


_NON_TASK_PATTERNS = {
    "thanks", "thank you", "ok", "okay", "yes", "no", "sure", "got it",
    "continue", "go ahead", "proceed", "next", "done", "good", "great",
    "nice", "cool", "perfect", "haan", "ha", "nahi", "theek hai", "sahi",
    "aage badho", "aur", "acha", "hmm", "fine", "alright", "yep", "nope",
}


def _is_task_message(msg: str) -> bool:
    """Returns True if user message contains an actual task instruction."""
    stripped = msg.strip().lower().rstrip("!.?")
    if stripped in _NON_TASK_PATTERNS:
        return False
    words = stripped.split()
    if len(words) <= 3 and all(w in _NON_TASK_PATTERNS for w in words):
        return False
    return True


def build_light_prompt(bucket_context: str = "",
                       user_message: str = "") -> str:
    """Builds the lightweight ongoing system prompt."""
    parts = []

    parts.append(
        "TOOLS: execute(code) | browser_cdp (ChromeBrowser) | desktop (Desktop) | "
        "shell | file_ops | ocr | repo_intel | attach(path[,note]) | screenshot()\n"
        "STATE: Python environment is PERSISTENT — variables/imports survive across execute() calls. "
        "Import tools before first use (e.g. from proxima_agent.tools.browser_cdp import ChromeBrowser). "
        "Imports persist — write them once, reuse freely across turns."
    )

    relevant_tools = _detect_relevant_tools(user_message, bucket_context)
    if relevant_tools:
        hints = [_TOOL_HINTS[t] for t in relevant_tools if t in _TOOL_HINTS]
        if hints:
            parts.append("\n".join(hints))

        predictive_lines = []

        try:
            from proxima_agent.tools.health import tools_health
            for tool_cat in relevant_tools:
                health = tools_health(tool_cat)
                status = health.get("status", "unknown")
                if status != "ready":
                    detail = ""
                    if "branch" in health:
                        detail = f" branch={health['branch']}"
                    elif "port" in health:
                        detail = f" port={health['port']}"
                    elif "engines" in health:
                        detail = f" engines={health['engines']}"
                    predictive_lines.append(
                        f"HEALTH[{tool_cat}]: {status}{detail}"
                    )
        except Exception:
            pass

        if user_message and _is_task_message(user_message):
            try:
                from proxima_agent.recall.strategies import strategies
                matches = strategies.find(user_message, top_k=2)
                for m in matches:
                    rate = m.get("success_rate", 0)
                    if rate >= 0.7:
                        predictive_lines.append(
                            f"Proven pattern ({rate:.0%}): {m['trigger']}"
                        )
            except Exception:
                pass

        if predictive_lines:
            parts.append("\n".join(predictive_lines))

    parts.append(
        "VISION/FILES: attach('file', note='...') sends a WHOLE file for the model to read "
        "natively (big code/PDF/sheet/image) — goes with your NEXT message, once. Screenshots "
        "auto-attach (just take one, you'll see it next turn). Small/partial content → "
        "read_file/grep into the prompt instead."
    )

    parts.append(INTERACTION_PRINCIPLES_COMPACT)

    parts.append(
        "HELP: from proxima_agent.prompt.tool_docs import fetch_help; "
        "print(fetch_help('browser'|'desktop'|'shell'|'file'|'screen', 'all')) — "
        "pass a REAL topic name (not the word 'tool'); call if you need an API "
        "reference or hit errors. Tool docs inject automatically when code fails."
    )

    if bucket_context:
        parts.append(f"CONTEXT:\n{bucket_context}")

    parts.append(
        "RULES: print() for output | NOT every message is a task — if the user is "
        "just chatting, greeting, or asking your opinion, reply in plain text and do "
        "NOT run code | continue from current state, never restart from scratch | "
        "on failure, diagnose then try a DIFFERENT approach | "
        "one field = one targeted write_text (never Tab between fields) | "
        "before clicking/filling, confirm the EXACT target with b.elements()/d.elements() "
        "(vague text picks the wrong element) — prefer specific labels ('Send email' not 'Send') | "
        "for large/multi-line or special-character text, ONE write_text(field, text) call handles it "
        "(it pastes losslessly) — never type it character-by-character | "
        "after any click/fill, verify the REAL end-state changed (value present, URL/UI changed) — "
        "a returned '[OK]' is NOT proof the right thing happened"
    )

    return "\n\n".join(parts)
