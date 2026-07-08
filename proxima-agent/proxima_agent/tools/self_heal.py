"""Proxima — Self-Healing Engine.
Orchestrates error detection, known fix lookups, execution retries, and learning updates.
"""
from __future__ import annotations

import time
from typing import Any, Callable, Optional

from proxima_agent.tools.analytics import classify_failure
from proxima_agent.tools.learned_fixes import learned_fixes
from proxima_agent.tools.retry import retry_engine, RetryResult, SAFE_TO_RETRY
from proxima_agent.tools.replay import recorder

_SAFE_TO_RETRY = SAFE_TO_RETRY


class HealResult:
    """Outcome of a self-healing attempt."""
    __slots__ = (
        "value", "succeeded", "failure_class", "fix_applied",
        "recovery_action", "attempts", "total_ms", "learned",
    )

    def __init__(self, value: Any = None, succeeded: bool = True,
                 failure_class: str = "", fix_applied: bool = False,
                 recovery_action: str = "", attempts: int = 1,
                 total_ms: float = 0, learned: bool = False):
        self.value = value
        self.succeeded = succeeded
        self.failure_class = failure_class
        self.fix_applied = fix_applied
        self.recovery_action = recovery_action
        self.attempts = attempts
        self.total_ms = total_ms
        self.learned = learned

    def __repr__(self) -> str:
        status = "HEALED" if self.succeeded and self.fix_applied else (
            "OK" if self.succeeded else "FAIL"
        )
        fix_info = f", fix='{self.recovery_action}'" if self.fix_applied else ""
        learn_info = ", learned" if self.learned else ""
        return (
            f"HealResult({status}, {self.total_ms:.0f}ms, "
            f"{self.attempts} attempts{fix_info}{learn_info})"
        )


class SelfHealingEngine:
    """Executes tasks with automatic recovery policies and learning updates."""

    def __init__(self):
        self._heals_attempted = 0
        self._heals_succeeded = 0
        self._heals_failed = 0

    def execute(
        self,
        task: Callable[[], Any],
        tool: str = "unknown",
        context: str = "",
        idempotent: bool = False,
    ) -> HealResult:
        """Executes task with error classification and learning recovery."""
        start = time.perf_counter()
        first_error_str = ""

        try:
            value = task()
            total_ms = (time.perf_counter() - start) * 1000
            return HealResult(value=value, succeeded=True, total_ms=total_ms)
        except Exception as e:
            first_error_str = str(e)

        failure_class = classify_failure(first_error_str)

        known_fix = learned_fixes.lookup(failure_class, tool)
        fix_applied = known_fix is not None
        recovery_action = known_fix.recovery_action if known_fix else ""

        if known_fix:
            recorder.log(
                tool=f"self_heal:{tool}",
                args_summary=f"applying fix: {recovery_action}",
                duration_ms=0,
            )

        if not idempotent and failure_class not in _SAFE_TO_RETRY:
            self._heals_attempted += 1
            self._heals_failed += 1
            total_ms = (time.perf_counter() - start) * 1000
            return HealResult(
                succeeded=False,
                failure_class=failure_class,
                fix_applied=False,
                recovery_action="skipped auto-retry (non-idempotent action — "
                                "pass idempotent=True if safe to repeat)",
                attempts=1,
                total_ms=total_ms,
            )

        self._heals_attempted += 1
        retry_result = retry_engine.execute(task, tool=tool, idempotent=idempotent)

        total_ms = (time.perf_counter() - start) * 1000

        if retry_result.succeeded:
            self._heals_succeeded += 1

            if not known_fix:
                policy = retry_engine.get_policy(failure_class)
                recovery_desc = f"auto-retry {retry_result.attempts}x"
                if policy and policy.pre_retry:
                    recovery_desc += f" with {policy.pre_retry.__name__}"
                learned_fixes.record_success(
                    failure_class=failure_class,
                    tool=tool,
                    recovery_action=recovery_desc,
                )
                learned = True
            else:
                learned_fixes.update_outcome(failure_class, tool, success=True)
                learned = False

            return HealResult(
                value=retry_result.value,
                succeeded=True,
                failure_class=failure_class,
                fix_applied=fix_applied,
                recovery_action=recovery_action,
                attempts=retry_result.attempts + 1,
                total_ms=total_ms,
                learned=learned,
            )

        self._heals_failed += 1

        if known_fix:
            learned_fixes.update_outcome(failure_class, tool, success=False)

        return HealResult(
            succeeded=False,
            failure_class=failure_class,
            fix_applied=fix_applied,
            recovery_action=recovery_action,
            attempts=retry_result.attempts + 1,
            total_ms=total_ms,
        )

    def stats(self) -> dict:
        """Returns self-healing stats."""
        total = self._heals_attempted
        return {
            "attempted": total,
            "succeeded": self._heals_succeeded,
            "failed": self._heals_failed,
            "heal_rate": round(
                self._heals_succeeded / total, 3
            ) if total > 0 else 0.0,
            "known_fixes": len(learned_fixes.all()),
        }

    def __repr__(self) -> str:
        s = self.stats()
        return (
            f"SelfHealingEngine("
            f"{s['succeeded']}/{s['attempted']} healed, "
            f"{s['known_fixes']} known fixes)"
        )


healer = SelfHealingEngine()
