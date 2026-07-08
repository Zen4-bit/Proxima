"""Tests for proxima_agent.recall.vault — SQLite conversation store.

VAULT_DB_PATH (module constant read inside _connect) is patched to a temp DB per
test. Covers session create/end/title, message append + retrieval, batch append,
search, rollover + lineage (incl. the compaction-boundary stop), and delete.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

from proxima_agent.recall import vault
from proxima_agent.recall.vault import ConversationVault


class VaultBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._db = os.path.join(self._tmp, "vault.db")
        self._patcher = patch.object(vault, "VAULT_DB_PATH", self._db)
        self._patcher.start()
        self.v = ConversationVault()

    def tearDown(self):
        self._patcher.stop()


class TestSessions(VaultBase):
    def test_create_and_get_session(self):
        sid = self.v.create_session(model="gemini", title="My Task")
        self.assertIsNotNone(sid)
        sess = self.v.get_session(sid)
        self.assertEqual(sess["model"], "gemini")
        self.assertEqual(sess["title"], "My Task")

    def test_end_session_sets_reason(self):
        sid = self.v.create_session()
        self.assertTrue(self.v.end_session(sid, reason="user_exit"))
        self.assertEqual(self.v.get_session(sid)["end_reason"], "user_exit")

    def test_update_title(self):
        sid = self.v.create_session(title="old")
        self.v.update_title(sid, "new title")
        self.assertEqual(self.v.get_session(sid)["title"], "new title")

    def test_list_sessions_newest_first(self):
        a = self.v.create_session(title="a")
        b = self.v.create_session(title="b")
        listed = self.v.list_sessions(limit=10)
        ids = [s["id"] for s in listed]
        self.assertLess(ids.index(b), ids.index(a))  # b (newer) before a


class TestMessages(VaultBase):
    def test_append_and_get_messages(self):
        sid = self.v.create_session()
        self.v.append_message(sid, {"role": "user", "content": "hi"})
        self.v.append_message(sid, {"role": "assistant", "content": "hello"})
        msgs = self.v.get_messages(sid)
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant"])
        self.assertEqual(msgs[0]["content"], "hi")
        # message_count bumped on the session row.
        self.assertEqual(self.v.get_session(sid)["message_count"], 2)

    def test_batch_append_preserves_tool_calls(self):
        sid = self.v.create_session()
        n = self.v.append_messages_batch(sid, [
            {"role": "assistant", "tool_calls": [{"id": "t1", "function": {"name": "x"}}]},
            {"role": "tool", "tool_call_id": "t1", "content": "result"},
        ])
        self.assertEqual(n, 2)
        msgs = self.v.get_messages(sid)
        self.assertEqual(msgs[0]["tool_calls"][0]["id"], "t1")
        self.assertEqual(msgs[1]["tool_call_id"], "t1")

    def test_search_messages(self):
        sid = self.v.create_session(title="s")
        self.v.append_message(sid, {"role": "user", "content": "deploy the vite app"})
        hits = self.v.search_messages("vite")
        self.assertGreaterEqual(len(hits), 1)
        self.assertIn("vite", hits[0]["content"])

    def test_delete_session_removes_messages(self):
        sid = self.v.create_session()
        self.v.append_message(sid, {"role": "user", "content": "x"})
        self.assertTrue(self.v.delete_session(sid))
        self.assertIsNone(self.v.get_session(sid))
        self.assertEqual(self.v.get_messages(sid), [])


class TestLineage(VaultBase):
    def test_ancestors_included_for_non_compacted_parent(self):
        parent = self.v.create_session(title="parent")
        self.v.append_message(parent, {"role": "user", "content": "parent msg"})
        child = self.v.create_session(title="child", parent_id=parent)
        self.v.append_message(child, {"role": "user", "content": "child msg"})
        msgs = self.v.get_messages(child, include_ancestors=True)
        contents = [m["content"] for m in msgs]
        self.assertEqual(contents, ["parent msg", "child msg"])  # root→current order

    def test_rollover_stops_lineage_at_compaction_boundary(self):
        parent = self.v.create_session(title="p")
        self.v.append_message(parent, {"role": "user", "content": "parent msg"})
        # rollover marks parent end_reason='compacted' and returns a linked child.
        child = self.v.rollover_session(parent)
        self.assertIsNotNone(child)
        self.v.append_message(child, {"role": "user", "content": "child msg"})
        msgs = self.v.get_messages(child, include_ancestors=True)
        # Parent was compacted → its raw messages must NOT be reloaded.
        self.assertEqual([m["content"] for m in msgs], ["child msg"])


if __name__ == "__main__":
    unittest.main()
