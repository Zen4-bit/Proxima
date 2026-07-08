"""Proxima — Context Compactor.
Manages context window size via light tail trimming and LLM-based summarization with session rollover.
"""
from __future__ import annotations

import re
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .vault import ConversationVault

_SOFT_THRESHOLD = 30
_HARD_THRESHOLD = 50
_PROTECTED_TAIL = 8
_TOOL_OUTPUT_MAX = 500


def maybe_compact(
    messages: list[dict],
    vault: Optional["ConversationVault"],
    session_id: Optional[str],
    client,
    config: dict,
) -> Optional[str]:
    """Applies context compaction or trimming depending on message counts."""
    soft = int(config.get("compaction_threshold", _SOFT_THRESHOLD))
    hard = int(config.get("compaction_hard_threshold", _HARD_THRESHOLD))
    msg_count = len(messages)

    if msg_count <= soft + 1:
        return None

    if msg_count > hard and vault and session_id and client:
        new_sid = _full_compact(messages, vault, session_id, client, config)
        if new_sid:
            return new_sid

    _light_trim(messages, soft)
    return None


def _light_trim(messages: list[dict], max_msgs: int = _SOFT_THRESHOLD) -> None:
    """Performs fast tail-trimming and repairs tool pairs."""
    if len(messages) <= max_msgs + 1:
        return

    system = (
        messages[0]
        if messages and messages[0].get("role") == "system"
        else None
    )
    trimmed = messages[-max_msgs:]

    _repair_tool_pairs(trimmed)

    messages.clear()
    if system:
        messages.append(system)
    messages.extend(trimmed)


def _full_compact(
    messages: list[dict],
    vault: "ConversationVault",
    session_id: str,
    client,
    config: dict,
) -> Optional[str]:
    """Slices context window, requests LLM summary, and rolls session over."""
    system = (
        messages[0]
        if messages and messages[0].get("role") == "system"
        else None
    )
    body = messages[1:] if system else messages[:]

    if len(body) <= _PROTECTED_TAIL + 2:
        return None

    tail = body[-_PROTECTED_TAIL:]
    middle = body[: -_PROTECTED_TAIL]

    pruned_middle = [dict(m) for m in middle]
    _prune_tool_results(pruned_middle)

    summary = _summarize_window(pruned_middle, client, config)
    if not summary:
        return None

    new_sid = vault.rollover_session(
        session_id, model=config.get("model", "")
    )
    if not new_sid:
        return None

    _repair_tool_pairs(tail)

    messages.clear()
    if system:
        messages.append(system)

    messages.append({
        "role": "user",
        "content": f"[CONTEXT FROM PREVIOUS TURNS]\n{summary}",
    })
    messages.append({
        "role": "assistant",
        "content": (
            "Understood. I have the full context from previous turns. "
            "Continuing from where we left off."
        ),
    })
    messages.extend(tail)

    if new_sid:
        vault.append_messages_batch(new_sid, messages)

    return new_sid


def _prune_tool_results(messages: list[dict]) -> None:
    """Prunes verbose tool output content to a single-line summary."""
    for msg in messages:
        if msg.get("role") != "tool":
            continue
        content = msg.get("content", "")
        if not content or len(content) <= _TOOL_OUTPUT_MAX:
            continue

        lines = content.split("\n")
        line_count = len(lines)

        exit_match = re.search(
            r"exit[_ ]?code[:\s]*(\d+)", content, re.IGNORECASE
        )
        exit_info = f", exit {exit_match.group(1)}" if exit_match else ""

        _err_signals = ("Traceback", "Error:", "FAIL", "error:", "Exception")
        status = "error" if any(s in content for s in _err_signals) else "ok"

        first_meaningful = ""
        for line in lines[:5]:
            stripped = line.strip()
            if stripped and not stripped.startswith(("[", "{")):
                first_meaningful = stripped[:100]
                break

        msg["content"] = (
            f"[output: {line_count} lines, {status}{exit_info}]"
            + (f"\n{first_meaningful}" if first_meaningful else "")
        )


def _summarize_window(
    messages: list[dict], client, config: dict
) -> Optional[str]:
    """Generates conversation summary via LLM completion."""
    parts: list[str] = []
    for msg in messages:
        role = msg.get("role", "?")
        content = msg.get("content", "")
        if not content:
            if msg.get("tool_calls"):
                content = "[tool calls]"
            else:
                continue
        snippet = content[:300] if len(content) > 300 else content
        parts.append(f"{role}: {snippet}")

    if not parts:
        return None

    transcript = "\n".join(parts)

    try:
        response = client.chat.completions.create(
            model=config.get("model", "auto"),
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Summarize this conversation segment in 5-10 concise bullet points.\n"
                        "Focus on: what was accomplished, what failed, decisions made, "
                        "current state of the task.\n"
                        "Be factual and specific. No filler.\n\n"
                        f"{transcript}"
                    ),
                }
            ],
            temperature=0.2,
            max_tokens=500,
            timeout=float(config.get("compaction_timeout", 30)),
        )
        text = (response.choices[0].message.content or "").strip()
        return text if text else None
    except Exception:
        return None


def _repair_tool_pairs(messages: list[dict]) -> None:
    """Repairs orphaned tool calls and responses in trimmed messages."""

    def _has_tc(m: dict) -> bool:
        return bool(m.get("tool_calls")) if isinstance(m, dict) else False

    while messages and messages[0].get("role") == "tool":
        messages.pop(0)

    while (
        messages
        and messages[0].get("role") == "assistant"
        and _has_tc(messages[0])
    ):
        if len(messages) > 1 and messages[1].get("role") == "tool":
            break
        messages.pop(0)
        while messages and messages[0].get("role") == "tool":
            messages.pop(0)

    while (
        messages
        and messages[-1].get("role") == "assistant"
        and _has_tc(messages[-1])
    ):
        messages.pop()
