"""Proxima — Multi-Agent Light System Prompt.
Generates compact ongoing system prompts for subsequent turns in multi-agent mode.
"""
from ..prompt.principles import INTERACTION_PRINCIPLES_COMPACT
from ..prompt.light_prompt import _detect_relevant_tools, _TOOL_HINTS, _is_task_message


def build_multi_light_prompt(bucket_context: str = "",
                             user_message: str = "",
                             provider_info: dict = None) -> str:
    """Builds the multi-agent ongoing system prompt."""
    parts = []
    info = provider_info or {}
    peers = info.get("peers", [])

    peer_list = ", ".join(peers) if peers else "none"
    parts.append(
        f"MODE: Multi-AI Orchestrator | Peers: {peer_list}\n"
        "You coordinate peer AIs + execute local code. "
        "Peers are workers — they think and reply. ONLY YOU can run code/access files."
    )

    parts.append(
        "PEERS: from proxima_agent.multi_agent import peers\n"
        "  TEXT: peers.<name>('msg') → sync (wait) | peers.send('<name>','msg') → async (auto-inject)\n"
        "  DELEGATE: peers.delegate('<name>', task='...', context={...}) → sub-agent with tools, returns summary\n"
        "  peers.available → list | peers.reset('<name>') → fresh conversation\n"
        "  YOU decide: text for quick Q&A, delegate for big tasks with tool access."
    )

    parts.append(
        "LOCAL TOOLS: execute(code) | browser_cdp (ChromeBrowser) | desktop (Desktop) | "
        "shell | file_ops | attach(path) | screenshot()\n"
        "STATE: Python environment is PERSISTENT. Reuse objects across turns."
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
        "natively. Screenshots auto-attach. Small/partial content → read_file/grep instead."
    )

    parts.append(INTERACTION_PRINCIPLES_COMPACT)

    parts.append(
        "HELP: from proxima_agent.prompt.tool_docs import fetch_help; "
        "print(fetch_help('browser'|'desktop'|'shell'|'file'|'screen', 'all')) — "
        "Tool docs inject automatically when code fails."
    )

    if bucket_context:
        parts.append(f"CONTEXT:\n{bucket_context}")

    parts.append(
        "RULES: print() for output | NOT every message is a task — if the user is "
        "just chatting, reply in plain text, do NOT run code | "
        "delegate to peers when it helps, execute code yourself | "
        "aggregate peer results before delivering final output | "
        "only report success you confirmed | on failure, diagnose then try a DIFFERENT approach"
    )

    return "\n\n".join(parts)
