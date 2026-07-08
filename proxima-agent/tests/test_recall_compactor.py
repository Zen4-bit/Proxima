"""Tests for proxima_agent.recall.compactor — context window management.

The LLM/vault-backed full-compaction path is exercised with mocks; the pure
helpers (_light_trim, _prune_tool_results, _repair_tool_pairs) and the
maybe_compact routing are tested directly. No real LLM or DB.
"""
import unittest
from unittest.mock import MagicMock

from proxima_agent.recall import compactor


class TestPruneToolResults(unittest.TestCase):
    def test_long_tool_output_compressed_to_summary(self):
        long = "line\n" * 400  # well over the 500-char cap
        msgs = [{"role": "tool", "content": long}]
        compactor._prune_tool_results(msgs)
        self.assertIn("[output:", msgs[0]["content"])
        self.assertLess(len(msgs[0]["content"]), len(long))

    def test_error_output_tagged_error(self):
        content = "Traceback (most recent call last):\n" + ("x\n" * 300)
        msgs = [{"role": "tool", "content": content}]
        compactor._prune_tool_results(msgs)
        self.assertIn("error", msgs[0]["content"])

    def test_short_tool_output_untouched(self):
        msgs = [{"role": "tool", "content": "short ok"}]
        compactor._prune_tool_results(msgs)
        self.assertEqual(msgs[0]["content"], "short ok")

    def test_non_tool_messages_ignored(self):
        msgs = [{"role": "assistant", "content": "x" * 1000}]
        compactor._prune_tool_results(msgs)
        self.assertEqual(len(msgs[0]["content"]), 1000)


class TestRepairToolPairs(unittest.TestCase):
    def test_drops_leading_orphan_tool_message(self):
        msgs = [{"role": "tool", "content": "orphan"}, {"role": "user", "content": "hi"}]
        compactor._repair_tool_pairs(msgs)
        self.assertEqual(msgs[0]["role"], "user")

    def test_drops_trailing_assistant_toolcall_without_reply(self):
        msgs = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "tool_calls": [{"id": "t1"}]},
        ]
        compactor._repair_tool_pairs(msgs)
        self.assertEqual(msgs[-1]["role"], "user")

    def test_preserves_intact_pair(self):
        msgs = [
            {"role": "assistant", "tool_calls": [{"id": "t1"}]},
            {"role": "tool", "tool_call_id": "t1", "content": "r"},
        ]
        compactor._repair_tool_pairs(msgs)
        self.assertEqual(len(msgs), 2)


class TestLightTrim(unittest.TestCase):
    def test_keeps_system_and_last_n(self):
        msgs = [{"role": "system", "content": "sys"}]
        msgs += [{"role": "user", "content": f"m{i}"} for i in range(40)]
        compactor._light_trim(msgs, max_msgs=10)
        self.assertEqual(msgs[0]["role"], "system")
        self.assertLessEqual(len(msgs), 11)
        # Most recent message survives.
        self.assertEqual(msgs[-1]["content"], "m39")

    def test_noop_when_under_limit(self):
        msgs = [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}]
        compactor._light_trim(msgs, max_msgs=30)
        self.assertEqual(len(msgs), 2)


class TestMaybeCompact(unittest.TestCase):
    def test_below_soft_threshold_is_noop(self):
        msgs = [{"role": "user", "content": "x"} for _ in range(5)]
        result = compactor.maybe_compact(msgs, vault=None, session_id=None, client=None,
                                         config={"compaction_threshold": 30})
        self.assertIsNone(result)
        self.assertEqual(len(msgs), 5)

    def test_above_soft_without_vault_light_trims(self):
        msgs = [{"role": "system", "content": "s"}]
        msgs += [{"role": "user", "content": f"m{i}"} for i in range(40)]
        result = compactor.maybe_compact(msgs, vault=None, session_id=None, client=None,
                                         config={"compaction_threshold": 10, "compaction_hard_threshold": 50})
        self.assertIsNone(result)  # no rollover without a vault
        self.assertLessEqual(len(msgs), 11)

    def test_full_compaction_rolls_over_with_vault_and_client(self):
        # Above the hard threshold with a working vault + client → rollover.
        msgs = [{"role": "system", "content": "s"}]
        msgs += [{"role": "user", "content": f"m{i}"} for i in range(60)]

        vault = MagicMock()
        vault.rollover_session.return_value = "new-sid-123"
        vault.append_messages_batch.return_value = 1

        client = MagicMock()
        client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(content="- summary bullet"))]
        )

        result = compactor.maybe_compact(
            msgs, vault=vault, session_id="old-sid", client=client,
            config={"compaction_threshold": 10, "compaction_hard_threshold": 50, "model": "auto"},
        )
        self.assertEqual(result, "new-sid-123")
        vault.rollover_session.assert_called_once()
        # The rebuilt context carries the injected summary handoff.
        self.assertTrue(any("CONTEXT FROM PREVIOUS TURNS" in (m.get("content") or "") for m in msgs))


if __name__ == "__main__":
    unittest.main()
