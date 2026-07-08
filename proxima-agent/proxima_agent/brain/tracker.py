"""Proxima — Tracker.
Tracks code execution success/failure and progress across conversation turns.
"""
import time
import re
from dataclasses import dataclass, field
from typing import Optional
from .planner import Plan, PlanStep, StepStatus

_STEP_MARKER_RE = re.compile(r'^#\s*step:\s*(.+)', re.IGNORECASE)
_TERMINAL_MARKERS = ("VERIFY:PASS", "VERIFY:FAIL", "VERIFY:UNKNOWN", "VERIFY_ERROR", "TASK:GAVE_UP")


def _extract_terminal_markers(text: str) -> str:
    """Extracts terminal verification marker lines from text."""
    if not text or not any(tok in text for tok in _TERMINAL_MARKERS):
        return ""
    return "\n".join(
        line for line in text.splitlines()
        if any(tok in line for tok in _TERMINAL_MARKERS)
    )


def _extract_step_marker(code: str) -> str:
    """Extracts step name from code header comment."""
    first_line = code.strip().split("\n")[0].strip() if code else ""
    match = _STEP_MARKER_RE.match(first_line)
    return match.group(1).strip() if match else ""


@dataclass
class ExecutionRecord:
    """Record of a single code execution."""
    turn: int
    code_snippet: str
    description: str
    result: str
    success: bool
    is_step: bool = False
    step_name: str = ""
    full_code: str = ""
    verify_markers: str = ""
    timestamp: float = field(default_factory=time.time)
    duration: float = 0.0
    recovery_needed: bool = False
    recovery_reasons: list[str] = field(default_factory=list)

    def as_text(self) -> str:
        icon = "[OK]" if self.success else "[FAIL]"
        label = f"[STEP: {self.step_name}]" if self.is_step else "[bg]"
        return f"{icon} {label} Turn {self.turn}: {self.description} ({self.result[:60]})"


class Tracker:
    """Tracks execution history and plan state."""

    def __init__(self):
        self.plan: Optional[Plan] = None
        self.executions: list[ExecutionRecord] = []
        self.turn_count: int = 0
        self.task_description: str = ""
        self.verified: bool = False

    def set_plan(self, plan: Plan):
        """Sets the current plan."""
        self.plan = plan

    def record_execution(self, code: str, description: str,
                         result: str, success: bool, duration: float = 0.0):
        """Records code execution outcome."""
        self.turn_count += 1

        step_name = _extract_step_marker(code)
        is_step = bool(step_name)

        record = ExecutionRecord(
            turn=self.turn_count,
            code_snippet=code[:200],
            description=description,
            result=result[:500],
            success=success,
            is_step=is_step,
            step_name=step_name,
            full_code=code[:1000],
            verify_markers=_extract_terminal_markers(result),
            duration=duration,
        )
        self.executions.append(record)

        if is_step and self.plan and self.plan.current_step:
            step = self.plan.current_step
            step.attempts += 1
            if success:
                step.status = StepStatus.DONE
                step.result = result[:200]
            else:
                if step.attempts >= 3:
                    step.status = StepStatus.FAILED
                    step.error = result[:200]

        return record

    def mark_step_done(self, step_index: int, result: str = ""):
        """Manually marks a plan step as done."""
        if self.plan and 0 < step_index <= len(self.plan.steps):
            step = self.plan.steps[step_index - 1]
            step.status = StepStatus.DONE
            step.result = result[:200]

    def mark_step_failed(self, step_index: int, error: str = ""):
        """Manually marks a plan step as failed."""
        if self.plan and 0 < step_index <= len(self.plan.steps):
            step = self.plan.steps[step_index - 1]
            step.status = StepStatus.FAILED
            step.error = error[:200]

    def mark_verified(self):
        """Marks the task as verified."""
        self.verified = True

    @property
    def needs_verification(self) -> bool:
        """Returns True if verification is pending."""
        if self.verified:
            return False
        if self.plan and self.plan.is_complete:
            return True
        if not self.plan and self.step_count >= 3:
            return True
        if not self.plan and self.step_count == 0 and len(self.executions) >= 5:
            return True
        return False

    @property
    def has_work_done(self) -> bool:
        """Returns True if work has been completed in this session."""
        if self.step_count > 0:
            return True
        return any(e.success for e in self.executions)

    @property
    def last_execution(self) -> Optional[ExecutionRecord]:
        return self.executions[-1] if self.executions else None

    @property
    def had_recovery(self) -> bool:
        """Returns True if any recovery occurred in this session."""
        return any(e.recovery_needed for e in self.executions)

    def detect_recovery_lesson(self) -> Optional[dict]:
        """Detects recovery sequences for learning memory extraction."""
        last = self.last_execution
        if not last or not last.is_step or not last.success or not last.step_name:
            return None
        failed_code = ""
        for rec in reversed(self.executions[:-1]):
            if rec.is_step and rec.step_name == last.step_name and not rec.success:
                failed_code = rec.full_code or rec.code_snippet
                break
        if not failed_code:
            return None
        return {
            "goal": last.step_name,
            "worked": last.full_code or last.code_snippet,
            "failed": failed_code,
        }

    @property
    def failure_count(self) -> int:
        """Counts failed steps."""
        return sum(1 for e in self.executions if not e.success and e.is_step)

    @property
    def consecutive_failures(self) -> int:
        """Returns consecutive failure count."""
        count = 0
        for e in reversed(self.executions):
            if e.success:
                break
            count += 1
        return count

    @property
    def success_count(self) -> int:
        """Counts successful steps."""
        return sum(1 for e in self.executions if e.success and e.is_step)

    @property
    def step_count(self) -> int:
        """Counts total steps executed."""
        return sum(1 for e in self.executions if e.is_step)

    @property
    def step_executions(self) -> list[ExecutionRecord]:
        """Returns only the step execution records."""
        return [e for e in self.executions if e.is_step]

    def get_context_summary(self) -> str:
        """Generates summary of execution history."""
        if self.step_count == 0:
            return ""

        lines = [
            f"[EXECUTION TRACKER — {self.step_count} steps taken, "
            f"{self.success_count} succeeded, {self.failure_count} failed"
            f" ({len(self.executions)} total executions)]"
        ]

        if self.plan:
            lines.append(self.plan.summary())
        else:
            lines.append("Recent steps:")
            for record in self.step_executions[-5:]:
                lines.append(f"  {record.as_text()}")

        if self.needs_verification:
            lines.append("\n[!] VERIFICATION PENDING -- verify final results before reporting to user.")

        return "\n".join(lines)

    def get_progress_for_display(self) -> str:
        """Gets progress string for console display."""
        if self.plan:
            return self.plan.progress_text
        return f"{self.step_count}steps {self.success_count}ok {self.failure_count}err"

    def reset(self):
        """Resets tracker state."""
        self.plan = None
        self.executions.clear()
        self.turn_count = 0
        self.task_description = ""
        self.verified = False
