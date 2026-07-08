"""Tests for proxima_agent.brain.tracker — execution tracking across turns.

Covers the '# step:' marker detection that separates real plan steps from
background work, the step/success/failure counters, consecutive-failure
tracking (the loop's hard stop), verification gating, and the recovery-lesson
detector (fail→success on the same step = the keystone of learning memory).
"""
import unittest

from proxima_agent.brain.tracker import Tracker, _extract_step_marker, _extract_terminal_markers


class TestStepMarker(unittest.TestCase):
    def test_extracts_step_name_from_first_line(self):
        self.assertEqual(_extract_step_marker("# step: Login to Gmail\nimport os"), "Login to Gmail")

    def test_background_code_has_no_marker(self):
        self.assertEqual(_extract_step_marker("import os\nos.listdir('.')"), "")


class TestTrackerRecording(unittest.TestCase):
    def test_step_marked_code_counts_as_step(self):
        t = Tracker()
        t.record_execution("# step: Do X\ncode()", "do x", "ok", success=True)
        self.assertEqual(t.step_count, 1)
        self.assertEqual(t.success_count, 1)
        self.assertTrue(t.last_execution.is_step)
        self.assertEqual(t.last_execution.step_name, "Do X")

    def test_background_execution_not_counted_as_step(self):
        t = Tracker()
        t.record_execution("print('bg')", "background", "ok", success=True)
        self.assertEqual(t.step_count, 0)
        self.assertTrue(t.has_work_done)  # falls back to raw success

    def test_failure_counters(self):
        t = Tracker()
        t.record_execution("# step: A\nx()", "a", "err", success=False)
        t.record_execution("# step: B\ny()", "b", "err", success=False)
        self.assertEqual(t.failure_count, 2)
        self.assertEqual(t.consecutive_failures, 2)

    def test_consecutive_failures_reset_by_success(self):
        t = Tracker()
        t.record_execution("a()", "a", "err", success=False)
        t.record_execution("b()", "b", "ok", success=True)
        self.assertEqual(t.consecutive_failures, 0)

    def test_needs_verification_after_three_steps(self):
        t = Tracker()
        for i in range(3):
            t.record_execution(f"# step: S{i}\nc()", f"s{i}", "ok", success=True)
        self.assertTrue(t.needs_verification)
        t.mark_verified()
        self.assertFalse(t.needs_verification)

    def test_reset_clears_state(self):
        t = Tracker()
        t.record_execution("# step: X\nc()", "x", "ok", success=True)
        t.reset()
        self.assertEqual(t.step_count, 0)
        self.assertEqual(len(t.executions), 0)


class TestRecoveryLesson(unittest.TestCase):
    def test_detects_fail_then_success_on_same_step(self):
        t = Tracker()
        t.record_execution("# step: Login\nbad_approach()", "login", "failed", success=False)
        t.record_execution("# step: Login\ngood_approach()", "login", "ok", success=True)
        lesson = t.detect_recovery_lesson()
        self.assertIsNotNone(lesson)
        self.assertEqual(lesson["goal"], "Login")
        self.assertIn("good_approach", lesson["worked"])
        self.assertIn("bad_approach", lesson["failed"])

    def test_no_lesson_on_first_try_success(self):
        t = Tracker()
        t.record_execution("# step: Login\ngood()", "login", "ok", success=True)
        self.assertIsNone(t.detect_recovery_lesson())


class TestVerifyMarkers(unittest.TestCase):
    """Terminal VERIFY/TASK markers must survive result[:500] truncation.

    verify() prints its marker at the END of a step's output, so a step that
    prints a lot before verifying pushes the marker past the 500-char display
    cut. record_execution captures the markers from the FULL output into the
    dedicated (untruncated) verify_markers field the outcome readers use.
    """

    def test_extract_terminal_markers_picks_only_marker_lines(self):
        text = "line one\nVERIFY:PASS\nnoise\nTASK:GAVE_UP\n"
        self.assertEqual(_extract_terminal_markers(text), "VERIFY:PASS\nTASK:GAVE_UP")

    def test_extract_terminal_markers_empty_when_absent(self):
        self.assertEqual(_extract_terminal_markers("just some output\nno markers"), "")

    def test_marker_survives_when_result_is_truncated(self):
        t = Tracker()
        long_output = ("x" * 2000) + "\nVERIFY:PASS"
        t.record_execution("# step: do it\ncode()", "do it", long_output, success=True)
        rec = t.last_execution
        # Display result is truncated and no longer contains the marker...
        self.assertEqual(len(rec.result), 500)
        self.assertNotIn("VERIFY:PASS", rec.result)
        # ...but the dedicated field preserves it verbatim.
        self.assertEqual(rec.verify_markers, "VERIFY:PASS")

    def test_no_markers_leaves_field_empty(self):
        t = Tracker()
        t.record_execution("print('hi')", "bg", "plain output", success=True)
        self.assertEqual(t.last_execution.verify_markers, "")


if __name__ == "__main__":
    unittest.main()
