"""Tests for proxima_agent.permissions — criticality detection, SUGGEST parsing,
and the SMART/FULL_AUTO/SUGGEST permission gate.

No GUI/console I/O touched — a tiny fake console records prints and returns
scripted inputs, and the web-console path is exercised via request_approval /
request_suggest hooks.
"""
import unittest

from proxima_agent import permissions
from proxima_agent.permissions import PermissionMode


class FakeConsole:
    """Minimal Rich-console stand-in for the CLI paths."""
    def __init__(self, inputs=None):
        self._inputs = list(inputs or [])
        self.prints = []

    def print(self, *args, **kwargs):
        self.prints.append(" ".join(str(a) for a in args))

    def input(self, *_args, **_kwargs):
        if self._inputs:
            return self._inputs.pop(0)
        raise EOFError


class WebConsole:
    """Web-console stand-in exposing structured approval/suggest hooks."""
    def __init__(self, approval=True, suggest_choice=""):
        self._approval = approval
        self._suggest_choice = suggest_choice

    def request_approval(self, action, code, reasons):
        return self._approval

    def request_suggest(self, context, options):
        return self._suggest_choice


class TestIsCriticalAction(unittest.TestCase):
    def test_destructive_call_is_critical(self):
        crit, reasons = permissions.is_critical_action("shutil.rmtree('/data')")
        self.assertTrue(crit)
        self.assertTrue(any("rmtree" in r for r in reasons))

    def test_str_format_is_not_critical(self):
        # Regression: bare "format" must NOT fire on the ubiquitous str.format().
        crit, _ = permissions.is_critical_action('"{}".format(x)')
        self.assertFalse(crit)

    def test_word_boundary_avoids_false_positive_on_sender(self):
        # "send" (weight 2) must not match inside "sender"; alone it's under the
        # threshold of 3 anyway, so a lone benign word stays non-critical.
        crit, reasons = permissions.is_critical_action("sender = get_sender()")
        self.assertFalse(crit)

    def test_weights_accumulate_to_reach_threshold(self):
        # install (2) + login (1) = 3 → critical.
        crit, _ = permissions.is_critical_action("pip install pkg; login()")
        self.assertTrue(crit)


class TestDetectSuggestBlock(unittest.TestCase):
    def test_parses_context_and_options(self):
        text = (
            "Here is my plan.\n"
            "[SUGGEST]\n"
            "context: choose how to delete the files\n"
            "1. delete everything\n"
            "2. delete only logs\n"
            "3. ask first\n"
            "[/SUGGEST]\n"
            "trailing"
        )
        block = permissions.detect_suggest_block(text)
        self.assertIsNotNone(block)
        self.assertEqual(block["context"], "choose how to delete the files")
        self.assertEqual(len(block["options"]), 3)
        self.assertEqual(block["text_before"], "Here is my plan.")
        self.assertEqual(block["text_after"], "trailing")

    def test_returns_none_without_a_block(self):
        self.assertIsNone(permissions.detect_suggest_block("just a normal reply"))

    def test_returns_none_with_fewer_than_two_options(self):
        text = "[SUGGEST]\ncontext: x\n1. only one option\n[/SUGGEST]"
        self.assertIsNone(permissions.detect_suggest_block(text))


class TestCheckPermission(unittest.TestCase):
    def test_full_auto_always_approves(self):
        ok, mod = permissions.check_permission(
            PermissionMode.FULL_AUTO, "shutil.rmtree('/')", "wipe", FakeConsole())
        self.assertTrue(ok)
        self.assertIsNone(mod)

    def test_suggest_mode_approves_at_code_level(self):
        ok, _ = permissions.check_permission(
            PermissionMode.SUGGEST, "os.remove('/x')", "delete", FakeConsole())
        self.assertTrue(ok)

    def test_smart_mode_allows_non_critical(self):
        ok, _ = permissions.check_permission(
            PermissionMode.SMART, "print('hello')", "print", FakeConsole())
        self.assertTrue(ok)

    def test_smart_mode_blocks_critical_when_user_declines_cli(self):
        console = FakeConsole(inputs=["n"])
        ok, _ = permissions.check_permission(
            PermissionMode.SMART, "shutil.rmtree('/data')", "wipe data", console)
        self.assertFalse(ok)

    def test_smart_mode_approves_critical_when_user_accepts_cli(self):
        console = FakeConsole(inputs=["y"])
        ok, _ = permissions.check_permission(
            PermissionMode.SMART, "shutil.rmtree('/data')", "wipe data", console)
        self.assertTrue(ok)

    def test_smart_mode_web_console_approval(self):
        ok, _ = permissions.check_permission(
            PermissionMode.SMART, "os.remove('/x'); rm -rf /y", "delete", WebConsole(approval=True))
        self.assertTrue(ok)
        blocked, _ = permissions.check_permission(
            PermissionMode.SMART, "os.remove('/x'); rm -rf /y", "delete", WebConsole(approval=False))
        self.assertFalse(blocked)


class TestSuggestUI(unittest.TestCase):
    def test_web_console_returns_selected_choice(self):
        suggest = {"context": "pick", "options": ["a", "b"]}
        result = permissions.handle_suggest_ui(suggest, WebConsole(suggest_choice="b"))
        self.assertEqual(result, "b")

    def test_cli_numbered_choice_returns_option(self):
        suggest = {"context": "pick", "options": ["first", "second"]}
        result = permissions.handle_suggest_ui(suggest, FakeConsole(inputs=["1"]))
        self.assertEqual(result, "first")


class TestSelectMode(unittest.TestCase):
    def test_defaults_to_smart_on_empty_input(self):
        self.assertEqual(permissions.select_mode(FakeConsole(inputs=[""])), PermissionMode.SMART)

    def test_full_auto_and_suggest_selectable(self):
        self.assertEqual(permissions.select_mode(FakeConsole(inputs=["1"])), PermissionMode.FULL_AUTO)
        self.assertEqual(permissions.select_mode(FakeConsole(inputs=["3"])), PermissionMode.SUGGEST)


if __name__ == "__main__":
    unittest.main()
