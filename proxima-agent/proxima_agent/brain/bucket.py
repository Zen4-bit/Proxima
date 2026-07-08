"""Proxima — Bucket-based Task Lifecycle Tracking.
Tracks user tasks through their execution states, step details, and verification outcomes.
"""
import time
from enum import Enum
from typing import Optional


class BucketStatus(Enum):
    """Lifecycle states of a task bucket."""
    IDLE = "idle"
    READY = "ready"
    PLANNING = "planning"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    DONE = "done"
    FAILED = "failed"
    ABANDONED = "abandoned"


class Confidence(Enum):
    """How confident we are in the current state."""
    UNKNOWN = "unknown"
    LOW = "low"
    HIGH = "high"
    VERIFIED = "verified"


class StepDetail:
    """Tracks a single step within a bucket."""
    __slots__ = ("name", "status", "confidence", "attempts", "last_error")

    def __init__(self, name: str):
        self.name = name
        self.status = "pending"
        self.confidence = Confidence.UNKNOWN
        self.attempts = 0
        self.last_error = ""

    def mark_running(self):
        self.status = "running"
        self.attempts += 1

    def mark_done(self, verified: bool = False):
        self.status = "done"
        self.confidence = Confidence.HIGH if verified else Confidence.LOW

    def mark_failed(self, error: str = ""):
        self.status = "failed"
        self.last_error = error[:120]
        self.confidence = Confidence.LOW

    def as_text(self) -> str:
        icons = {"pending": "[ ]", "running": "[>]", "done": "[+]", "failed": "[X]"}
        icon = icons.get(self.status, "[?]")
        conf = f" ({self.confidence.value})" if self.status == "done" else ""
        retry = f" (attempt {self.attempts})" if self.attempts > 1 else ""
        return f"{icon} {self.name}{conf}{retry}"


class Bucket:
    """Tracks a single user task through its lifecycle."""

    def __init__(self, task: str):
        self.task = task
        self.status = BucketStatus.IDLE
        self.current_step = 0
        self.total_steps = 0
        self.started_at = time.time()
        self.finished_at: Optional[float] = None
        self.verification_result: Optional[str] = None
        self.error: Optional[str] = None
        self.confidence = Confidence.UNKNOWN
        self.retry_count = 0
        self.step_details: list[StepDetail] = []
        self.activity: str = ""

    def start_ready(self):
        """Micro-task: skip planning and ready to execute."""
        self.status = BucketStatus.READY
        self.activity = f"Ready: {self.task[:60]}"

    def start_planning(self):
        """Complex task: enter planning state."""
        self.status = BucketStatus.PLANNING
        self.activity = f"Planning: {self.task[:60]}"

    def start_executing(self):
        self.status = BucketStatus.EXECUTING
        self.activity = "Starting execution..."

    def set_step(self, current: int, total: int):
        """Updates execution progress."""
        self.current_step = current
        self.total_steps = total
        if self.status in (BucketStatus.PLANNING, BucketStatus.READY):
            self.status = BucketStatus.EXECUTING

    def register_step(self, name: str) -> StepDetail:
        """Registers a named step."""
        detail = StepDetail(name)
        self.step_details.append(detail)
        self.total_steps = len(self.step_details)
        return detail

    def update_current_step(self, step_name: str, success: bool,
                            error: str = "", verified: bool = False):
        """Updates the execution status of a step by name."""
        target = None
        for sd in self.step_details:
            if sd.name.lower() == step_name.lower():
                target = sd
                break
        if not target:
            target = self.register_step(step_name)
        target.mark_running()
        if success:
            target.mark_done(verified=verified)
            self.current_step = sum(1 for s in self.step_details if s.status == "done")
            self.activity = f"Completed: {step_name[:50]}"
            done_steps = [s for s in self.step_details if s.status == "done"]
            if done_steps:
                if all(s.confidence == Confidence.HIGH for s in done_steps):
                    self.confidence = Confidence.HIGH
                else:
                    self.confidence = Confidence.LOW
        else:
            target.mark_failed(error)
            self.retry_count += 1
            self.activity = f"Failed: {step_name[:40]} — retrying..."

    def start_verifying(self):
        self.status = BucketStatus.VERIFYING
        self.activity = "Verifying final result..."

    def mark_done(self, verification: str = "Verified"):
        self.status = BucketStatus.DONE
        self.finished_at = time.time()
        self.verification_result = verification
        self.confidence = Confidence.VERIFIED
        self.activity = f"Done: {verification[:50]}"

    def mark_failed(self, reason: str):
        self.status = BucketStatus.FAILED
        self.finished_at = time.time()
        self.error = reason
        self.activity = f"Failed: {reason[:50]}"

    def abandon(self, reason: str = "Superseded by new request"):
        """Marks task as abandoned."""
        self.status = BucketStatus.ABANDONED
        self.finished_at = time.time()
        self.error = reason
        self.confidence = Confidence.UNKNOWN
        self.activity = f"Abandoned: {reason[:50]}"

    @property
    def is_active(self) -> bool:
        return self.status in (
            BucketStatus.READY, BucketStatus.PLANNING,
            BucketStatus.EXECUTING, BucketStatus.VERIFYING
        )

    @property
    def is_complete(self) -> bool:
        return self.status in (BucketStatus.DONE, BucketStatus.FAILED, BucketStatus.ABANDONED)

    @property
    def duration(self) -> float:
        end = self.finished_at or time.time()
        return end - self.started_at

    def context_summary(self) -> str:
        """Returns context summary for prompt context."""
        status_icon = {
            BucketStatus.IDLE: "IDLE",
            BucketStatus.READY: "READY",
            BucketStatus.PLANNING: "PLANNING",
            BucketStatus.EXECUTING: "EXECUTING",
            BucketStatus.VERIFYING: "VERIFYING",
            BucketStatus.DONE: "DONE",
            BucketStatus.FAILED: "FAILED",
            BucketStatus.ABANDONED: "ABANDONED",
        }

        parts = [f"Task: {self.task[:80]}"]
        parts.append(f"Status: {status_icon[self.status]}")

        if self.activity:
            parts.append(f"Activity: {self.activity[:80]}")

        if self.total_steps > 0:
            parts.append(f"Progress: step {self.current_step}/{self.total_steps}")

        if self.confidence != Confidence.UNKNOWN:
            parts.append(f"Confidence: {self.confidence.value}")

        if self.retry_count > 0:
            parts.append(f"Retries: {self.retry_count}")

        if self.status == BucketStatus.DONE:
            parts.append(f"Result: {self.verification_result}")
        elif self.status == BucketStatus.FAILED:
            parts.append(f"Error: {self.error}")

        return " | ".join(parts)


class BucketManager:
    """Manages task buckets across a conversation session."""

    def __init__(self):
        self.buckets: list[Bucket] = []
        self._current: Optional[Bucket] = None

    def new_bucket(self, task: str) -> Bucket:
        """Starts a new task bucket, abandoning any currently active bucket."""
        if self._current and self._current.is_active:
            self._current.abandon()

        bucket = Bucket(task)
        self.buckets.append(bucket)
        self._current = bucket
        return bucket

    @property
    def current(self) -> Optional[Bucket]:
        return self._current

    @property
    def has_active_bucket(self) -> bool:
        return self._current is not None and self._current.is_active

    def get_context(self) -> str:
        """Gets current bucket context for light prompt."""
        if not self._current:
            return ""

        parts = [self._current.context_summary()]

        if self._current.step_details:
            step_lines = []
            for sd in self._current.step_details:
                step_lines.append(f"  {sd.as_text()}")
            if step_lines:
                parts.append("Steps:\n" + "\n".join(step_lines))

        completed = [b for b in self.buckets if b.is_complete]
        if completed:
            last = completed[-1]
            parts.append(f"Previous: {last.task[:50]} -> {last.status.value}")

        return "\n".join(parts)

    @property
    def total_completed(self) -> int:
        return sum(1 for b in self.buckets if b.status == BucketStatus.DONE)

    @property
    def total_failed(self) -> int:
        return sum(1 for b in self.buckets if b.status == BucketStatus.FAILED)

    def reset(self):
        """Resets all buckets."""
        self.buckets.clear()
        self._current = None
