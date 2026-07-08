"""Tests for proxima_agent.brain.planner — plan parsing + Plan/PlanStep model.

parse_plan_from_text must accept genuine action plans and REJECT numbered data
listings (file names, search results), which is the tricky discriminator. Also
covers the Plan model's progress/completion/failure properties.
"""
import unittest

from proxima_agent.brain.planner import (
    Plan, PlanStep, StepStatus, parse_plan_from_text,
)


class TestPlanModel(unittest.TestCase):
    def test_add_step_and_current_step(self):
        p = Plan(task="do stuff")
        s1 = p.add_step("open app")
        p.add_step("click button")
        self.assertEqual(s1.index, 1)
        self.assertIs(p.current_step, s1)  # first pending

    def test_completion_and_progress(self):
        p = Plan(task="t")
        a = p.add_step("a"); b = p.add_step("b")
        self.assertFalse(p.is_complete)
        a.status = StepStatus.DONE
        b.status = StepStatus.DONE
        self.assertTrue(p.is_complete)
        self.assertEqual(p.progress_text, "2/2 steps done")

    def test_failure_tracking(self):
        p = Plan(task="t")
        s = p.add_step("risky")
        s.status = StepStatus.FAILED
        s.error = "boom"
        self.assertTrue(p.has_failures)
        self.assertEqual(p.failed_steps(), [s])


class TestParsePlan(unittest.TestCase):
    def test_parses_plan_with_explicit_header(self):
        text = (
            "PLAN:\n"
            "1. Open Gmail compose\n"
            "2. Fill the To field\n"
            "3. Send the email\n"
            "VERIFY: check the sent folder"
        )
        plan = parse_plan_from_text(text, task="send email")
        self.assertIsNotNone(plan)
        self.assertEqual(len(plan.steps), 3)
        self.assertIn("sent folder", plan.verification)

    def test_parses_plan_by_action_verbs_without_header(self):
        text = (
            "1. Open the settings page\n"
            "2. Click the save button\n"
            "3. Verify the change persisted\n"
        )
        plan = parse_plan_from_text(text, task="settings")
        self.assertIsNotNone(plan)
        self.assertEqual(len(plan.steps), 3)

    def test_rejects_numbered_data_listing(self):
        # A file listing has numbers but no plan header and no action verbs.
        text = "1. report.pdf\n2. notes.txt\n3. data.csv\n4. image.png"
        self.assertIsNone(parse_plan_from_text(text, task="list"))

    def test_rejects_fewer_than_two_steps(self):
        self.assertIsNone(parse_plan_from_text("PLAN:\n1. Only one step", task="t"))

    def test_empty_text_returns_none(self):
        self.assertIsNone(parse_plan_from_text("", task="t"))


if __name__ == "__main__":
    unittest.main()
