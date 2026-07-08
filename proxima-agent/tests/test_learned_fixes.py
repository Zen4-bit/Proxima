"""Tests for proxima_agent.tools.learned_fixes — failure→recovery pattern store.

PROXIMA_DATA_DIR redirects storage to a temp dir. Covers the LearnedFix model
round-trip, record_success (create + EMA update), lookup (exact, fallback,
low-confidence exclusion), update_outcome, stats, and clear.
"""
import os
import tempfile
import unittest

from proxima_agent.tools.learned_fixes import LearnedFix, LearnedFixStore


class TestLearnedFixModel(unittest.TestCase):
    def test_dict_round_trip_and_key(self):
        fix = LearnedFix("element_not_found", "browser", "wait+retry", success_rate=0.8)
        d = fix.to_dict()
        back = LearnedFix.from_dict(d)
        self.assertEqual(back.recovery_action, "wait+retry")
        self.assertEqual(back.key, "element_not_found:browser")


class LearnedFixBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._prev = os.environ.get("PROXIMA_DATA_DIR")
        os.environ["PROXIMA_DATA_DIR"] = self._tmp
        self.store = LearnedFixStore()

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("PROXIMA_DATA_DIR", None)
        else:
            os.environ["PROXIMA_DATA_DIR"] = self._prev


class TestLearnedFixStore(LearnedFixBase):
    def test_record_success_then_lookup(self):
        self.store.record_success("timeout", "browser", "increase wait to 3s")
        fix = self.store.lookup("timeout", "browser")
        self.assertIsNotNone(fix)
        self.assertEqual(fix.recovery_action, "increase wait to 3s")

    def test_record_success_twice_bumps_use_count(self):
        self.store.record_success("timeout", "browser", "wait")
        self.store.record_success("timeout", "browser", "wait")
        self.assertEqual(self.store.lookup("timeout", "browser").use_count, 2)

    def test_update_outcome_lowers_confidence_and_lookup_excludes_low(self):
        self.store.record_success("flaky", "shell", "retry once")
        # Drive success_rate below the 0.3 lookup threshold with repeated failures.
        for _ in range(6):
            self.store.update_outcome("flaky", "shell", success=False)
        self.assertIsNone(self.store.lookup("flaky", "shell"),
                          "low-confidence fixes must not be suggested")

    def test_lookup_falls_back_to_any_tool_for_failure_class(self):
        self.store.record_success("net_error", "browser", "reconnect")
        # No tool specified → best match for the failure class.
        fix = self.store.lookup("net_error")
        self.assertIsNotNone(fix)
        self.assertEqual(fix.tool, "browser")

    def test_stats_and_clear(self):
        self.store.record_success("a", "t1", "fix a")
        self.store.record_success("b", "t2", "fix b")
        s = self.store.stats()
        self.assertEqual(s["total_fixes"], 2)
        self.store.clear()
        self.assertEqual(self.store.stats(), {"total": 0})

    def test_persists_across_instances(self):
        self.store.record_success("persist", "browser", "do the thing")
        fresh = LearnedFixStore()
        self.assertIsNotNone(fresh.lookup("persist", "browser"))


if __name__ == "__main__":
    unittest.main()
