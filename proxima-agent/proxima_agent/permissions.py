"""Proxima — Permission System.
Manages agent autonomy levels (Full Auto, Smart, Suggest) and evaluates code risk scores.
"""

from enum import Enum
from typing import Optional
import re


class PermissionMode(Enum):
    FULL_AUTO = "full_auto"
    SMART = "smart"
    SUGGEST = "suggest"


_CRITICAL_PATTERNS = {
    "delete": 3, "remove": 3, "rmtree": 3, "unlink": 3,
    "drop table": 3, "shutil.rmtree": 3,
    "os.remove": 3, "send_keys": 3, "payment": 3,
    "purchase": 3, "checkout": 3, "transfer": 3,
    ".delete(": 3, "rm -rf": 3, "del /": 3,
    "rmdir /s": 3, "del /q": 3, "remove-item": 3,
    "format-volume": 3, "diskpart": 3, "mkfs": 3,
    "os.system": 3, "exec(": 3, "eval(": 3, "shell=true": 3,
    "send": 2, "submit": 2, "post(": 2, "mailto": 2,
    "install": 2, "pip install": 2,
    "registry": 2, "regedit": 2, "taskkill": 2,
    "shutdown": 2, "restart": 2, "subprocess.run": 2,
    "save": 1, "download": 1, "download(": 1,
    "goto": 1, "navigate": 1, "login": 1, "password": 1,
}

_CRITICAL_THRESHOLD = 3
_WORDLIKE_RE = re.compile(r'^[a-z ]+$')

_COMPILED_WORD_PATTERNS = {
    p: re.compile(r'\b' + re.escape(p) + r'\b')
    for p in _CRITICAL_PATTERNS
    if _WORDLIKE_RE.match(p)
}


def _pattern_matches(pattern: str, text: str) -> bool:
    """Returns True if the pattern matches the text."""
    rx = _COMPILED_WORD_PATTERNS.get(pattern)
    if rx is not None:
        return rx.search(text) is not None
    return pattern in text


def is_critical_action(code: str, description: str = "") -> tuple[bool, list[str]]:
    """Checks if code or action description requires smart-mode authorization."""
    text = f"{code}\n{description}".lower()
    total_weight = 0
    reasons = []

    for pattern, weight in _CRITICAL_PATTERNS.items():
        if _pattern_matches(pattern, text):
            total_weight += weight
            reasons.append(f"{pattern} (risk={weight})")

    return (total_weight >= _CRITICAL_THRESHOLD, reasons)


SUGGEST_PROMPT = """
SUGGEST MODE ACTIVE — You are a collaborative guide, not just an executor.

BEFORE taking any of these actions, you MUST output a [SUGGEST] block:
- File moves, copies, deletes, renames (bulk or individual)
- Installing packages or changing system configuration
- Sending messages, emails, or making API calls
- Browser form submissions or purchases
- Any action where the wrong choice could cause data loss
- When you're confused about what the user wants
- When you think the user might be making a mistake
- When there's a better approach than what was asked
- When you need more information to do it right

FORMAT — output this in your text response (NOT in code):
[SUGGEST]
context: <1-line summary of what you're about to do and why you're asking>
1. <option 1 — the most direct approach>
2. <option 2 — a safer or alternative approach>
3. <option 3 — a different strategy or clarification>
[/SUGGEST]

RULES:
- Options must be specific and actionable, not generic
- After user picks, execute that exact approach — no second-guessing
- If user types custom text, follow their instruction precisely
- If action is trivial (printing, reading, listing), just do it — no suggest needed
- You decide dynamically when to suggest — use good judgment
"""

_SUGGEST_PATTERN = re.compile(
    r'\[SUGGEST\]\s*\n'
    r'([\s\S]*?)'
    r'\[/SUGGEST\]',
    re.DOTALL
)

_OPTION_LINE = re.compile(r'^\s*(\d+)\.\s*(.+)', re.MULTILINE)


def detect_suggest_block(text: str) -> Optional[dict]:
    """Parses a [SUGGEST] block from text."""
    match = _SUGGEST_PATTERN.search(text)
    if not match:
        return None

    inner = match.group(1)

    context = ""
    context_match = re.search(r'context:\s*(.+)', inner)
    if context_match:
        context = context_match.group(1).strip()

    options = []
    for opt_match in _OPTION_LINE.finditer(inner):
        opt_text = opt_match.group(2).strip().strip('"').strip()
        if opt_text:
            options.append(opt_text)

    if len(options) < 2:
        return None

    return {
        "context": context,
        "options": options,
        "full_match": match.group(0),
        "text_before": text[:match.start()].strip(),
        "text_after": text[match.end():].strip(),
    }


def handle_suggest_ui(suggest: dict, console) -> Optional[str]:
    """Presents suggest options to user and returns chosen instruction."""
    if hasattr(console, "request_suggest"):
        try:
            choice = console.request_suggest(suggest.get("context", ""), suggest.get("options", []))
        except Exception:
            return None
        choice = (choice or "").strip()
        return choice or None

    console.print()
    console.print(f"  [bold cyan]💡 SUGGEST MODE[/bold cyan]")
    if suggest["context"]:
        console.print(f"  [dim]{suggest['context']}[/dim]")
    console.print()

    options = suggest["options"]
    num_opts = len(options)
    custom_num = num_opts + 1
    skip_num = num_opts + 2

    for i, opt in enumerate(options, 1):
        console.print(f"    [green]{i}.[/green] {opt}")
    console.print(f"    [green]{custom_num}.[/green] [dim]Type your own instruction...[/dim]")
    console.print(f"    [red]{skip_num}.[/red] [dim]Skip — let agent decide[/dim]")
    console.print()

    try:
        choice = console.input(f"  [bold]Your choice (1-{skip_num}): [/bold]").strip()
    except (KeyboardInterrupt, EOFError):
        choice = str(skip_num)

    try:
        choice_int = int(choice)
    except ValueError:
        choice_int = skip_num

    if 1 <= choice_int <= num_opts:
        console.print(f"  [green]✓ Option {choice_int} selected[/green]")
        return options[choice_int - 1]
    elif choice_int == custom_num:
        try:
            custom = console.input("  [bold]Your instruction: [/bold]").strip()
        except (KeyboardInterrupt, EOFError):
            custom = ""
        if custom:
            console.print(f"  [green]✓ Custom instruction[/green]")
            return custom
        console.print(f"  [dim]Empty — agent will decide[/dim]")
        return None
    else:
        console.print(f"  [dim]Skipped — agent will proceed with its best judgment[/dim]")
        return None


def check_permission(
    mode: PermissionMode,
    code: str,
    description: str,
    console,
    client=None,
    config: dict = None,
) -> tuple[bool, Optional[str]]:
    """Checks permissions before code execution."""
    if mode == PermissionMode.FULL_AUTO:
        return (True, None)

    if mode == PermissionMode.SUGGEST:
        return (True, None)

    critical, reasons = is_critical_action(code, description)
    if not critical:
        return (True, None)

    if hasattr(console, "request_approval"):
        try:
            approved = console.request_approval(
                action=description[:200],
                code=code[:500],
                reasons=[r for r in reasons[:5]],
            )
        except Exception:
            approved = False
        if approved:
            return (True, None)
        else:
            return (False, None)

    console.print()
    console.print(f"  [bold yellow]⚡ SMART MODE — Critical Action Detected[/bold yellow]")
    console.print(f"  [dim]Action: {description[:100]}[/dim]")
    for r in reasons[:3]:
        console.print(f"    [yellow]• {r}[/yellow]")
    console.print()

    try:
        answer = console.input("  [bold]Allow? (y/n): [/bold]").strip().lower()
    except (KeyboardInterrupt, EOFError):
        answer = "n"

    if answer in ("y", "yes"):
        console.print("  [green]✓ Approved[/green]")
        return (True, None)
    else:
        console.print("  [red]✗ Blocked[/red]")
        return (False, None)


def select_mode(console) -> PermissionMode:
    """Shows mode selection UI at startup and returns chosen mode."""
    console.print()
    console.print("  [bold]Select Permission Mode:[/bold]")
    console.print()
    console.print("    [green]1. Full Auto[/green]  — Agent does everything. Zero interruptions.")
    console.print("    [yellow]2. Smart[/yellow]      — Pauses on critical actions for your approval.")
    console.print("    [cyan]3. Suggest[/cyan]    — Agent guides you with options before big actions.")
    console.print()

    try:
        choice = console.input("  [bold]Mode (1/2/3) [Default 2]: [/bold]").strip()
    except (KeyboardInterrupt, EOFError):
        choice = "2"

    if choice == "1":
        mode = PermissionMode.FULL_AUTO
        console.print(f"  [green]🚀 FULL AUTO — agent runs freely[/green]")
    elif choice == "3":
        mode = PermissionMode.SUGGEST
        console.print(f"  [cyan]💡 SUGGEST mode — agent guides you with options[/cyan]")
    else:
        mode = PermissionMode.SMART
        console.print(f"  [yellow]⚡ SMART mode — critical actions need approval[/yellow]")

    console.print()
    return mode
