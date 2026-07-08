"""Tests for proxima_agent.brain.bucket — task lifecycle tracking.

Pure in-memory state machine: Bucket / StepDetail / BucketManager. Verified the
lifecycle transitions, step registration + confidence roll-up, context summary,
and the manager's auto-abandon of a still-active bucket when a new one starts.
"""
import unittest

from proxima_agent.brain.bucket import (
    Bucket, BucketStatus, BucketManager, StepDetail, Confidence,
)


class TestStepDetail(unittest.TestCase):
    def test_mark_running_increments_attempts(self):
        s = StepDetail("login")
        s.mark_running()
        s.mark_running()
        self.assertEqual(s.attempts, 2)
        self.assertEqual(s.status, "running")

    def test_mark_done_sets_confidence_by_verification(self):
        s = StepDetail("x")
        s.mark_done(verified=True)
        self.assertEqual(s.confidence, Confidence.HIGH)
        s2 = StepDetail("y")
        s2.mark_done(verified=False)
        self.assertEqual(s2.confidence, Confidence.LOW)

    def test_mark_failed_truncates_error(self):
        s = StepDetail("z")
        s.mark_failed("e" * 300)
        self.assertEqual(s.status, "failed")
        self.assertLessEqual(len(s.last_error), 120)


class TestBucketLifecycle(unittest.TestCase):
    def test_micro_task_flow_to_done(self):
        b = Bucket("send email")
        self.assertEqual(b.status, BucketStatus.IDLE)
        b.start_ready()
        self.assertEqual(b.status, BucketStatus.READY)
        b.start_executing()
        self.assertEqual(b.status, BucketStatus.EXECUTING)
        b.start_verifying()
        self.assertEqual(b.status, BucketStatus.VERIFYING)
        b.mark_done("looks good")
        self.assertEqual(b.status, BucketStatus.DONE)
        self.assertEqual(b.confidence, Confidence.VERIFIED)
        self.assertTrue(b.is_complete)
        self.assertFalse(b.is_active)

    def test_set_step_transitions_planning_to_executing(self):
        b = Bucket("task")
        b.start_planning()
        b.set_step(1, 3)
        self.assertEqual(b.status, BucketStatus.EXECUTING)
        self.assertEqual(b.current_step, 1)
        self.assertEqual(b.total_steps, 3)

    def test_register_and_update_steps_roll_up_confidence(self):
        b = Bucket("task")
        b.register_step("step one")
        b.register_step("step two")
        self.assertEqual(b.total_steps, 2)
        b.update_current_step("step one", success=True, verified=True)
        b.update_current_step("step two", success=True, verified=True)
        # All done steps verified → bucket confidence HIGH.
        self.assertEqual(b.confidence, Confidence.HIGH)
        self.assertEqual(b.current_step, 2)

    def test_failed_step_increments_retry_count(self):
        b = Bucket("task")
        b.update_current_step("flaky", success=False, error="boom")
        self.assertEqual(b.retry_count, 1)

    def test_mark_failed_records_error(self):
        b = Bucket("task")
        b.mark_failed("network down")
        self.assertEqual(b.status, BucketStatus.FAILED)
        self.assertEqual(b.error, "network down")
        self.assertTrue(b.is_complete)

    def test_context_summary_includes_task_and_status(self):
        b = Bucket("do the thing")
        b.start_executing()
        summary = b.context_summary()
        self.assertIn("do the thing", summary)
        self.assertIn("EXECUTING", summary)


class TestBucketManager(unittest.TestCase):
    def test_new_bucket_becomes_current(self):
        m = BucketManager()
        b = m.new_bucket("first task")
        self.assertIs(m.current, b)
        self.assertTrue(m.has_active_bucket is False)  # IDLE is not active yet

    def test_new_bucket_abandons_previous_active_one(self):
        m = BucketManager()
        first = m.new_bucket("first")
        first.start_executing()  # now active
        m.new_bucket("second")
        self.assertEqual(first.status, BucketStatus.ABANDONED)

    def test_completed_and_failed_tallies(self):
        m = BucketManager()
        b1 = m.new_bucket("a"); b1.start_ready(); b1.mark_done()
        b2 = m.new_bucket("b"); b2.start_ready(); b2.mark_failed("x")
        self.assertEqual(m.total_completed, 1)
        self.assertEqual(m.total_failed, 1)

    def test_reset_clears_all(self):
        m = BucketManager()
        m.new_bucket("a")
        m.reset()
        self.assertIsNone(m.current)
        self.assertEqual(len(m.buckets), 0)

    def test_get_context_empty_when_no_bucket(self):
        self.assertEqual(BucketManager().get_context(), "")


if __name__ == "__main__":
    unittest.main()
