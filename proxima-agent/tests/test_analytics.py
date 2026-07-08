"""Tests for proxima_agent.tools.analytics — failure pattern detection.

classify_failure is pure. FailureAnalytics reads from an ExecutionRecorder-like
source, which we fake with lightweight entry objects — no real recorder or
execution needed.
"""
import unittest

from proxima_agent.tools.analytics import classify_failure, FailureAnalytics


class _Entry:
    """Minimal ReplayEntry stand-in with the attributes analytics reads."""
    def __init__(self, tool, error="", turn_index=1, started_at=0.0, succeeded=False):
        self.tool = tool
        self.error = error
        self.turn_index = turn_index
        self.started_at = started_at
        self.succeeded = succeeded


class _FakeRecorder:
    def __init__(self, failures, summary=None, by_turn=None):
        self._failures = failures
        self._summary = summary or {}
        self._by_turn = by_turn or {}

    def failures(self, n=10000):
        return self._failures

    def summary(self):
        return self._summary

    def by_turn(self, turn):
        return self._by_turn.get(turn, [])


class TestClassifyFailure(unittest.TestCase):
    def test_timeout(self):
        self.assertEqual(classify_failure("operation timed out after 5s"), "timeout")

    def test_element_not_found_beats_generic_not_found(self):
        # Specific pattern must win over generic "not found".
        self.assertEqual(classify_failure("element not found: #btn"), "element_not_found")

    def test_rate_limited(self):
        self.assertEqual(classify_failure("HTTP 429 too many requests"), "rate_limited")

    def test_permission_denied(self):
        self.assertEqual(classify_failure("permission denied"), "permission_denied")

    def test_unknown_and_empty(self):
        self.assertEqual(classify_failure("some weird thing"), "unknown")
        self.assertEqual(classify_failure(""), "unknown")


class TestFailureAnalytics(unittest.TestCase):
    def test_top_patterns_groups_and_ranks(self):
        entries = [
            _Entry("browser", "element not found", turn_index=1),
            _Entry("browser", "element not found again", turn_index=2),
            _Entry("shell", "timed out", turn_index=1),
        ]
        a = FailureAnalytics(source=_FakeRecorder(entries))
        patterns = a.top_patterns(n=5)
        self.assertEqual(patterns[0].tool, "browser")
        self.assertEqual(patterns[0].failure_class, "element_not_found")
        self.assertEqual(patterns[0].count, 2)
        self.assertEqual(patterns[0].turns_affected, 2)

    def test_failures_for_tool(self):
        entries = [
            _Entry("browser", "timed out"),
            _Entry("browser", "element not found"),
            _Entry("shell", "boom"),
        ]
        a = FailureAnalytics(source=_FakeRecorder(entries))
        res = a.failures_for("browser")
        self.assertEqual(res["total"], 2)
        self.assertIn("timeout", res["classes"])

    def test_failure_rate(self):
        summary = {"tools": {"browser": {"calls": 10, "failures": 3}}}
        a = FailureAnalytics(source=_FakeRecorder([], summary=summary))
        self.assertAlmostEqual(a.failure_rate()["browser"], 0.3, places=3)

    def test_correlated_failures(self):
        # browser+shell fail together in turns 1 and 2 → co-occurrence 2.
        entries = [
            _Entry("browser", "e", turn_index=1),
            _Entry("shell", "e", turn_index=1),
            _Entry("browser", "e", turn_index=2),
            _Entry("shell", "e", turn_index=2),
        ]
        a = FailureAnalytics(source=_FakeRecorder(entries))
        correlated = a.correlated_failures()
        self.assertTrue(any(set([c[0], c[1]]) == {"browser", "shell"} and c[2] == 2 for c in correlated))

    def test_report_no_data(self):
        a = FailureAnalytics(source=_FakeRecorder([], summary={"total": 0}))
        self.assertIn("No tool calls recorded", a.report())

    def test_report_with_data(self):
        entries = [_Entry("browser", "timed out", turn_index=1)]
        summary = {"total": 5, "failures": 1, "tools": {"browser": {"calls": 5, "failures": 1}}}
        a = FailureAnalytics(source=_FakeRecorder(entries, summary=summary))
        report = a.report()
        self.assertIn("Failure Analytics Report", report)
        self.assertIn("browser", report)


if __name__ == "__main__":
    unittest.main()
