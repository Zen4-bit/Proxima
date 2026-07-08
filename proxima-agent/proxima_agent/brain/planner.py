"""Proxima — Planner.
Defines structure and parsing logic for execution plans and step details.
"""
import re
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum


class StepStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class PlanStep:
    """A single step in an execution plan."""
    index: int
    action: str
    expected_outcome: str
    environment: str
    status: StepStatus = StepStatus.PENDING
    result: str = ""
    error: str = ""
    attempts: int = 0

    def as_text(self) -> str:
        status_icon = {
            StepStatus.PENDING: "[ ]",
            StepStatus.RUNNING: "[>]",
            StepStatus.DONE: "[+]",
            StepStatus.FAILED: "[X]",
            StepStatus.SKIPPED: "[-]",
        }
        icon = status_icon.get(self.status, "?")
        line = f"  {icon} Step {self.index}: {self.action}"
        if self.status == StepStatus.DONE and self.result:
            line += f" → {self.result[:80]}"
        if self.status == StepStatus.FAILED and self.error:
            line += f" → ERROR: {self.error[:80]}"
        return line


@dataclass
class Plan:
    """Structured execution plan with tracked steps."""
    task: str
    steps: list[PlanStep] = field(default_factory=list)
    verification: str = ""

    def add_step(self, action: str, expected: str = "", env: str = "auto") -> PlanStep:
        step = PlanStep(
            index=len(self.steps) + 1,
            action=action,
            expected_outcome=expected,
            environment=env,
        )
        self.steps.append(step)
        return step

    @property
    def current_step(self) -> Optional[PlanStep]:
        """Gets next pending step."""
        for step in self.steps:
            if step.status == StepStatus.PENDING:
                return step
        return None

    @property
    def is_complete(self) -> bool:
        """Returns True if all steps done or skipped."""
        return all(
            s.status in (StepStatus.DONE, StepStatus.SKIPPED)
            for s in self.steps
        )

    @property
    def has_failures(self) -> bool:
        return any(s.status == StepStatus.FAILED for s in self.steps)

    @property
    def progress_text(self) -> str:
        done = sum(1 for s in self.steps if s.status == StepStatus.DONE)
        total = len(self.steps)
        return f"{done}/{total} steps done"

    def summary(self) -> str:
        """Returns full plan summary as text."""
        lines = [f"PLAN: {self.task}", f"Progress: {self.progress_text}", ""]
        for step in self.steps:
            lines.append(step.as_text())
        if self.verification:
            lines.append(f"\n  [VERIFY]: {self.verification}")
        return "\n".join(lines)

    def failed_steps(self) -> list[PlanStep]:
        return [s for s in self.steps if s.status == StepStatus.FAILED]

    def pending_steps(self) -> list[PlanStep]:
        return [s for s in self.steps if s.status == StepStatus.PENDING]


_ACTION_VERBS = re.compile(
    r'\b(?:open|close|click|type|fill|send|save|write|read|install|run|execute|'
    r'navigate|go\s+to|launch|start|stop|create|delete|remove|download|upload|'
    r'search|find|check|verify|confirm|set|configure|update|build|deploy|'
    r'connect|login|log\s*in|sign\s*in|copy|paste|move|rename|extract|test|'
    r'analyze|review|summarize|compare|diagnose|audit|inspect|assess|evaluate|'
    r'debug|refactor|merge|commit|push|pull|fetch|compile|lint|format|migrate)\b',
    re.IGNORECASE,
)

_PLAN_HEADER = re.compile(
    r'(?:^|\n)\s*(?:PLAN|STEPS|APPROACH|STRATEGY|PROCEDURE|GAME\s+PLAN'
    r'|HERE(?:\'S|\s+IS)\s+(?:MY|THE)\s+PLAN'
    r'|I(?:\'LL|\s+WILL)\s+(?:DO|PROCEED|START)\s+(?:THIS|WITH))\s*[:\n]',
    re.IGNORECASE,
)


def parse_plan_from_text(text: str, task: str = "") -> Optional[Plan]:
    """Parses a structured execution plan from response text."""
    if not text:
        return None

    has_plan_header = bool(_PLAN_HEADER.search(text))

    step_pattern = re.compile(
        r'(?:^|\n)\s*(\d+)[.)]\s*(.+?)(?:\s*[→\-:]+\s*(?:expect|expected|verify)?:?\s*(.+?))?$',
        re.MULTILINE
    )

    matches = step_pattern.findall(text)
    if len(matches) < 2:
        return None

    action_count = sum(1 for _, action, _ in matches if _ACTION_VERBS.search(action))

    if not has_plan_header and action_count < len(matches) * 0.5:
        return None

    plan = Plan(task=task)

    for idx_str, action, expected in matches:
        action = action.strip().rstrip('→-:')
        expected = expected.strip() if expected else ""
        plan.add_step(action=action, expected=expected)

    verify_match = re.search(
        r'(?:VERIFY|VERIFICATION|CHECK|CONFIRM)[:\s]+(.+)',
        text, re.IGNORECASE
    )
    if verify_match:
        plan.verification = verify_match.group(1).strip()

    return plan if plan.steps else None


PLAN_INSTRUCTION = """
EXECUTION:
- Micro task (single action) → just do it. No plan needed.
- Multi-step → plan briefly, then execute step 1 in the SAME response.
- ONE step per turn. Write code, run it, read output. Then next step.
- Mark real plan steps with: # step: [step name]
- If partial work exists, continue from there — never restart from scratch.
- Each step must print() its results.
- Last step: verify the OVERALL GOAL was achieved.
"""
