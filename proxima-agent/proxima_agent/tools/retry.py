"""Proxima — Auto-Retry.
Executes tasks with automatic recovery policies based on failure classifications.
"""
from __future__ import annotations

import time
from typing import Any, Callable, Optional

from proxima_agent.tools.analytics import classify_failure
from proxima_agent.retry_utils import jittered_backoff


class RetryPolicy:
    """Defines how to handle a specific failure class."""

    def __init__(
        self,
        failure_class: str,
        max_retries: int = 2,
        backoff_base: float = 1.0,
        backoff_multiplier: float = 2.0,
        max_delay: float = 30.0,
        pre_retry: Optional[Callable[[], None]] = None,
        should_retry: Optional[Callable[[Exception, int], bool]] = None,
    ):
        self.failure_class = failure_class
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.backoff_multiplier = backoff_multiplier
        self.max_delay = max_delay
        self.pre_retry = pre_retry
        self.should_retry = should_retry

    def delay_for_attempt(self, attempt: int) -> float:
        """Returns jittered backoff delay before retry attempt."""
        return jittered_backoff(
            attempt + 1,
            base_delay=self.backoff_base,
            max_delay=self.max_delay,
            multiplier=self.backoff_multiplier,
        )

    def __repr__(self) -> str:
        return (
            f"RetryPolicy({self.failure_class}, "
            f"max={self.max_retries}, base={self.backoff_base}s)"
        )


def _browser_reconnect():
    """Invalidates cached browser health to force reconnect on next call."""
    try:
        from proxima_agent.tools.health import invalidate_cache
        invalidate_cache("browser")
    except Exception:
        pass


DEFAULT_POLICIES: dict[str, RetryPolicy] = {
    "timeout": RetryPolicy(
        failure_class="timeout",
        max_retries=2,
        backoff_base=2.0,
        backoff_multiplier=2.0,
        max_delay=15.0,
    ),
    "connection_failed": RetryPolicy(
        failure_class="connection_failed",
        max_retries=3,
        backoff_base=1.0,
        backoff_multiplier=2.0,
        max_delay=10.0,
        pre_retry=_browser_reconnect,
    ),
    "element_not_found": RetryPolicy(
        failure_class="element_not_found",
        max_retries=2,
        backoff_base=1.5,
        backoff_multiplier=1.5,
        max_delay=5.0,
    ),
    "verification_failed": RetryPolicy(
        failure_class="verification_failed",
        max_retries=1,
        backoff_base=2.0,
        backoff_multiplier=1.0,
        max_delay=5.0,
    ),
    "rate_limited": RetryPolicy(
        failure_class="rate_limited",
        max_retries=3,
        backoff_base=5.0,
        backoff_multiplier=3.0,
        max_delay=60.0,
    ),
    "disconnected": RetryPolicy(
        failure_class="disconnected",
        max_retries=2,
        backoff_base=2.0,
        backoff_multiplier=2.0,
        max_delay=10.0,
        pre_retry=_browser_reconnect,
    ),
    "stale_reference": RetryPolicy(
        failure_class="stale_reference",
        max_retries=2,
        backoff_base=1.0,
        backoff_multiplier=1.5,
        max_delay=5.0,
    ),
    "not_found": RetryPolicy(
        failure_class="not_found",
        max_retries=0,
    ),
    "permission_denied": RetryPolicy(
        failure_class="permission_denied",
        max_retries=0,
    ),
    "syntax_error": RetryPolicy(
        failure_class="syntax_error",
        max_retries=0,
    ),
    "import_error": RetryPolicy(
        failure_class="import_error",
        max_retries=0,
    ),
}

SAFE_TO_RETRY = frozenset({
    "connection_failed", "element_not_found", "stale_reference",
    "import_error", "not_found",
})
_SAFE_TO_RETRY = SAFE_TO_RETRY


class RetryResult:
    """Outcome of a retry-aware execution."""
    __slots__ = ("value", "succeeded", "attempts", "total_ms",
                 "failure_class", "final_error", "retried")

    def __init__(self, value: Any = None, succeeded: bool = True,
                 attempts: int = 1, total_ms: float = 0,
                 failure_class: str = "", final_error: str = "",
                 retried: bool = False):
        self.value = value
        self.succeeded = succeeded
        self.attempts = attempts
        self.total_ms = total_ms
        self.failure_class = failure_class
        self.final_error = final_error
        self.retried = retried

    def __repr__(self) -> str:
        status = "OK" if self.succeeded else "FAIL"
        retry_info = f", retried {self.attempts - 1}x" if self.retried else ""
        return f"RetryResult({status}, {self.total_ms:.0f}ms{retry_info})"


class RetryEngine:
    """Executes tasks with failure-class-based retry policies."""

    def __init__(self, policies: Optional[dict[str, RetryPolicy]] = None):
        self._policies = dict(DEFAULT_POLICIES)
        if policies:
            self._policies.update(policies)

    def set_policy(self, failure_class: str, policy: RetryPolicy):
        """Overrides or adds a retry policy for a failure class."""
        self._policies[failure_class] = policy

    def get_policy(self, failure_class: str) -> Optional[RetryPolicy]:
        """Gets policy for a failure class."""
        return self._policies.get(failure_class)

    def execute(
        self,
        task: Callable[[], Any],
        tool: str = "unknown",
        override_policy: Optional[RetryPolicy] = None,
        idempotent: bool = False,
    ) -> RetryResult:
        """Executes a task with failure-classification-based retries."""
        start = time.perf_counter()
        attempts = 0
        last_error = None
        failure_class = ""

        while True:
            attempts += 1
            try:
                value = task()
                total_ms = (time.perf_counter() - start) * 1000
                return RetryResult(
                    value=value,
                    succeeded=True,
                    attempts=attempts,
                    total_ms=total_ms,
                    retried=attempts > 1,
                )
            except Exception as e:
                last_error = e
                failure_class = classify_failure(str(e))

                if not idempotent and failure_class not in _SAFE_TO_RETRY:
                    total_ms = (time.perf_counter() - start) * 1000
                    return RetryResult(
                        succeeded=False,
                        attempts=attempts,
                        total_ms=total_ms,
                        failure_class=failure_class,
                        final_error=str(e),
                        retried=attempts > 1,
                    )

                policy = override_policy or self._policies.get(failure_class)
                if not policy or attempts > policy.max_retries:
                    total_ms = (time.perf_counter() - start) * 1000
                    return RetryResult(
                        succeeded=False,
                        attempts=attempts,
                        total_ms=total_ms,
                        failure_class=failure_class,
                        final_error=str(e),
                        retried=attempts > 1,
                    )

                if policy.should_retry and not policy.should_retry(e, attempts):
                    total_ms = (time.perf_counter() - start) * 1000
                    return RetryResult(
                        succeeded=False,
                        attempts=attempts,
                        total_ms=total_ms,
                        failure_class=failure_class,
                        final_error=str(e),
                        retried=attempts > 1,
                    )

                if policy.pre_retry:
                    try:
                        policy.pre_retry()
                    except Exception:
                        pass

                delay = policy.delay_for_attempt(attempts - 1)
                time.sleep(delay)


retry_engine = RetryEngine()
