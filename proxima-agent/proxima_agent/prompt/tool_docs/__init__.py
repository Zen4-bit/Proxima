"""Proxima — Tool Docs Dispatcher.
Provides on-demand documentation and usage details for active tools and environments.
"""

from .browser import BROWSER_TOPICS
from .desktop import DESKTOP_TOPICS
from .shell import SHELL_TOPICS
from .file_ops import FILE_TOPICS
from .screen import SCREEN_TOPICS
from .repo_intel import REPO_INTEL_TOPICS


_ALL_TOPICS = {
    "browser": BROWSER_TOPICS,
    "desktop": DESKTOP_TOPICS,
    "shell": SHELL_TOPICS,
    "file": FILE_TOPICS,
    "screen": SCREEN_TOPICS,
    "repo_intel": REPO_INTEL_TOPICS,
}

_ENV_ALIASES = {
    "chrome": "browser", "chromebrowser": "browser", "browser_cdp": "browser",
    "web": "browser", "webpage": "browser", "website": "browser",
    "gmail": "browser", "youtube": "browser", "google": "browser",
    "internet": "browser", "cdp": "browser", "tab": "browser",
    "app": "desktop", "application": "desktop", "window": "desktop",
    "ui": "desktop", "gui": "desktop", "notepad": "desktop",
    "pywinauto": "desktop", "uiautomation": "desktop", "accessibility": "desktop",
    "atspi": "desktop", "applescript": "desktop", "xdotool": "desktop",
    "terminal": "shell", "cmd": "shell", "command": "shell",
    "powershell": "shell", "bash": "shell", "subprocess": "shell",
    "system": "shell", "run": "shell", "exec": "shell",
    "pip": "shell", "npm": "shell", "install": "shell",
    "files": "file", "folder": "file", "directory": "file",
    "path": "file", "read": "file", "write": "file",
    "filesystem": "file", "disk": "file", "io": "file",
    "upload": "file", "send_file": "file", "attach": "file",
    "ocr": "screen", "screenshot": "screen", "capture": "screen",
    "vision": "screen", "text_recognition": "screen", "image": "screen",
    "ui_elements": "screen", "elements": "screen",
    "repo_intel": "repo_intel", "repo": "repo_intel", "repository": "repo_intel",
    "intelligence": "repo_intel", "code_intelligence": "repo_intel", "repointel": "repo_intel",
}

_TOPIC_ALIASES = {
    "browser": {
        "open": "navigate", "goto": "navigate", "url": "navigate", "visit": "navigate",
        "go": "navigate", "load": "navigate", "page": "navigate",
        "type": "fill", "input": "fill", "enter": "fill", "typing": "fill", "write": "fill",
        "press": "keys", "hotkey": "keys", "keyboard": "keys", "shortcut": "keys",
        "button": "click", "link": "click", "tap_element": "click",
        "content": "read", "get_text": "read", "page_text": "read", "dom": "read",
        "js": "javascript", "eval": "javascript", "script": "javascript",
        "capture": "screenshot", "snap": "screenshot", "image": "screenshot",
        "new_tab": "tabs", "switch_tab": "tabs", "close_tab": "tabs",
        "down": "scroll", "up": "scroll", "swipe": "scroll",
        "check": "state", "where": "state", "current": "state", "url_check": "state",
        "init": "setup", "start": "setup", "launch": "setup", "connect": "setup",
    },
    "desktop": {
        "launch": "connect", "open": "connect", "attach": "connect", "start": "connect",
        "type": "fill", "input": "fill", "typing": "fill", "write": "fill", "enter": "fill",
        "button": "click", "press_button": "click", "tap": "click",
        "keyboard": "keys", "shortcut": "keys", "hotkey": "keys", "press": "keys",
        "get_text": "text", "read": "text", "content": "text",
        "list": "elements", "controls": "elements", "find": "elements",
        "dom": "tree", "structure": "tree", "hierarchy": "tree",
        "dropdown": "select", "combo": "select", "option": "select",
        "checkbox": "check", "toggle": "check", "tick": "check",
        "nav": "menu", "menubar": "menu", "file_menu": "menu",
        "capture": "screenshot", "snap": "screenshot", "image": "screenshot",
        "activate": "focus", "bring_front": "focus", "foreground": "focus",
        "exit": "close", "quit": "close", "terminate": "close",
        "list_windows": "windows", "all_windows": "windows",
        "init": "setup", "import": "setup",
    },
    "shell": {
        "execute": "run", "cmd": "run", "command": "run", "terminal": "run",
        "bg": "background", "daemon": "background", "async": "background",
        "os_shell": "native", "platform": "native", "system_shell": "native",
        "ps": "powershell", "pwsh": "powershell", "windows_shell": "powershell",
        "process": "subprocess", "popen": "subprocess", "call": "subprocess",
        "pip": "install", "npm_install": "install", "apt": "install", "brew": "install",
        "env": "environment", "var": "environment", "path": "environment", "setenv": "environment",
    },
    "file": {
        "open": "read", "load": "read", "get": "read", "cat": "read",
        "save": "write", "create": "write", "output": "write", "put": "write",
        "add": "append", "log": "append",
        "ls": "list", "dir": "list", "browse": "list", "contents": "list",
        "find": "search", "grep": "search", "locate": "search", "pattern": "search",
        "check": "exists", "is_file": "exists", "is_dir": "exists",
        "cp": "copy_move", "mv": "copy_move", "rename": "copy_move", "copy": "copy_move", "move": "copy_move",
        "rm": "delete", "remove": "delete", "unlink": "delete",
        "pathlib": "path", "resolve": "path", "basename": "path", "dirname": "path",
        "upload": "attach", "send_file": "attach", "feed": "attach", "show_file": "attach",
    },
    "screen": {
        "focused": "active_window", "foreground": "active_window", "current_window": "active_window",
        "controls": "ui_elements", "widgets": "ui_elements", "buttons": "ui_elements",
        "search": "find_element", "locate": "find_element", "find_button": "find_element",
        "windows": "list_windows", "all_windows": "list_windows", "open_windows": "list_windows",
        "full_screen": "ocr_screen", "read_all": "ocr_screen", "capture_text": "ocr_screen",
        "area": "ocr_region", "crop": "ocr_region", "region": "ocr_region", "partial": "ocr_region",
        "from_file": "ocr_image", "image_text": "ocr_image", "photo": "ocr_image",
        "search_text": "find_text", "where_is": "find_text", "locate_text": "find_text",
        "tap_text": "click_text", "click_by_text": "click_text", "press_text": "click_text",
    },
    "repo_intel": {
        "status": "status_health", "health": "status_health", "stats": "status_health", "integrity": "status_health",
        "analyze": "status_health", "project": "status_health",
        "definition": "navigation", "references": "navigation", "callers": "navigation", "implementations": "navigation",
        "find": "navigation", "subclass": "navigation",
        "rename": "rename", "refactor": "rename", "move_symbol": "rename",
        "compress": "context_compress", "compress_context": "context_compress", "tokens": "context_compress", "scoring": "context_compress",
        "repair": "repair", "repair_loop": "repair", "checkpoint": "repair", "rollback": "repair",
    },
}


def _edit_distance(a: str, b: str) -> int:
    """Computes Levenshtein edit distance between two strings."""
    if len(a) < len(b):
        return _edit_distance(b, a)
    if len(b) == 0:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            cost = 0 if ca == cb else 1
            curr.append(min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost))
        prev = curr
    return prev[len(b)]


def _closest_match(query: str, candidates: list, max_distance: int = 2) -> str | None:
    """Finds closest string match by edit distance."""
    best = None
    best_dist = max_distance + 1
    for candidate in candidates:
        dist = _edit_distance(query, candidate)
        if dist < best_dist:
            best_dist = dist
            best = candidate
    return best if best_dist <= max_distance else None


def fetch_help(environment: str, topic: str = None) -> str:
    """Retrieves help documentation for specific environment and topic."""
    env_lower = environment.lower().strip()

    topics = _ALL_TOPICS.get(env_lower)
    resolved_env = env_lower

    if not topics:
        canonical = _ENV_ALIASES.get(env_lower)
        if canonical:
            topics = _ALL_TOPICS[canonical]
            resolved_env = canonical

    if not topics:
        all_names = list(_ALL_TOPICS.keys()) + list(_ENV_ALIASES.keys())
        closest = _closest_match(env_lower, all_names)
        if closest:
            canonical = _ENV_ALIASES.get(closest, closest)
            if canonical in _ALL_TOPICS:
                topics = _ALL_TOPICS[canonical]
                resolved_env = canonical

    if not topics:
        available = ", ".join(_ALL_TOPICS.keys())
        common_aliases = "chrome/web → browser, app/window → desktop, cmd/terminal → shell"
        return (
            f"Environment '{environment}' not found.\n"
            f"Available: {available}\n"
            f"Aliases: {common_aliases}"
        )

    if not topic:
        topic_list = ", ".join(topics.keys())
        return (
            f"[{resolved_env}] Available topics: {topic_list}\n"
            f"Call: fetch_help('{resolved_env}', 'topic_name')\n"
            f"Call: fetch_help('{resolved_env}', 'all') for complete guide"
        )

    topic_lower = topic.lower().strip()

    if topic_lower in ("all", "full", "everything", "complete", "guide", "docs", "help"):
        lines = [f"=== {resolved_env.upper()} — Complete Reference ===\n"]
        for name, content in topics.items():
            lines.append(f"── {name} ──")
            lines.append(content)
            lines.append("")
        return "\n".join(lines)

    if topic_lower in topics:
        return topics[topic_lower]

    env_aliases = _TOPIC_ALIASES.get(resolved_env, {})
    canonical_topic = env_aliases.get(topic_lower)
    if canonical_topic and canonical_topic in topics:
        return topics[canonical_topic]

    for key, value in topics.items():
        if topic_lower in key or key in topic_lower:
            return value

    all_topic_names = list(topics.keys()) + list(env_aliases.keys())
    closest_topic = _closest_match(topic_lower, all_topic_names)
    if closest_topic:
        resolved_topic = env_aliases.get(closest_topic, closest_topic)
        if resolved_topic in topics:
            return topics[resolved_topic]

    topic_list = ", ".join(topics.keys())
    return f"Topic '{topic}' not found in {resolved_env}. Available: {topic_list}"


def list_environments() -> str:
    """Lists available help environments."""
    lines = ["Available help environments:"]
    for env, topics in _ALL_TOPICS.items():
        lines.append(f"  {env}: {len(topics)} topics ({', '.join(list(topics.keys())[:5])}...)")
    lines.append("\nUsage: fetch_help('environment', 'topic')")
    lines.append("\nCommon aliases: chrome/web → browser, app/window → desktop, cmd/terminal → shell")
    return "\n".join(lines)
