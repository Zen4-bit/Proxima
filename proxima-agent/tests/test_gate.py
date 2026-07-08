"""Tests for proxima_agent.gate.gate_code — the shared pre-execution safety gate.

The gate lazily imports check_web_misuse / check_safety (from tools.execute) and
check_permission (from permissions); these are patched at their source modules
so the gate's DECISION LOGIC is tested in isolation:
  • web-misuse warning → BLOCK with a rewrite hint
  • safety warning + no console → fail-safe BLOCK (never silent execute)
  • safety warning + console approves/denies → ALLOW / BLOCK
  • permission layer denial → BLOCK; alternative instruction → OVERRIDE
  • all clear → ALLOW
"""
import unittest
from unittest.mock import patch

from proxima_agent import gate
from proxima_agent.permissions import PermissionMode


class ApprovingConsole:
    def __init__(self, approved):
        self._approved = approved
    def request_approval(self, action, code, reasons):
        return self._approved
    def print(self, *a, **k):
        pass


BASE_CFG = {"web_misuse_check": True, "safety_checks": True}


class TestGateCode(unittest.TestCase):
    def test_allows_clean_code(self):
        with patch("proxima_agent.tools.execute.check_web_misuse", return_value=""), \
             patch("proxima_agent.tools.execute.check_safety", return_value=[]):
            decision, feedback = gate.gate_code("print('hi')", config=BASE_CFG)
        self.assertEqual(decision, gate.ALLOW)
        self.assertEqual(feedback, "")

    def test_blocks_web_misuse_with_rewrite_hint(self):
        with patch("proxima_agent.tools.execute.check_web_misuse", return_value="raw HTTP detected"):
            decision, feedback = gate.gate_code("requests.get(url)", config=BASE_CFG)
        self.assertEqual(decision, gate.BLOCK)
        self.assertIn("ChromeBrowser", feedback)

    def test_safety_warning_without_console_fails_safe(self):
        with patch("proxima_agent.tools.execute.check_web_misuse", return_value=""), \
             patch("proxima_agent.tools.execute.check_safety", return_value=["rm -rf /"]):
            decision, feedback = gate.gate_code("danger()", config=BASE_CFG, console=None)
        self.assertEqual(decision, gate.BLOCK)
        self.assertIn("no console", feedback.lower())

    def test_safety_warning_console_approves(self):
        with patch("proxima_agent.tools.execute.check_web_misuse", return_value=""), \
             patch("proxima_agent.tools.execute.check_safety", return_value=["dangerous"]):
            decision, _ = gate.gate_code("danger()", config=BASE_CFG, console=ApprovingConsole(True))
        self.assertEqual(decision, gate.ALLOW)

    def test_safety_warning_console_denies(self):
        with patch("proxima_agent.tools.execute.check_web_misuse", return_value=""), \
             patch("proxima_agent.tools.execute.check_safety", return_value=["dangerous"]):
            decision, feedback = gate.gate_code("danger()", config=BASE_CFG, console=ApprovingConsole(False))
        self.assertEqual(decision, gate.BLOCK)
        self.assertIn("denied", feedback.lower())

    def test_permission_denial_blocks(self):
        with patch("proxima_agent.tools.execute.check_web_misuse", return_value=""), \
             patch("proxima_agent.tools.execute.check_safety", return_value=[]), \
             patch("proxima_agent.permissions.check_permission", return_value=(False, None)):
            decision, _ = gate.gate_code(
                "x()", config=BASE_CFG, permission_mode=PermissionMode.SMART)
        self.assertEqual(decision, gate.BLOCK)

    def test_permission_alternative_instruction_is_override(self):
        with patch("proxima_agent.tools.execute.check_web_misuse", return_value=""), \
             patch("proxima_agent.tools.execute.check_safety", return_value=[]), \
             patch("proxima_agent.permissions.check_permission", return_value=(True, "do it differently")):
            decision, feedback = gate.gate_code(
                "x()", config=BASE_CFG, permission_mode=PermissionMode.SUGGEST)
        self.assertEqual(decision, gate.OVERRIDE)
        self.assertEqual(feedback, "do it differently")

    def test_checks_can_be_disabled_via_config(self):
        # With both toggles off and no permission mode, the gate short-circuits
        # to ALLOW regardless of the code.
        with patch("proxima_agent.tools.execute.check_web_misuse") as web, \
             patch("proxima_agent.tools.execute.check_safety") as safe:
            decision, _ = gate.gate_code(
                "rm -rf /", config={"web_misuse_check": False, "safety_checks": False})
        self.assertEqual(decision, gate.ALLOW)
        web.assert_not_called()
        safe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
