"""Proxima — Brain Layer Orchestrator.
Coordinates planning, tracking, and verification across agent loop turns.
"""
from .state import probe_all
from .planner import PLAN_INSTRUCTION, parse_plan_from_text
from .tracker import Tracker
from .verifier import (
    build_verification_prompt,
    build_fix_prompt,
    should_verify,
    process_verification_result,
)


class Brain:
    """Orchestrates planning, tracking, and verification."""

    def __init__(self):
        self.tracker = Tracker()
        self._state_checked = False
        self._verification_injected = False
        self._post_turn_ran = False

    def get_current_state(self, include_browser: bool = True,
                          include_desktop: bool = False) -> str:
        """Gets current environment state as text."""
        return probe_all(include_browser=include_browser,
                        include_desktop=include_desktop)

    def enhance_user_message(self, user_message: str) -> str:
        """Enhances user's message with state and tracking context."""
        parts = [user_message]
        context = self.tracker.get_context_summary()
        if context:
            parts.append(f"\n\n{context}")
        return "\n".join(parts)

    def get_system_prompt_addon(self) -> str:
        """Gets system prompt addon."""
        return PLAN_INSTRUCTION

    def record(self, code: str, description: str,
               result: str, success: bool, duration: float = 0.0):
        """Records code execution result."""
        record = self.tracker.record_execution(
            code=code,
            description=description,
            result=result,
            success=success,
            duration=duration,
        )
        self._state_checked = False

        try:
            self._capture_lesson_if_any()
        except Exception:
            pass

        return record

    def _capture_lesson_if_any(self):
        """Detects and records recovery lessons."""
        try:
            from ..config import load_config
            if not load_config().get("agent_memory_enabled", True):
                return
        except Exception:
            pass

        lesson = self.tracker.detect_recovery_lesson()
        if not lesson:
            return
        ctx_key = self._current_context_key()
        try:
            from . import memory
            memory.record_lesson(
                ctx_key=ctx_key,
                goal=lesson["goal"],
                worked_code=lesson["worked"],
                failed_code=lesson["failed"],
            )
        except Exception:
            pass

    def _current_context_key(self) -> str:
        """Returns current context key (browser URL or window title)."""
        try:
            import urllib.request as _u
            import json as _j
            from ..config import CDP_URL
            with _u.urlopen(f"{CDP_URL}/json", timeout=0.3) as resp:
                pages = _j.loads(resp.read())
            for page in pages if isinstance(pages, list) else []:
                url = page.get("url", "")
                if url and not url.startswith("chrome://") and not url.startswith("about:"):
                    return url
        except Exception:
            pass
        try:
            from ..tools.computer.window_manager import get_active_window
            win = get_active_window()
            if win and win.get("title"):
                return win["title"]
        except Exception:
            pass
        return "general"

    def recall_lessons(self, ctx_key: str = None) -> str:
        """Returns injectable block of past lessons for context."""
        try:
            from ..config import load_config
            if not load_config().get("agent_memory_enabled", True):
                return ""
        except Exception:
            pass
        try:
            from . import memory
            key = ctx_key or self._current_context_key()
            return memory.format_for_prompt(memory.recall(key))
        except Exception:
            return ""

    def try_parse_plan(self, model_response: str, task: str = "") -> bool:
        """Parses plan from model's response."""
        plan = parse_plan_from_text(model_response, task=task)
        if plan and len(plan.steps) >= 2:
            self.tracker.set_plan(plan)
            return True
        return False

    @property
    def has_plan(self) -> bool:
        return self.tracker.plan is not None

    @property
    def plan_summary(self) -> str:
        if self.tracker.plan:
            return self.tracker.plan.summary()
        return "No plan"

    def should_verify(self) -> bool:
        """Checks if verification is needed."""
        if self._verification_injected:
            return False
        return should_verify(self.tracker)

    def get_verify_prompt(self) -> str:
        """Gets verification prompt."""
        self._verification_injected = True
        return build_verification_prompt(self.tracker)

    def process_verification(self, execution_result: str) -> dict:
        """Processes verification result from raw execution output."""
        result = process_verification_result(execution_result)
        if result["verified"]:
            self.tracker.mark_verified()
        return result

    def get_fix_prompt(self, issue: str) -> str:
        """Gets fix prompt for verification failure."""
        return build_fix_prompt(self.tracker, issue)

    @property
    def progress(self) -> str:
        """Returns progress display string."""
        return self.tracker.get_progress_for_display()

    @property
    def is_verified(self) -> bool:
        return self.tracker.verified

    def reset(self):
        """Resets brain instance state."""
        self.tracker.reset()
        self._state_checked = False
        self._verification_injected = False
        self._post_turn_ran = False
