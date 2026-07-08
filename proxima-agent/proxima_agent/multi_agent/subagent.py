"""Proxima — Sub-Agent Runner.
Orchestrates the lightweight tool-enabled loop for sub-agents executing delegated tasks.
"""

import json
import time as _time_mod
import platform


def _build_subagent_prompt(task: str, context: dict) -> str:
    """Builds system prompt for a delegated sub-agent."""
    os_name = "Windows PC" if platform.system() == "Windows" else platform.system()

    context_block = ""
    if context:
        context_lines = []
        for k, v in context.items():
            if isinstance(v, str) and len(v) > 2000:
                context_lines.append(f"  {k}: {v[:2000]}... (truncated)")
            else:
                context_lines.append(f"  {k}: {v}")
        context_block = (
            "\n\nTASK CONTEXT (provided by admin agent):\n"
            + "\n".join(context_lines)
        )

    return (
        f"You are a task worker executing a specific assignment on a {os_name}.\n"
        f"You have FULL access to this machine: files, browser, desktop apps, shell.\n\n"

        f"YOUR TASK:\n{task}\n"
        f"{context_block}\n\n"

        "RULES:\n"
        "  - Complete the task fully. Do not ask questions — figure it out.\n"
        "  - You have the execute() tool to run Python code on this machine.\n"
        "  - Inside execute(), you can use:\n"
        "    • from proxima_agent.tools.browser_cdp import ChromeBrowser (browser)\n"
        "    • from proxima_agent.tools.desktop import Desktop (desktop apps)\n"
        "    • from proxima_agent.tools.code_env import * (file ops, shell, grep)\n"
        "    • Any Python stdlib (os, subprocess, json, etc.)\n"
        "  - Save files directly to the specified paths — do NOT return file contents.\n"
        "  - When done, give a SHORT summary of what you did (files created, actions taken).\n"
        "  - Do NOT return the full content of files you created — just report what was done.\n\n"

        "Output is captured from stdout via print().\n"
        "Always use print() so output is captured.\n\n"

        "HOW TO USE TOOLS:\n"
        "Respond with ONLY this exact JSON format when calling a tool:\n"
        '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"execute","arguments":{"code":"...","description":"..."}}}]}\n\n'

        "COMPLETION:\n"
        "  When the task is FULLY DONE, respond with a plain text summary.\n"
        "  Start your final response with 'TASK COMPLETE:' followed by what you did.\n"
        "  Keep it SHORT — the admin agent only needs to know what was accomplished.\n"
    )


MAX_SUBAGENT_ITERATIONS = 30
MAX_SUBAGENT_OUTPUT_CHARS = 8000
_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "execute",
        "description": (
            "Execute Python code on the local machine. Full access: files, shell, "
            "browser (ChromeBrowser), desktop apps (Desktop), screenshots, network. "
            "Output captured from stdout via print()."
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
                    "description": "Brief description of what this code does"
                },
            },
            "required": ["code"]
        }
    }
}


def _extract_code_simple(text: str) -> tuple | None:
    """Extracts code from model response."""
    import re

    try:
        parsed = json.loads(text.strip())
        if isinstance(parsed, dict) and "tool_calls" in parsed:
            tc = parsed["tool_calls"][0]
            args = tc.get("function", {}).get("arguments", {})
            if isinstance(args, str):
                args = json.loads(args)
            code = args.get("code", "")
            desc = args.get("description", "Executing...")
            if code:
                return code, desc
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        pass

    pattern = r'```(?:python)?\s*\n(.*?)```'
    matches = re.findall(pattern, text, re.DOTALL)
    if matches:
        code = matches[0].strip()
        if code:
            return code, "Executing code block"

    return None


def _trim_subagent_messages(messages: list) -> list:
    """Trims sub-agent conversation history and repairs tool pairs."""
    if len(messages) <= 40:
        return messages
    from ..recall.compactor import _repair_tool_pairs
    head = messages[:2]
    tail = messages[-30:]
    _repair_tool_pairs(tail)
    return head + tail


def run_subagent(
    model: str,
    task: str,
    context: dict | None = None,
    max_iterations: int = MAX_SUBAGENT_ITERATIONS,
    on_progress: callable = None,
) -> dict:
    """Runs the local sub-agent tool-execution loop."""
    from ..config import load_config
    from ..tools.execute import execute_code, sanitize_code
    from ..gate import gate_code, ALLOW

    config = load_config()
    context = context or {}

    from openai import OpenAI
    api_url = config.get("api_url", "http://127.0.0.1:3210/v1")
    api_key = config.get("api_key", "")

    client = OpenAI(base_url=api_url, api_key=api_key)

    system_prompt = _build_subagent_prompt(task, context)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"Begin the task now. Task: {task}"},
    ]

    started = _time_mod.time()
    iteration = 0
    last_text = ""
    consecutive_failures = 0

    while iteration < max_iterations:
        iteration += 1

        if on_progress:
            on_progress(iteration, f"Sub-agent {model} working...")

        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=[_TOOL_SCHEMA],
                temperature=0.7,
            )
        except Exception as e:
            from ..error_classifier import classify_api_error, ErrorKind
            decision = classify_api_error(e)

            if not decision.retryable:
                return {
                    "status": "failed",
                    "summary": (
                        f"Sub-agent API error [{decision.kind.value}]: {e}\n"
                        f"{decision.hint}"
                    ),
                    "iterations": iteration,
                    "elapsed": _time_mod.time() - started,
                }

            if decision.kind == ErrorKind.RATE_LIMIT:
                return {
                    "status": "failed",
                    "summary": (
                        f"Sub-agent stopped: {model} is rate limited. "
                        f"Error: {e}"
                    ),
                    "iterations": iteration,
                    "elapsed": _time_mod.time() - started,
                }

            consecutive_failures += 1
            if consecutive_failures >= 3:
                return {
                    "status": "failed",
                    "summary": f"Sub-agent API error after {consecutive_failures} transient failures: {e}",
                    "iterations": iteration,
                    "elapsed": _time_mod.time() - started,
                }

            from ..retry_utils import jittered_backoff
            delay = jittered_backoff(consecutive_failures, base_delay=2.0)
            _time_mod.sleep(delay)
            continue

        choice = response.choices[0]
        msg = choice.message
        assistant_text = msg.content or ""

        if msg.tool_calls:
            if msg.content:
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
            else:
                messages.append({
                    "role": "assistant",
                    "content": None,
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
                        f"The only available tool is 'execute'. Use Python code.]"
                    )
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": error_msg,
                    })
                    continue

                try:
                    args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    args = {}

                code = args.get("code", "")
                desc = args.get("description", "Executing...")

                if not code or not code.strip():
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": "[SYSTEM: Empty code. Write actual Python code.]",
                    })
                    continue

                if on_progress:
                    on_progress(iteration, desc)

                # Check code against the safety gate.
                code = sanitize_code(code)
                _decision, _feedback = gate_code(code, desc, config=config)
                if _decision != ALLOW:
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": (
                            f"[SYSTEM: {_feedback} Use a safe, non-destructive "
                            f"approach, or report that this step needs human approval.]"
                        ),
                    })
                    continue

                raw_result = execute_code(code)
                success = raw_result.startswith("[✓]")
                if "\n" in raw_result:
                    output = raw_result.split("\n", 1)[1]
                else:
                    output = raw_result

                if len(output) > MAX_SUBAGENT_OUTPUT_CHARS:
                    output = output[:MAX_SUBAGENT_OUTPUT_CHARS] + "\n... (output truncated)"

                if success:
                    consecutive_failures = 0
                else:
                    consecutive_failures += 1

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": output,
                })

            messages = _trim_subagent_messages(messages)
            continue

        extracted = _extract_code_simple(assistant_text)
        if extracted:
            code, desc = extracted

            if on_progress:
                on_progress(iteration, desc)

            code = sanitize_code(code)
            _decision, _feedback = gate_code(code, desc, config=config)
            if _decision != ALLOW:
                messages.append({"role": "assistant", "content": assistant_text})
                messages.append({
                    "role": "user",
                    "content": (
                        f"[SYSTEM: {_feedback} Use a safe, non-destructive "
                        f"approach, or report that this step needs human approval.]"
                    ),
                })
                continue

            raw_result = execute_code(code)
            success = raw_result.startswith("[✓]")
            if "\n" in raw_result:
                output = raw_result.split("\n", 1)[1]
            else:
                output = raw_result

            if len(output) > MAX_SUBAGENT_OUTPUT_CHARS:
                output = output[:MAX_SUBAGENT_OUTPUT_CHARS] + "\n... (output truncated)"

            status_tag = "✓" if success else "✗"

            if success:
                consecutive_failures = 0
            else:
                consecutive_failures += 1

            messages.append({"role": "assistant", "content": assistant_text})
            messages.append({
                "role": "user",
                "content": f"[TOOL RESULT {status_tag}]\n{output}"
            })

            messages = _trim_subagent_messages(messages)
            continue

        last_text = assistant_text

        if "TASK COMPLETE" in assistant_text.upper():
            return {
                "status": "completed",
                "summary": assistant_text,
                "iterations": iteration,
                "elapsed": _time_mod.time() - started,
            }

        messages.append({"role": "assistant", "content": assistant_text})
        messages.append({
            "role": "user",
            "content": (
                "[SYSTEM: If the task is complete, respond with 'TASK COMPLETE:' "
                "followed by a summary. Otherwise, continue executing.]"
            )
        })

        if consecutive_failures >= 5:
            return {
                "status": "failed",
                "summary": f"Sub-agent failed after {consecutive_failures} consecutive errors. Last output: {last_text[:500]}",
                "iterations": iteration,
                "elapsed": _time_mod.time() - started,
            }

        continue

    return {
        "status": "max_iterations",
        "summary": f"Sub-agent hit max iterations ({max_iterations}). Last: {last_text[:500]}",
        "iterations": iteration,
        "elapsed": _time_mod.time() - started,
    }
