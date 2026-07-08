"""Proxima — Agent Bridge.
Connects the synchronous agent execution loop to the asynchronous WebSocket world.
"""
import asyncio
import re
import threading
from typing import Optional, Callable

from ..config import load_config
from ..permissions import PermissionMode


def _default_api_url() -> str:
    try:
        from ..config import DEFAULT_API_URL
        return DEFAULT_API_URL
    except Exception:
        return "http://127.0.0.1:3210/v1"


def _default_api_key() -> str:
    try:
        from ..config import DEFAULT_CONFIG
        return DEFAULT_CONFIG.get("api_key", "")
    except Exception:
        return ""


def _strip_rich_markup(text: str) -> str:
    return re.sub(r'\[/?[a-zA-Z_][a-zA-Z0-9_ ]*\]', '', str(text))


class WebConsole:

    def __init__(self, loop: asyncio.AbstractEventLoop, ws):
        self._loop = loop
        self._ws = ws
        self._input_event = threading.Event()
        self._input_value: Optional[str] = None
        self._disconnected = threading.Event()
        self._cancelled = threading.Event()
        self._on_message: Optional[Callable] = None

    def _send_sync(self, data: dict):
        if self._disconnected.is_set():
            return
        try:
            future = asyncio.run_coroutine_threadsafe(
                self._ws.send_json(data), self._loop
            )
            future.result(timeout=5)
        except Exception:
            self._disconnected.set()
            self._input_event.set()

    def print(self, text="", **kwargs):
        if self._disconnected.is_set():
            return
        clean = _strip_rich_markup(str(text))
        if not clean.strip():
            return
        self._send_sync({"type": "console", "text": clean})

    def _await_response(self, timeout: float = 300) -> Optional[str]:
        got = self._input_event.wait(timeout=timeout)
        if not got or self._cancelled.is_set() or self._disconnected.is_set():
            return None
        value = self._input_value
        self._input_value = None  # consume — a value is valid for exactly one read
        return value

    def input(self, prompt: str = "") -> str:
        if self.is_cancelled:
            return ""
        self._input_event.clear()
        self._input_value = None
        self._send_sync({"type": "input_request", "prompt": prompt})
        if self.is_cancelled:
            return ""
        value = self._await_response()
        return value if value is not None else ""

    def request_suggest(self, context: str, options: list) -> str:
        if self.is_cancelled:
            return ""
        self._input_event.clear()
        self._input_value = None
        self._send_sync({
            "type": "suggest_request",
            "context": context or "",
            "options": list(options or []),
        })
        if self.is_cancelled:
            return ""
        value = self._await_response()
        return value if value is not None else ""

    def request_approval(self, action: str, code: str, reasons: list) -> bool:
        if self.is_cancelled:
            return False
        self._input_event.clear()
        self._input_value = None
        self._send_sync({
            "type": "approval_request",
            "action": action or "Execute code",
            "code": code or "",
            "reasons": list(reasons or []),
        })
        if self.is_cancelled:
            return False
        value = self._await_response()
        if value is None:
            return False
        return value.strip().lower() in ("y", "yes", "true", "1")

    def receive_input(self, value: str):
        if self._cancelled.is_set() or self._disconnected.is_set():
            return
        self._input_value = value
        self._input_event.set()

    def disconnect(self):
        self._disconnected.set()
        self._cancelled.set()
        self._input_event.set()

    def cancel(self):
        self._cancelled.set()
        self._input_event.set()

    def reset_cancel(self):
        self._cancelled.clear()
        self._input_event.clear()
        self._input_value = None  # drop any answer left over from a prior run

    @property
    def is_disconnected(self) -> bool:
        return self._disconnected.is_set()

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled.is_set() or self._disconnected.is_set()

    # ─── Structured messages for the frontend ─────────────

    def send_event(self, event_type: str, **data):
        """Send a structured event to the frontend."""
        if self._disconnected.is_set():
            return
        msg = {"type": event_type}
        msg.update(data)
        self._send_sync(msg)

    def send_token(self, token: str):
        """Send a streaming token."""
        self.send_event("token", content=token)

    def send_code_start(self, code: str, description: str):
        """Notify frontend that code execution is starting."""
        self._current_code = code
        self._current_desc = description
        self.send_event("code_start", code=code, desc=description)

    def send_code_result(self, result: str, success: bool, duration: float):
        """Notify frontend of code execution result."""
        self.send_event("code_result", result=result,
                        success=success, duration=round(duration, 3))
        conv_id = getattr(self, "conversation_id", None)
        if conv_id:
            try:
                from . import db
                db.save_execution(
                    conv_id,
                    getattr(self, "_current_code", ""),
                    getattr(self, "_current_desc", ""),
                    result,
                    success,
                    int(duration * 1000)
                )
            except Exception as e:
                print(f"[WebConsole] Failed to save execution: {e}")

    def send_status(self, **status):
        """Send status update (model, mode, connected, etc.)."""
        self.send_event("status", **status)

    def send_plan_update(self, plan_data: dict):
        """Send brain plan state update."""
        self.send_event("plan_update", plan=plan_data)

    def send_error(self, message: str):
        """Send error message to frontend."""
        self.send_event("error", message=message)


class AgentRunner:

    def __init__(self):
        self._thread: Optional[threading.Thread] = None
        self._console: Optional[WebConsole] = None
        self._messages: list = []
        self._lock = threading.Lock()
        self._running = False
        self._conversation_id: Optional[str] = None

    @property
    def is_running(self) -> bool:
        return self._running and self._thread is not None and self._thread.is_alive()

    def start(self, console: WebConsole, user_message: str,
              model: str = "auto", mode: str = "smart",
              conversation_id: str = "", file_path: str = None):
        if self.is_running:
            console.send_error("Agent is already running. Wait for it to finish.")
            return

        console.reset_cancel()

        self._console = console
        console.conversation_id = conversation_id

        switched = (self._conversation_id is not None
                    and self._conversation_id != conversation_id)
        if self._conversation_id != conversation_id or not self._messages:
            if switched:
                try:
                    from ..agent import reset_session
                    reset_session()
                except Exception:
                    pass
            self._messages = []
            self._conversation_id = conversation_id
            if conversation_id:
                try:
                    from . import db
                    past_msgs = db.get_messages(conversation_id)
                    for pm in past_msgs:
                        role = pm.get("role")
                        content = pm.get("content")
                        if role in ("user", "assistant", "system"):
                            self._messages.append({"role": role, "content": content})
                    if (self._messages
                            and self._messages[-1].get("role") == "user"
                            and self._messages[-1].get("content") == user_message):
                        self._messages.pop()
                except Exception as e:
                    print(f"[Agent Bridge] Failed to restore history: {e}")
        else:
            self._conversation_id = conversation_id

        mode_map = {
            "full_auto": PermissionMode.FULL_AUTO,
            "smart": PermissionMode.SMART,
            "suggest": PermissionMode.SUGGEST,
        }
        permission_mode = mode_map.get(mode, PermissionMode.SMART)

        config = load_config()
        if model and model != "auto":
            config["model"] = model

        self._thread = threading.Thread(
            target=self._run_loop,
            args=(console, user_message, config, permission_mode, file_path),
            daemon=True,
            name="proxima-agent-loop",
        )
        self._running = True
        self._thread.start()

    def _run_loop(self, console: WebConsole, user_message: str,
                  config: dict, permission_mode, file_path: str = None):
        from openai import OpenAI
        from ..agent import run_agent_loop
        from ..config import get_agent_byok_key

        try:
            model_str = config.get("model", "auto")
            provider = model_str.split(":")[0] if ":" in model_str else model_str

            default_headers = {}
            agent_key = get_agent_byok_key(provider) if provider != "auto" else None
            if agent_key:
                default_headers["X-Provider-Key"] = agent_key
                print(f"[BYOK] Using agent API key for {provider}")

            client = OpenAI(
                base_url=config.get("api_url") or _default_api_url(),
                api_key=config.get("api_key") or _default_api_key(),
                default_headers=default_headers or None,
            )

            console.send_status(
                connected=True,
                model=config.get("model", "auto"),
                mode=permission_mode.value,
                running=True,
            )

            result = run_agent_loop(
                client=client,
                config=config,
                user_message=user_message,
                messages=self._messages,
                console=console,
                permission_mode=permission_mode,
                file_path=file_path,
                conversation_id=self._conversation_id,
            )

            if result and self._conversation_id:
                try:
                    from . import db
                    db.save_message(self._conversation_id, "assistant", str(result))
                except Exception:
                    pass

        except Exception as e:
            console.send_error(f"Agent error: {e}")
        finally:
            self._running = False
            console.send_event("agent_done")
            console.send_status(running=False)

    def stop(self):
        if self._console and self._thread and self._thread.is_alive():
            self._console.cancel()

    def reset(self):
        self.stop()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)
        if self._thread and self._thread.is_alive() and self._console:
            self._console.disconnect()
            self._thread.join(timeout=2)

        if self._thread and self._thread.is_alive():
            print("[Agent Bridge] Previous agent run still finishing; "
                  "reset deferred until it exits to avoid concurrent loops.")
            return

        self._messages = []
        self._conversation_id = None
        self._thread = None
        self._console = None
        try:
            from ..agent import reset_session
            reset_session()
        except Exception:
            pass
