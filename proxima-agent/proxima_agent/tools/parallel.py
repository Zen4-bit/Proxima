"""Proxima — Parallel Execution.
Provides concurrent execution helper for independent, read-only I/O tasks.
"""
from __future__ import annotations

import concurrent.futures
import time
from typing import Any, Callable, Optional

try:
    from proxima_agent.tools.registry import parallel_safe_set
    PARALLEL_SAFE = parallel_safe_set()
except ImportError:
    PARALLEL_SAFE = frozenset()


class ParallelResult:
    """Container for one parallel task result."""
    __slots__ = ("value", "error", "elapsed_ms", "succeeded")

    def __init__(self, value: Any = None, error: Exception = None,
                 elapsed_ms: float = 0):
        self.value = value
        self.error = error
        self.elapsed_ms = elapsed_ms
        self.succeeded = error is None

    def __repr__(self) -> str:
        if self.succeeded:
            preview = repr(self.value)[:80]
            return f"ParallelResult(ok, {self.elapsed_ms:.0f}ms, {preview})"
        return f"ParallelResult(FAILED, {self.elapsed_ms:.0f}ms, {self.error})"


class ParallelBatch:
    """Results from a parallel execution batch."""

    def __init__(self, results: list[ParallelResult], total_elapsed_ms: float):
        self.results = results
        self.total_elapsed_ms = total_elapsed_ms
        self.all_succeeded = all(r.succeeded for r in results)
        self.errors = [
            (i, r.error) for i, r in enumerate(results) if not r.succeeded
        ]

    def values(self) -> list[Any]:
        """Returns all successful task values."""
        return [r.value for r in self.results]

    def __repr__(self) -> str:
        ok = sum(1 for r in self.results if r.succeeded)
        total = len(self.results)
        return (
            f"ParallelBatch({ok}/{total} ok, "
            f"{self.total_elapsed_ms:.0f}ms total)"
        )


def parallel(
    tasks: list[Callable[[], Any]],
    timeout: Optional[float] = 30.0,
    max_workers: Optional[int] = None,
    labels: Optional[list[str]] = None,
) -> ParallelBatch:
    """Executes a list of zero-argument callables concurrently."""
    if not tasks:
        return ParallelBatch([], 0)

    n = len(tasks)
    workers = max_workers or min(n, 8)
    labels = labels or [f"task_{i}" for i in range(n)]
    results: list[Optional[ParallelResult]] = [None] * n

    batch_start = time.perf_counter()

    executor = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
    try:
        future_to_idx: dict[concurrent.futures.Future, int] = {}
        for i, task in enumerate(tasks):
            future = executor.submit(_run_one, task, labels[i])
            future_to_idx[future] = i

        try:
            done, not_done = concurrent.futures.wait(
                future_to_idx.keys(),
                timeout=timeout,
                return_when=concurrent.futures.ALL_COMPLETED,
            )
        except Exception:
            done = set()
            not_done = set(future_to_idx.keys())

        for future in done:
            idx = future_to_idx[future]
            try:
                results[idx] = future.result(timeout=0)
            except Exception as e:
                results[idx] = ParallelResult(
                    error=e, elapsed_ms=0
                )

        for future in not_done:
            idx = future_to_idx[future]
            future.cancel()
            results[idx] = ParallelResult(
                error=TimeoutError(
                    f"{labels[idx]} timed out after {timeout}s"
                ),
                elapsed_ms=timeout * 1000 if timeout else 0,
            )
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    for i in range(n):
        if results[i] is None:
            results[i] = ParallelResult(
                error=RuntimeError(f"{labels[i]} produced no result"),
                elapsed_ms=0,
            )

    total_ms = (time.perf_counter() - batch_start) * 1000
    return ParallelBatch(results, total_ms)


def _run_one(task: Callable, label: str) -> ParallelResult:
    """Executes a single task with timing and error capture."""
    start = time.perf_counter()
    try:
        value = task()
        elapsed = (time.perf_counter() - start) * 1000
        return ParallelResult(value=value, elapsed_ms=elapsed)
    except Exception as e:
        elapsed = (time.perf_counter() - start) * 1000
        return ParallelResult(error=e, elapsed_ms=elapsed)
