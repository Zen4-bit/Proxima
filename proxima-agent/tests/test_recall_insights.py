"""Tests for proxima_agent.recall.insights — cross-session fact memory (SQLite).

INSIGHTS_DB_PATH is patched to a temp DB. The LLM extraction path uses a mock
client. Covers save/upsert, relevance-ranked retrieval, transcript building,
prompt formatting, clear, and the extract_and_save flow (incl. disabled config).
"""
import os
import tempfile
import unittest
from unittest.mock import patch, MagicMock

from proxima_agent.recall import insights as insights_mod
from proxima_agent.recall.insights import InsightStore


class InsightsBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._db = os.path.join(self._tmp, "insights.db")
        self._patcher = patch.object(insights_mod, "INSIGHTS_DB_PATH", self._db)
        self._patcher.start()
        self.store = InsightStore()

    def tearDown(self):
        self._patcher.stop()


class TestSaveAndRetrieve(InsightsBase):
    def test_save_facts_then_list(self):
        n = self.store._save_facts([
            {"category": "workspace", "key": "language", "value": "Python"},
            {"category": "user_pref", "key": "style", "value": "concise"},
        ], session_id="s1")
        self.assertEqual(n, 2)
        allf = self.store.list_all()
        self.assertEqual(len(allf), 2)

    def test_upsert_same_cat_key_bumps_hits(self):
        self.store._save_facts([{"category": "workspace", "key": "db", "value": "postgres"}], "s1")
        self.store._save_facts([{"category": "workspace", "key": "db", "value": "postgres 16"}], "s2")
        rows = self.store.list_all()
        db_row = next(r for r in rows if r["key"] == "db")
        self.assertEqual(db_row["hits"], 2)
        self.assertEqual(db_row["value"], "postgres 16")  # value updated

    def test_get_relevant_ranks_by_query_overlap(self):
        self.store._save_facts([
            {"category": "workspace", "key": "database", "value": "postgres"},
            {"category": "user_pref", "key": "greeting", "value": "namaste"},
        ], "s1")
        block = self.store.get_relevant(query="which database do we use", limit=1)
        self.assertIn("postgres", block)
        self.assertNotIn("namaste", block)

    def test_get_relevant_empty_when_no_insights(self):
        self.assertEqual(self.store.get_relevant("anything"), "")

    def test_clear(self):
        self.store._save_facts([{"category": "x", "key": "k", "value": "v"}], "s1")
        self.assertTrue(self.store.clear())
        self.assertEqual(self.store.list_all(), [])


class TestTranscriptAndFormat(InsightsBase):
    def test_build_transcript_skips_tool_and_system(self):
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
            {"role": "tool", "content": "toolout"},
            {"role": "assistant", "content": "hello"},
        ]
        t = self.store._build_transcript(msgs)
        self.assertIn("user: hi", t)
        self.assertIn("assistant: hello", t)
        self.assertNotIn("sys", t)
        self.assertNotIn("toolout", t)

    def test_format_for_prompt_groups_by_category(self):
        block = self.store._format_for_prompt([
            {"category": "workspace", "key": "lang", "value": "Py"},
        ])
        self.assertIn("USER CONTEXT", block)
        self.assertIn("Workspace", block)
        self.assertIn("lang", block)


class TestExtractAndSave(InsightsBase):
    def _client_returning(self, content):
        client = MagicMock()
        client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(content=content))]
        )
        return client

    def test_disabled_config_saves_nothing(self):
        client = self._client_returning("[]")
        n = self.store.extract_and_save(
            [{"role": "user", "content": "x" * 100}], "s1", client, {"insights_enabled": False})
        self.assertEqual(n, 0)
        client.chat.completions.create.assert_not_called()

    def test_extracts_and_saves_valid_json_facts(self):
        facts_json = '[{"category":"workspace","key":"stack","value":"Node.js"}]'
        client = self._client_returning(facts_json)
        transcript = "user: we use Node.js on the backend\nassistant: noted"
        msgs = [{"role": "user", "content": "we use Node.js on the backend for the api layer here"},
                {"role": "assistant", "content": "noted, Node.js backend"}]
        n = self.store.extract_and_save(msgs, "s1", client, {"insights_enabled": True, "model": "auto"})
        self.assertEqual(n, 1)
        self.assertTrue(any(r["value"] == "Node.js" for r in self.store.list_all()))

    def test_fenced_json_is_parsed(self):
        fenced = "```json\n[{\"category\":\"user_pref\",\"key\":\"lang\",\"value\":\"Hinglish\"}]\n```"
        client = self._client_returning(fenced)
        msgs = [{"role": "user", "content": "please reply in hinglish from now on always"},
                {"role": "assistant", "content": "sure, hinglish it is"}]
        n = self.store.extract_and_save(msgs, "s1", client, {"insights_enabled": True})
        self.assertEqual(n, 1)

    def test_invalid_json_yields_zero(self):
        client = self._client_returning("not json at all")
        msgs = [{"role": "user", "content": "some conversation text that is long enough to pass"},
                {"role": "assistant", "content": "a reply here that adds more characters"}]
        n = self.store.extract_and_save(msgs, "s1", client, {"insights_enabled": True})
        self.assertEqual(n, 0)


if __name__ == "__main__":
    unittest.main()
