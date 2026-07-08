"""Tests for proxima_agent.brain.verifier — evidence-based verification prompts.

Pure prompt builders + a thin delegation to the tracker / output parser. Uses a
real Tracker/Plan to drive the branches (plan-present vs. execution-history).
"""
import unittest

from proxima_agent.brain import verifier
from proxima_agent.brain.tracker import Tracker
from proxima_agent.brain.planner import Plan


class TestBuildVerificationPrompt(unittest.TestCase):
    def test_uses_plan_steps_when_a_plan_exists(self):
        t = Tracker()
        plan = Plan(task="send email")
        plan.add_step("open compose")
        plan.verification = "email in Sent folder"
        t.set_plan(plan)
        prompt = verifier.build_verification_prompt(t)
        self.assertIn("EVIDENCE-BASED VERIFICATION", prompt)
        self.assertIn("open compose", prompt)
        self.assertIn("email in Sent folder", prompt)

    def test_falls_back_to_execution_history_without_a_plan(self):
        t = Tracker()
        t.record_execution("# step: A\nc()", "did A", "ok", success=True)
        prompt = verifier.build_verification_prompt(t)
        self.assertIn("did A", prompt)
        # Always advertises the cheap-first evidence ranking.
        self.assertIn("cheapest first", prompt.lower())


class TestBuildFixPrompt(unittest.TestCase):
    def test_names_issue_and_lists_completed_work(self):
        t = Tracker()
        t.record_execution("# step: setup\nc()", "setup done", "ok", success=True)
        prompt = verifier.build_fix_prompt(t, issue="file missing")
        self.assertIn("FIX REQUIRED", prompt)
        self.assertIn("file missing", prompt)
        self.assertIn("setup done", prompt)
        self.assertIn("DO NOT restart", prompt)


class TestShouldVerify(unittest.TestCase):
    def test_delegates_to_tracker_needs_verification(self):
        t = Tracker()
        self.assertFalse(verifier.should_verify(t))
        for i in range(3):
            t.record_execution(f"# step: S{i}\nc()", f"s{i}", "ok", success=True)
        self.assertTrue(verifier.should_verify(t))


class TestProcessVerificationResult(unittest.TestCase):
    def test_pass_marker(self):
        r = verifier.process_verification_result("output\nVERIFY:PASS")
        self.assertTrue(r["verified"])
        self.assertEqual(r["status"], "PASS")
        self.assertEqual(r["issues"], [])

    def test_fail_marker_collects_issue(self):
        r = verifier.process_verification_result("VERIFY:FAIL:missing file")
        self.assertFalse(r["verified"])
        self.assertEqual(r["status"], "FAIL")
        self.assertEqual(r["issues"], ["missing file"])

    def test_no_marker_is_none_status(self):
        r = verifier.process_verification_result("plain output")
        self.assertEqual(r["status"], "NONE")
        self.assertFalse(r["verified"])


if __name__ == "__main__":
    unittest.main()
