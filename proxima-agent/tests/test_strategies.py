"""Tests for proxima_agent.recall.strategies — local strategy store + retriever.

Storage dir is redirected to a temp dir via PROXIMA_DATA_DIR (read at store
construction), so a fresh StrategyStore per test writes into isolation. Covers
save/update, keyword retrieval + scoring, EMA score updates, delete, and stats.
"""
import os
import tempfile
import unittest

from proxima_agent.recall.strategies import StrategyStore, KeywordRetriever, _make_id


class StrategyBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._prev = os.environ.get("PROXIMA_DATA_DIR")
        os.environ["PROXIMA_DATA_DIR"] = self._tmp
        self.store = StrategyStore()

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("PROXIMA_DATA_DIR", None)
        else:
            os.environ["PROXIMA_DATA_DIR"] = self._prev


class TestMakeId(unittest.TestCase):
    def test_deterministic_and_content_sensitive(self):
        a = _make_id("gmail", "steps")
        b = _make_id("gmail", "steps")
        c = _make_id("gmail", "other")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)


class TestKeywordRetriever(unittest.TestCase):
    def test_ranks_by_word_overlap_and_success_rate(self):
        r = KeywordRetriever()
        strategies = [
            {"trigger": "send gmail email", "tags": ["email"], "success_rate": 0.9, "last_used": 0},
            {"trigger": "delete files", "tags": ["fs"], "success_rate": 0.9, "last_used": 0},
        ]
        results = r.find("send email via gmail", strategies, top_k=3)
        self.assertGreaterEqual(len(results), 1)
        self.assertEqual(results[0]["trigger"], "send gmail email")

    def test_no_overlap_returns_empty(self):
        r = KeywordRetriever()
        results = r.find("xyz unrelated", [{"trigger": "compose email", "tags": []}], top_k=3)
        self.assertEqual(results, [])


class TestStrategyStore(StrategyBase):
    def test_save_then_find(self):
        self.store.save("gmail compose email", "elements -> write_text -> verify", tags=["email", "gmail"])
        matches = self.store.find("send email via gmail")
        self.assertGreaterEqual(len(matches), 1)
        self.assertIn("write_text", matches[0]["strategy"])

    def test_save_same_id_updates_use_count(self):
        sid = self.store.save("task x", "approach y")
        sid2 = self.store.save("task x", "approach y")
        self.assertEqual(sid, sid2)
        entry = next(s for s in self.store.all() if s["id"] == sid)
        self.assertEqual(entry["use_count"], 2)

    def test_update_score_uses_ema(self):
        sid = self.store.save("t", "a", success_rate=1.0)
        self.store.update_score(sid, success=False)
        entry = next(s for s in self.store.all() if s["id"] == sid)
        # EMA: 0.7*1.0 + 0.3*0.0 = 0.7
        self.assertAlmostEqual(entry["success_rate"], 0.7, places=3)

    def test_delete(self):
        sid = self.store.save("t", "a")
        self.assertTrue(self.store.delete(sid))
        self.assertFalse(self.store.delete(sid))  # already gone

    def test_stats(self):
        self.store.save("alpha task", "a", success_rate=0.8)
        self.store.save("beta task", "b", success_rate=0.6)
        s = self.store.stats()
        self.assertEqual(s["total"], 2)
        self.assertIn("avg_success_rate", s)

    def test_persists_across_new_store_instance(self):
        self.store.save("persist me", "the approach")
        # A brand-new store (same temp dir) must read the saved strategy.
        fresh = StrategyStore()
        self.assertGreaterEqual(len(fresh.all()), 1)


if __name__ == "__main__":
    unittest.main()
