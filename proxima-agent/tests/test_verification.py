"""Tests for proxima_agent.tools.verification — proof-based verification engine.

Filesystem checks run against real temp files; browser checks are exercised via
the "not accessible → UNKNOWN" path (patching the passive browser helpers so no
Chrome is contacted). Also covers the custom-evidence rule, session summary, and
the output parser used by the agent loop.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

from proxima_agent.tools import verification as V


class TestParseVerifyOutput(unittest.TestCase):
    def test_none_when_no_marker(self):
        r = V.parse_verify_output("just some output\nno markers")
        self.assertEqual(r["status"], "NONE")
        self.assertFalse(r["verified"])

    def test_pass_marker(self):
        r = V.parse_verify_output("stuff\nVERIFY:PASS\n")
        self.assertEqual(r["status"], "PASS")
        self.assertTrue(r["verified"])

    def test_fail_marker_with_reason(self):
        r = V.parse_verify_output("VERIFY:FAIL:file missing")
        self.assertEqual(r["status"], "FAIL")
        self.assertEqual(r["reason"], "file missing")

    def test_last_marker_wins(self):
        r = V.parse_verify_output("VERIFY:FAIL:early\nVERIFY:PASS")
        self.assertEqual(r["status"], "PASS")


class TestFileChecks(unittest.TestCase):
    def setUp(self):
        V.clear_session()

    def test_file_exists_pass_for_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "out.txt")
            with open(p, "w") as f:
                f.write("x")
            res = V.verify(type="file_exists", path=p)
            self.assertTrue(res.passed)

    def test_file_exists_fail_for_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = V.verify(type="file_exists", path=tmp)  # a dir, not a file
            self.assertEqual(res.status, V.VerifyResult.FAIL)

    def test_file_exists_fail_when_missing(self):
        res = V.verify(type="file_exists", path=os.path.join(tempfile.gettempdir(), "nope-xyz-123"))
        self.assertEqual(res.status, V.VerifyResult.FAIL)

    def test_file_contains_pass_and_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "log.txt")
            with open(p, "w") as f:
                f.write("operation completed successfully")
            self.assertTrue(V.verify(type="file_contains", path=p, text="completed").passed)
            self.assertEqual(V.verify(type="file_contains", path=p, text="ABSENT").status, V.VerifyResult.FAIL)


class TestCustomCheck(unittest.TestCase):
    def setUp(self):
        V.clear_session()

    def test_custom_pass_requires_evidence(self):
        # passed=True but no reason → downgraded to UNKNOWN (no blind PASS).
        self.assertEqual(V.verify(type="custom", passed=True).status, V.VerifyResult.UNKNOWN)
        # With evidence → real PASS.
        self.assertTrue(V.verify(type="custom", passed=True, reason="HTTP 200 seen").passed)

    def test_custom_fail_and_none(self):
        self.assertEqual(V.verify(type="custom", passed=False).status, V.VerifyResult.FAIL)
        self.assertEqual(V.verify(type="custom").status, V.VerifyResult.UNKNOWN)


class TestBrowserChecksUnavailable(unittest.TestCase):
    def setUp(self):
        V.clear_session()

    def test_url_match_unknown_when_browser_down(self):
        with patch.object(V, "_get_browser_url", return_value=None):
            res = V.verify(type="url_match", expected="https://mail.google.com")
        self.assertEqual(res.status, V.VerifyResult.UNKNOWN)

    def test_url_match_pass_and_fail(self):
        with patch.object(V, "_get_browser_url", return_value="https://mail.google.com/mail/u/0"):
            self.assertTrue(V.verify(type="url_match", expected="mail.google.com").passed)
            self.assertEqual(
                V.verify(type="url_match", expected="example.com").status, V.VerifyResult.FAIL)


class TestSessionSummary(unittest.TestCase):
    def test_summary_reflects_recorded_results(self):
        V.clear_session()
        V.verify(type="custom", passed=True, reason="ok")
        V.verify(type="custom", passed=False, reason="bad")
        summary = V.session_summary()
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["passed"], 1)
        self.assertEqual(summary["failed"], 1)
        # Any FAIL → overall FAIL.
        self.assertEqual(summary["overall"], "FAIL")

    def test_empty_session_summary(self):
        V.clear_session()
        self.assertEqual(V.session_summary()["overall"], "UNKNOWN")


if __name__ == "__main__":
    unittest.main()
