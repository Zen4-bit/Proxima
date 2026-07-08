"""Proxima — Failure Analytics.
Analyzes tool execution history to identify repeated failure classes and correlations.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Optional

from proxima_agent.tools.replay import ExecutionRecorder, ReplayEntry, recorder

_FAILURE_CLASS_PATTERNS = [
    (re.compile(r"timeout|timed?\s*out", re.I), "timeout"),
    (re.compile(r"connect|connection|refused|unreachable", re.I), "connection_failed"),
    (re.compile(r"disconnect|closed|broken.?pipe|eof", re.I), "disconnected"),
    (re.compile(r"element.*not|selector.*not|no.*element", re.I), "element_not_found"),
    (re.compile(r"stale|detach|execution context", re.I), "stale_reference"),
    (re.compile(r"verification|verify|mismatch|expected", re.I), "verification_failed"),
    (re.compile(r"rate.?limit|throttl|429|too many", re.I), "rate_limited"),
    (re.compile(r"permission|denied|forbidden|unauthorized", re.I), "permission_denied"),
    (re.compile(r"not found|no such|does not exist|missing", re.I), "not_found"),
    (re.compile(r"syntax|parse|invalid|malformed", re.I), "syntax_error"),
    (re.compile(r"import|module|attribute", re.I), "import_error"),
    (re.compile(r"memory|oom|out of memory", re.I), "memory_error"),
]


def classify_failure(error_str: str) -> str:
    """Classifies an error string into a failure category."""
    if not error_str:
        return "unknown"
    for pattern, failure_class in _FAILURE_CLASS_PATTERNS:
        if pattern.search(error_str):
            return failure_class
    return "unknown"


class FailurePattern:
    """Represents a unique tool and failure class combination."""

    __slots__ = (
        "tool", "failure_class", "count", "first_seen",
        "last_seen", "example_error", "affected_turns",
    )

    def __init__(self, tool: str, failure_class: str):
        self.tool = tool
        self.failure_class = failure_class
        self.count = 0
        self.first_seen = float("inf")
        self.last_seen = 0.0
        self.example_error = ""
        self.affected_turns: set[int] = set()

    def add(self, entry: ReplayEntry):
        """Adds a failure entry to the pattern."""
        self.count += 1
        self.first_seen = min(self.first_seen, entry.started_at)
        self.last_seen = max(self.last_seen, entry.started_at)
        if not self.example_error and entry.error:
            self.example_error = entry.error
        self.affected_turns.add(entry.turn_index)

    @property
    def turns_affected(self) -> int:
        return len(self.affected_turns)

    def __repr__(self) -> str:
        return (
            f"FailurePattern({self.tool}:{self.failure_class}, "
            f"count={self.count}, turns={self.turns_affected})"
        )


class FailureAnalytics:
    """Analyzes execution logs for failure patterns."""

    def __init__(self, source: Optional[ExecutionRecorder] = None):
        self._source = source or recorder

    def _get_failures(self) -> list[ReplayEntry]:
        """Gets all failure entries from the recorder."""
        return self._source.failures(n=10000)

    def top_patterns(self, n: int = 10) -> list[FailurePattern]:
        """Identifies the top failure patterns by count."""
        failures = self._get_failures()
        if not failures:
            return []

        patterns: dict[tuple[str, str], FailurePattern] = {}
        for entry in failures:
            fc = classify_failure(entry.error)
            key = (entry.tool, fc)
            if key not in patterns:
                patterns[key] = FailurePattern(entry.tool, fc)
            patterns[key].add(entry)

        ranked = sorted(patterns.values(), key=lambda p: p.count, reverse=True)
        return ranked[:n]

    def failures_for(self, tool: str) -> dict:
        """Retrieves failure statistics for a specific tool."""
        failures = self._get_failures()
        tool_failures = [e for e in failures if e.tool == tool]
        if not tool_failures:
            return {"tool": tool, "total": 0, "classes": {}}

        classes = Counter()
        for entry in tool_failures:
            classes[classify_failure(entry.error)] += 1

        return {
            "tool": tool,
            "total": len(tool_failures),
            "classes": dict(classes.most_common()),
        }

    def failure_rate(self) -> dict[str, float]:
        """Calculates failure rate for each tool."""
        summary = self._source.summary()
        if not summary.get("tools"):
            return {}

        rates = {}
        for tool, stats in summary["tools"].items():
            total = stats["calls"]
            fails = stats["failures"]
            if total > 0:
                rates[tool] = round(fails / total, 3)
        return rates

    def correlated_failures(self) -> list[tuple[str, str, int]]:
        """Identifies tools that tend to fail in the same turn."""
        failures = self._get_failures()
        if not failures:
            return []

        turns: dict[int, set[str]] = defaultdict(set)
        for entry in failures:
            turns[entry.turn_index].add(entry.tool)

        pairs = Counter()
        for tools_in_turn in turns.values():
            tool_list = sorted(tools_in_turn)
            for i in range(len(tool_list)):
                for j in range(i + 1, len(tool_list)):
                    pairs[(tool_list[i], tool_list[j])] += 1

        return [
            (a, b, count) for (a, b), count in pairs.most_common()
            if count > 1
        ]

    def trend(self, tool: Optional[str] = None,
              window: int = 5) -> list[dict]:
        """Analyzes failure rates across recent turns."""
        summary = self._source.summary()
        current_turn = summary.get("turns", 0)
        if current_turn == 0:
            return []

        results = []
        start_turn = max(1, current_turn - window + 1)
        for turn in range(start_turn, current_turn + 1):
            entries = self._source.by_turn(turn)
            if tool:
                entries = [e for e in entries if e.tool == tool]
            total = len(entries)
            fails = sum(1 for e in entries if not e.succeeded)
            results.append({
                "turn": turn,
                "total": total,
                "failures": fails,
                "rate": round(fails / total, 3) if total > 0 else 0.0,
            })
        return results

    def report(self) -> str:
        """Generates a failure analysis report string."""
        lines = ["=== Failure Analytics Report ===", ""]

        summary = self._source.summary()
        total = summary.get("total", 0)
        failures = summary.get("failures", 0)
        if total == 0:
            return "No tool calls recorded yet."

        rate = failures / total if total > 0 else 0
        lines.append(f"Total calls: {total}")
        lines.append(f"Total failures: {failures} ({rate:.1%})")
        lines.append("")

        patterns = self.top_patterns(5)
        if patterns:
            lines.append("Top Failure Patterns:")
            for p in patterns:
                lines.append(
                    f"  {p.tool}:{p.failure_class} — "
                    f"{p.count}x across {p.turns_affected} turns"
                )
                if p.example_error:
                    lines.append(f"    Example: {p.example_error[:100]}")
            lines.append("")

        rates = self.failure_rate()
        if rates:
            high_fail = {t: r for t, r in rates.items() if r > 0.3}
            if high_fail:
                lines.append("High Failure Rate Tools (>30%):")
                for tool, r in sorted(high_fail.items(),
                                      key=lambda x: x[1], reverse=True):
                    lines.append(f"  {tool}: {r:.1%}")
                lines.append("")

        correlated = self.correlated_failures()
        if correlated:
            lines.append("Correlated Failures (fail together):")
            for a, b, count in correlated[:3]:
                lines.append(f"  {a} + {b}: {count} turns")
            lines.append("")

        return "\n".join(lines)


analytics = FailureAnalytics()
