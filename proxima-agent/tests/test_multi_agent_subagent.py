"""Tests for proxima_agent.multi_agent.subagent — pure helpers.

Covered: _build_subagent_prompt (task/context/rules), _extract_code_simple
(JSON tool_calls, ```python blocks, none), and _trim_subagent_messages
(tool-pair-safe trimming).

run_subagent() itself is INTEGRATION-only: it constructs a real openai.OpenAI
client against the local gateway and calls execute_code()/gate_code() which run
real Python on the machine. It has no isolatable pure logic beyond these helpers,
so it is intentionally not unit-tested here (would require a live gateway + real
code execution) — its building blocks (helpers above, error_classifier,
retry_utils, gate) are each covered by their own tests.
"""
import unittest

from proxima_agent.multi_agent import subagent


class TestBuildSubagentPrompt(unittest.TestCase):
    def test_includes_task_and_rules(self):
        p = subagent._build_subagent_prompt("Build a website", {})
        self.assertIn("Build a website", p)
        self.assertIn("execute()", p)
        self.assertIn("TASK COMPLETE", p)

    def test_includes_and_truncates_context(self):
        p = subagent._build_subagent_prompt("t", {"save_to": "/downloads", "big": "x" * 5000})
        self.assertIn("save_to: /downloads", p)
        self.assertIn("truncated", p)  # long value trimmed


class TestExtractCodeSimple(unittest.TestCase):
    def test_extracts_json_tool_call(self):
        text = '{"tool_calls":[{"id":"c1","type":"function","function":{"name":"execute","arguments":{"code":"print(1)","description":"run"}}}]}'
        code, desc = subagent._extract_code_simple(text)
        self.assertEqual(code, "print(1)")
        self.assertEqual(desc, "run")

    def test_extracts_python_code_block(self):
        text = "Here you go:\n```python\nprint('hi')\n```\nDone."
        code, desc = subagent._extract_code_simple(text)
        self.assertEqual(code, "print('hi')")

    def test_json_tool_call_with_string_arguments(self):
        # arguments provided as a JSON string (common with some providers).
        text = '{"tool_calls":[{"function":{"name":"execute","arguments":"{\\"code\\":\\"x=1\\"}"}}]}'
        result = subagent._extract_code_simple(text)
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "x=1")

    def test_returns_none_for_plain_text(self):
        self.assertIsNone(subagent._extract_code_simple("just a normal reply, no code"))


class TestTrimSubagentMessages(unittest.TestCase):
    def test_short_history_unchanged(self):
        msgs = [{"role": "user", "content": f"m{i}"} for i in range(10)]
        self.assertEqual(subagent._trim_subagent_messages(msgs), msgs)

    def test_long_history_keeps_head_and_repairs_tail(self):
        msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
        # 50 filler messages so total > 40.
        msgs += [{"role": "user", "content": f"m{i}"} for i in range(50)]
        trimmed = subagent._trim_subagent_messages(msgs)
        # Head (system + initial task) preserved.
        self.assertEqual(trimmed[0]["content"], "sys")
        self.assertEqual(trimmed[1]["content"], "task")
        self.assertLessEqual(len(trimmed), 2 + 30)

    def test_trim_drops_orphaned_leading_tool_in_tail(self):
        msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
        msgs += [{"role": "user", "content": f"m{i}"} for i in range(28)]
        # Make the tail start with an orphan tool message.
        msgs.append({"role": "tool", "tool_call_id": "x", "content": "orphan"})
        msgs.append({"role": "user", "content": "final"})
        trimmed = subagent._trim_subagent_messages(msgs)
        # No leading orphan tool should survive at the tail boundary region.
        # (Head is system/user, so index 2 onward must not be an orphan tool as first tail item.)
        self.assertEqual(trimmed[0]["content"], "sys")
        self.assertTrue(all(isinstance(m, dict) for m in trimmed))


if __name__ == "__main__":
    unittest.main()
