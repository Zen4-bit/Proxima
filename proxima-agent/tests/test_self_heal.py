"""Tests for proxima_agent.tools.self_heal — decide/recover/learn engine.

The collaborators (learned_fixes store, retry_engine, recorder) are patched at
the module so no disk writes or real retries happen. Focus is the DECISION
logic: success fast-path, the non-idempotent safety gate, safe-class auto-retry,
learning on recovery, and confidence updates on a known-fix outcome.
"""
import unittest
from unittest.mock import patch, MagicMock

from proxima_agent.tools.self_heal import SelfHealingEngine


def _retry_result(succeeded=True, value="ok", attempts=2):
    r = MagicMock()
    r.succeeded = succeeded
    r.value = value
    r.attempts = attempts
    return r


class SelfHealBase(unittest.TestCase):
    def setUp(self):
        self.engine = SelfHealingEngine()
        # Patch module-level singletons the engine reaches into.
        self.lf = patch("proxima_agent.tools.self_heal.learned_fixes").start()
        self.re = patch("proxima_agent.tools.self_heal.retry_engine").start()
        self.rec = patch("proxima_agent.tools.self_heal.recorder").start()
        self.lf.lookup.return_value = None
        self.lf.all.return_value = []
        self.re.get_policy.return_value = None
        self.addCleanup(patch.stopall)


class TestExecute(SelfHealBase):
    def test_success_first_try_no_recovery(self):
        res = self.engine.execute(lambda: 42, tool="shell")
        self.assertTrue(res.succeeded)
        self.assertFalse(res.fix_applied)
        self.assertEqual(res.value, 42)
        self.re.execute.assert_not_called()

    def test_non_idempotent_unsafe_failure_skips_retry(self):
        def boom():
            raise RuntimeError("some weird thing")  # → 'unknown', not safe
        res = self.engine.execute(boom, tool="browser", idempotent=False)
        self.assertFalse(res.succeeded)
        self.assertFalse(res.fix_applied)
        self.assertIn("skipped auto-retry", res.recovery_action)
        self.re.execute.assert_not_called()

    def test_safe_failure_class_auto_retries_and_learns(self):
        def boom():
            raise ConnectionError("connection refused")  # → connection_failed (SAFE)
        self.re.execute.return_value = _retry_result(succeeded=True)
        res = self.engine.execute(boom, tool="browser", idempotent=False)
        self.assertTrue(res.succeeded)
        self.assertEqual(res.failure_class, "connection_failed")
        self.assertTrue(res.learned)  # first-time recovery recorded
        self.lf.record_success.assert_called_once()

    def test_idempotent_forces_retry_even_for_unsafe_class(self):
        def boom():
            raise RuntimeError("some weird thing")  # unknown class
        self.re.execute.return_value = _retry_result(succeeded=True)
        res = self.engine.execute(boom, tool="shell", idempotent=True)
        self.assertTrue(res.succeeded)
        self.re.execute.assert_called_once()

    def test_known_fix_updates_confidence_on_success(self):
        known = MagicMock()
        known.recovery_action = "wait + retry"
        self.lf.lookup.return_value = known
        self.re.execute.return_value = _retry_result(succeeded=True)

        def boom():
            raise ConnectionError("connection refused")
        res = self.engine.execute(boom, tool="browser")
        self.assertTrue(res.succeeded)
        self.assertTrue(res.fix_applied)
        self.assertFalse(res.learned)  # existing fix, not newly learned
        self.lf.update_outcome.assert_called_with("connection_failed", "browser", success=True)

    def test_retry_failure_reports_unsuccessful(self):
        self.re.execute.return_value = _retry_result(succeeded=False)

        def boom():
            raise ConnectionError("connection refused")
        res = self.engine.execute(boom, tool="browser")
        self.assertFalse(res.succeeded)
        self.assertEqual(res.failure_class, "connection_failed")


class TestStats(SelfHealBase):
    def test_stats_track_attempts_and_rate(self):
        self.re.execute.return_value = _retry_result(succeeded=True)
        self.engine.execute(lambda: (_ for _ in ()).throw(ConnectionError("connection refused")),
                            tool="browser")
        s = self.engine.stats()
        self.assertEqual(s["attempted"], 1)
        self.assertEqual(s["succeeded"], 1)
        self.assertEqual(s["heal_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
