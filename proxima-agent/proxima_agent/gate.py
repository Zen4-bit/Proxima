"""Proxima — Safety Gate.
Audits agent-authored code against safety warnings, web misuse rules, and permission boundaries.
"""

from typing import Tuple

ALLOW = "allow"
BLOCK = "block"
OVERRIDE = "override"


def gate_code(
    code: str,
    desc: str = "",
    *,
    config: dict,
    console=None,
    permission_mode=None,
    client=None,
    check_web: bool = True,
) -> Tuple[str, str]:
    """Audits model-authored code for safety, web misuse, and permissions."""
    from .tools.execute import check_web_misuse, check_safety
    from .permissions import check_permission

    if check_web and config.get("web_misuse_check", True):
        web_warn = check_web_misuse(code)
        if web_warn:
            return (BLOCK, f"{web_warn}\nRewrite your code using ChromeBrowser.")

    warnings = check_safety(code, config) if config.get("safety_checks", True) else []
    if warnings:
        if not _approve_warnings(warnings, desc, code, console):
            if console is None:
                return (BLOCK, "BLOCKED: dangerous operation requires approval "
                               "but no console is available.")
            return (BLOCK, "BLOCKED: User denied execution of dangerous operation.")

    if permission_mode is not None:
        approved, alt_instruction = check_permission(
            permission_mode, code, desc, console, client=client, config=config
        )
        if not approved:
            return (BLOCK, "BLOCKED: Action denied by permission system.")
        if alt_instruction:
            return (OVERRIDE, alt_instruction)

    return (ALLOW, "")


def _approve_warnings(warnings: list, desc: str, code: str, console) -> bool:
    """Prompts the user to approve flagged code execution."""
    if console is None:
        return False

    if hasattr(console, "request_approval"):
        try:
            approved = bool(console.request_approval(
                action=desc or "Execute code with safety warnings",
                code=code[:500],
                reasons=[f"⚠️ {w}" for w in warnings],
            ))
        except Exception:
            approved = False
        console.print("  [green]✓ Approved[/green]" if approved else "  [red]✗ Blocked by user[/red]")
        return approved

    try:
        console.print()
        console.print("  [bold red]⚠️  SAFETY WARNING[/bold red]")
        for w in warnings:
            console.print(f"    [red]• {w}[/red]")
        console.print()
        answer = console.input("  [bold yellow]Approve execution? (y/n): [/bold yellow]").strip().lower()
    except (KeyboardInterrupt, EOFError):
        answer = "n"
    approved = answer in ("y", "yes")
    console.print("  [green]✓ Approved[/green]" if approved else "  [red]✗ Blocked by user[/red]")
    return approved
