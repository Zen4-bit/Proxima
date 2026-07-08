"""Unit tests for proxima_agent.cli helpers.

Focus: the pure, testable fixes added during the production hardening pass.
  - _format_session_time: must NEVER raise on bad/missing timestamps
    (previously `datetime.fromtimestamp(None)` crashed the whole /chats list).
  - detect_and_verify_paths: returns an existing file path or None.

custom_input()'s UTF-8 reassembly and the slash-command try/except guard are
Windows/msvcrt- and REPL-interactive and are validated by py_compile + manual
runtime; they are not unit-tested here because they require a live console.
"""

import os
import tempfile
import time
import unittest

from proxima_agent import cli


class TestFormatSessionTime(unittest.TestCase):
    def test_valid_timestamp_formats(self):
        # A real epoch second formats to "YYYY-MM-DD HH:MM".
        out = cli._format_session_time(1700000000)
        self.assertRegex(out, r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")

    def test_float_timestamp_ok(self):
        out = cli._format_session_time(1700000000.5)
        self.assertRegex(out, r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")

    def test_none_returns_dash_not_crash(self):
        # Regression: None previously raised TypeError and crashed /chats.
        self.assertEqual(cli._format_session_time(None), "—")

    def test_garbage_returns_dash(self):
        self.assertEqual(cli._format_session_time("not-a-number"), "—")
        self.assertEqual(cli._format_session_time(object()), "—")

    def test_now_roundtrips(self):
        out = cli._format_session_time(time.time())
        self.assertRegex(out, r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")


class TestDetectAndVerifyPaths(unittest.TestCase):
    def test_existing_file_detected(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write("hello")
            tmp = f.name
        try:
            found = cli.detect_and_verify_paths(f"please read {tmp} now")
            self.assertIsNotNone(found)
            self.assertEqual(os.path.abspath(tmp), found)
        finally:
            os.unlink(tmp)

    def test_no_path_returns_none(self):
        self.assertIsNone(cli.detect_and_verify_paths("just a normal sentence"))

    def test_nonexistent_pathlike_returns_none(self):
        self.assertIsNone(
            cli.detect_and_verify_paths("open /tmp/definitely_missing_12345.xyz")
        )


if __name__ == "__main__":
    unittest.main()
