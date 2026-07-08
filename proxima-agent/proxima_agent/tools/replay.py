"""Proxima — Execution Replay.
Records tool invocations with execution stats for debugging and analytics.
"""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
from collections import deque
from typing import Any, Optional


class ReplayEntry:
    """One recorded tool invocation."""
    __slots__ = (
        "tool", "args_summary", "started_at", "duration_ms",
        "succeeded", "result_preview", "error", "error_trace",
        "security_level", "turn_index",
    )

    def __init__(
        self,
        tool: str,
        args_summary: str,
        started_at: float,
        duration_ms: float,
        succeeded: bool,
        result_preview: str = "",
        error: str = "",
        error_trace: str = "",
        security_level: int = 0,
        turn_index: int = 0,
    ):
        self.tool = tool
        self.args_summary = args_summary
        self.started_at = started_at
        self.duration_ms = duration_ms
        self.succeeded = succeeded
        self.result_preview = result_preview
        self.error = error
        self.error_trace = error_trace
        self.security_level = security_level
        self.turn_index = turn_index

    def to_dict(self) -> dict:
        return {
            "tool": self.tool,
            "args": self.args_summary,
            "time": self.started_at,
            "duration_ms": round(self.duration_ms, 1),
            "ok": self.succeeded,
            "result": self.result_preview,
            "error": self.error,
            "trace": self.error_trace,
            "level": self.security_level,
            "turn": self.turn_index,
        }

    def __repr__(self) -> str:
        status = "OK" if self.succeeded else "FAIL"
        return (
            f"[{status}] {self.tool}({self.args_summary}) "
            f"{self.duration_ms:.0f}ms"
        )


class ExecutionRecorder:
    """Thread-safe ring buffer that logs tool invocations."""

    def __init__(self, max_entries: int = 500):
        self._buffer: deque[ReplayEntry] = deque(maxlen=max_entries)
        self._lock = threading.Lock()
        self._turn_lock = threading.Lock()
        self._turn_index = 0

    def next_turn(self):
        """Increments the turn counter."""
        with self._turn_lock:
            self._turn_index += 1

    @property
    def turn(self) -> int:
        return self._turn_index

    def record(self, tool: str, args_summary: str = "",
               security_level: int = 0) -> "_RecordContext":
        """Context manager for recording a tool call."""
        return _RecordContext(self, tool, args_summary, security_level)

    def log(self, tool: str, args_summary: str = "",
            result: Any = None, error: Optional[Exception] = None,
            duration_ms: float = 0, security_level: int = 0):
        """Directly logs tool call without context manager."""
        result_preview = _truncate(repr(result), 200) if result is not None else ""
        error_str = str(error) if error else ""
        error_trace = traceback.format_exception(error)[-3:] if error else []

        entry = ReplayEntry(
            tool=tool,
            args_summary=_truncate(args_summary, 150),
            started_at=time.time(),
            duration_ms=duration_ms,
            succeeded=error is None,
            result_preview=result_preview,
            error=error_str,
            error_trace="\n".join(error_trace),
            security_level=security_level,
            turn_index=self._turn_index,
        )
        with self._lock:
            self._buffer.append(entry)

    def _append(self, entry: ReplayEntry):
        """Appends entry to the buffer in a thread-safe way."""
        with self._lock:
            self._buffer.append(entry)

    def last(self, n: int = 10) -> list[ReplayEntry]:
        """Gets last N recorded entries."""
        with self._lock:
            entries = list(self._buffer)
        return entries[-n:]

    def failures(self, n: int = 20) -> list[ReplayEntry]:
        """Gets recent failed entries."""
        with self._lock:
            entries = list(self._buffer)
        return [e for e in entries if not e.succeeded][-n:]

    def by_tool(self, tool: str, n: int = 20) -> list[ReplayEntry]:
        """Gets entries filtered by tool name."""
        with self._lock:
            entries = list(self._buffer)
        return [e for e in entries if e.tool == tool][-n:]

    def by_turn(self, turn: int) -> list[ReplayEntry]:
        """Gets entries from a specific turn."""
        with self._lock:
            entries = list(self._buffer)
        return [e for e in entries if e.turn_index == turn]

    def summary(self) -> dict:
        """Aggregates execution stats across entries."""
        with self._lock:
            entries = list(self._buffer)
        if not entries:
            return {"total": 0}

        tools = {}
        total_ms = 0
        failures = 0
        for e in entries:
            if e.tool not in tools:
                tools[e.tool] = {"calls": 0, "failures": 0, "total_ms": 0}
            tools[e.tool]["calls"] += 1
            tools[e.tool]["total_ms"] += e.duration_ms
            if not e.succeeded:
                tools[e.tool]["failures"] += 1
                failures += 1
            total_ms += e.duration_ms

        return {
            "total": len(entries),
            "failures": failures,
            "total_ms": round(total_ms, 1),
            "turns": self._turn_index,
            "tools": tools,
        }

    def clear(self):
        """Clears all recorded entries."""
        with self._lock:
            self._buffer.clear()
        with self._turn_lock:
            self._turn_index = 0

    def save_to_disk(self, path: Optional[str] = None) -> str:
        """Saves replay logs to disk."""
        if path is None:
            base = os.environ.get("PROXIMA_DATA_DIR") or os.path.join(
                os.path.expanduser("~"), ".proxima-agent"
            )
            os.makedirs(base, exist_ok=True)
            ts = time.strftime("%Y%m%d_%H%M%S")
            path = os.path.join(base, f"replay_{ts}.json")

        with self._lock:
            entries = list(self._buffer)

        data = {
            "recorded_at": time.time(),
            "turns": self._turn_index,
            "entries": [e.to_dict() for e in entries],
            "summary": self.summary(),
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return path


class _RecordContext:
    """Context manager returned by recorder.record()."""

    def __init__(self, recorder: ExecutionRecorder, tool: str,
                 args_summary: str, security_level: int):
        self._recorder = recorder
        self._tool = tool
        self._args = args_summary
        self._level = security_level
        self._result_preview = ""
        self._start = 0.0

    def set_result(self, result: Any):
        """Sets result preview in recording context."""
        self._result_preview = _truncate(repr(result), 200)

    def __enter__(self):
        self._start = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        duration = (time.perf_counter() - self._start) * 1000
        error_str = str(exc_val) if exc_val else ""
        error_trace = ""
        if exc_val:
            error_trace = "\n".join(
                traceback.format_exception(exc_type, exc_val, exc_tb)[-3:]
            )

        entry = ReplayEntry(
            tool=self._tool,
            args_summary=_truncate(self._args, 150),
            started_at=time.time(),
            duration_ms=duration,
            succeeded=exc_val is None,
            result_preview=self._result_preview,
            error=error_str,
            error_trace=error_trace,
            security_level=self._level,
            turn_index=self._recorder.turn,
        )
        self._recorder._append(entry)
        return False


def _truncate(s: str, max_len: int) -> str:
    """Truncates string to max length limit."""
    if len(s) <= max_len:
        return s
    return s[:max_len - 3] + "..."


recorder = ExecutionRecorder()
