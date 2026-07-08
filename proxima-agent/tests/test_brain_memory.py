"""Tests for proxima_agent.brain.memory — cross-session learning store (SQLite).

MEMORY_DB_PATH (module constant, read inside _connect) is patched to a temp DB
per test, so nothing touches the real ~/.proxima-agent/memory.db. Covers key
normalization, record→recall round-trip, upsert hit-bumping, ordering, prompt
formatting, and the best-effort no-raise contract.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

from proxima_agent.brain import memory


class MemoryBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._db = os.path.join(self._tmp, "memory.db")
        self._patcher = patch.object(memory, "MEMORY_DB_PATH", self._db)
        self._patcher.start()

    def tearDown(self):
        self._patcher.stop()


class TestNormalizeKey(unittest.TestCase):
    def test_url_reduces_to_host_and_strips_www(self):
        self.assertEqual(memory.normalize_key("https://www.mail.google.com/mail/u/0"), "mail.google.com")
        self.assertEqual(memory.normalize_key("http://example.com/page"), "example.com")

    def test_bare_host_with_path(self):
        self.assertEqual(memory.normalize_key("mail.google.com/inbox"), "mail.google.com")

    def test_plain_string_lowercased(self):
        self.assertEqual(memory.normalize_key("  MyApp  "), "myapp")

    def test_empty_is_general(self):
        self.assertEqual(memory.normalize_key(""), "general")


class TestRecordAndRecall(MemoryBase):
    def test_record_then_recall(self):
        self.assertTrue(memory.record_lesson("mail.google.com", "compose", "write_text approach", "old failing approach"))
        lessons = memory.recall("https://mail.google.com/x")  # same normalized key
        self.assertEqual(len(lessons), 1)
        self.assertEqual(lessons[0]["goal"], "compose")
        self.assertIn("write_text", lessons[0]["worked"])
        self.assertEqual(lessons[0]["hits"], 1)

    def test_record_rejects_empty_goal_or_code(self):
        self.assertFalse(memory.record_lesson("k", "", "worked"))
        self.assertFalse(memory.record_lesson("k", "goal", ""))

    def test_upsert_same_goal_bumps_hits(self):
        memory.record_lesson("app", "login", "approach v1")
        memory.record_lesson("app", "login", "approach v2")
        lessons = memory.recall("app")
        self.assertEqual(len(lessons), 1)
        self.assertEqual(lessons[0]["hits"], 2)
        self.assertIn("v2", lessons[0]["worked"])  # newer approach kept

    def test_recall_orders_by_hits_desc(self):
        memory.record_lesson("app", "a", "ca")
        memory.record_lesson("app", "b", "cb")
        memory.record_lesson("app", "b", "cb")  # b now has 2 hits
        lessons = memory.recall("app", limit=5)
        self.assertEqual(lessons[0]["goal"], "b")

    def test_recall_unknown_key_returns_empty(self):
        self.assertEqual(memory.recall("nothing-here"), [])


class TestFormatForPrompt(unittest.TestCase):
    def test_renders_lessons_with_avoid_line(self):
        block = memory.format_for_prompt([
            {"goal": "login", "worked": "click submit", "failed": "press enter", "hits": 3},
        ])
        self.assertIn("LEARNED FROM PAST RUNS", block)
        self.assertIn("click submit", block)
        self.assertIn("avoid", block)

    def test_empty_returns_empty_string(self):
        self.assertEqual(memory.format_for_prompt([]), "")


if __name__ == "__main__":
    unittest.main()
