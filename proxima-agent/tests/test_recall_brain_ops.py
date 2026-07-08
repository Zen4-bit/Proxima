"""Tests for proxima_agent.recall.brain_ops — Python↔Node brain REST bridge.

The HTTP boundary (_post/_get/_delete) is patched so no real network call is
made. We verify each public helper maps the API response into the right
user-facing string, and surfaces errors instead of pretending success.
"""
import unittest
from unittest.mock import patch

from proxima_agent.recall import brain_ops


class TestRemember(unittest.TestCase):
    def test_success_message(self):
        with patch.object(brain_ops, "_post", return_value={"success": True}):
            self.assertIn("Remembered", brain_ops.remember("k", "fact"))

    def test_failure_surfaces_error(self):
        with patch.object(brain_ops, "_post", return_value={"error": "bad key"}):
            out = brain_ops.remember("k", "fact")
            self.assertIn("Failed", out)
            self.assertIn("bad key", out)


class TestForget(unittest.TestCase):
    def test_success(self):
        with patch.object(brain_ops, "_delete", return_value={"success": True}):
            self.assertIn("Forgot", brain_ops.forget("k"))

    def test_failure(self):
        with patch.object(brain_ops, "_delete", return_value={"error": "not found"}):
            self.assertIn("Failed", brain_ops.forget("k"))


class TestMemories(unittest.TestCase):
    def test_empty(self):
        with patch.object(brain_ops, "_get", return_value={"facts": []}):
            self.assertEqual(brain_ops.memories(), "No memories stored.")

    def test_lists_and_filters_by_category(self):
        facts = {"facts": [
            {"key": "a", "text": "fact a", "confidence": 0.9, "category": "preference"},
            {"key": "b", "text": "fact b", "confidence": 0.8, "category": "project"},
        ]}
        with patch.object(brain_ops, "_get", return_value=facts):
            out = brain_ops.memories(category="preference")
            self.assertIn("fact a", out)
            self.assertNotIn("fact b", out)


class TestLearnFix(unittest.TestCase):
    def test_success(self):
        with patch.object(brain_ops, "_post", return_value={"success": True}):
            self.assertIn("Learned fix", brain_ops.learn_fix("err desc", "the fix"))

    def test_failure(self):
        with patch.object(brain_ops, "_post", return_value={"error": "nope"}):
            self.assertIn("Failed", brain_ops.learn_fix("err", "fix"))


class TestSkills(unittest.TestCase):
    def test_save_skill_success(self):
        with patch.object(brain_ops, "_post", return_value={"success": True}):
            self.assertIn("Saved skill", brain_ops.save_skill("n", "d", ["t"], "steps"))

    def test_list_skills_empty_and_populated(self):
        with patch.object(brain_ops, "_get", return_value={"skills": []}):
            self.assertEqual(brain_ops.list_skills(), "No skills saved.")
        with patch.object(brain_ops, "_get", return_value={"skills": [
            {"name": "deploy", "description": "deploy app", "tags": ["ci"]},
        ]}):
            out = brain_ops.list_skills()
            self.assertIn("deploy", out)
            self.assertIn("ci", out)


class TestBrainStats(unittest.TestCase):
    def test_formats_all_sections(self):
        data = {
            "recall": {"active": 5, "pending": 1},
            "experience": {"total": 3, "candidates": 2},
            "skills": {"total": 4},
        }
        with patch.object(brain_ops, "_get", return_value=data):
            out = brain_ops.brain_stats()
            self.assertIn("5 facts", out)
            self.assertIn("3 entries", out)
            self.assertIn("4 saved", out)


if __name__ == "__main__":
    unittest.main()
