"""Tests for proxima_agent.tools.utils — shared JSON/env/workspace helpers.

Pure helpers exercised against temp files and a patched workspace dir. The
screenshot() helper is GUI-bound (pyautogui) and covered only for its graceful
no-pyautogui fallback would require import surgery, so it is left to integration.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

from proxima_agent.tools import utils


class TestJson(unittest.TestCase):
    def test_write_then_read_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "nested", "data.json")
            msg = utils.json_write(path, {"k": "v", "n": 3})
            self.assertIn("JSON written", msg)
            self.assertEqual(utils.json_read(path), {"k": "v", "n": 3})

    def test_write_creates_parent_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a", "b", "c.json")
            utils.json_write(path, [1, 2, 3])
            self.assertTrue(os.path.exists(path))

    def test_write_preserves_unicode(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "u.json")
            utils.json_write(path, {"msg": "नमस्ते"})
            self.assertEqual(utils.json_read(path)["msg"], "नमस्ते")


class TestEnv(unittest.TestCase):
    def test_get_returns_default_when_absent(self):
        self.assertEqual(utils.env_get("PROXIMA_TEST_NONEXISTENT_XYZ", "fallback"), "fallback")

    def test_set_then_get(self):
        try:
            utils.env_set("PROXIMA_TEST_TMP_VAR", "hello")
            self.assertEqual(utils.env_get("PROXIMA_TEST_TMP_VAR"), "hello")
        finally:
            os.environ.pop("PROXIMA_TEST_TMP_VAR", None)


class TestWorkspace(unittest.TestCase):
    def test_returns_base_when_no_parts(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch("proxima_agent.config.get_workspace_dir", return_value=tmp):
                self.assertEqual(utils.workspace(), tmp)

    def test_builds_subpath_and_creates_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch("proxima_agent.config.get_workspace_dir", return_value=tmp):
                full = utils.workspace("data", "out.json")
                self.assertEqual(full, os.path.join(tmp, "data", "out.json"))
                self.assertTrue(os.path.isdir(os.path.join(tmp, "data")))


class TestSystemInfo(unittest.TestCase):
    def test_reports_os_and_python(self):
        info = utils.system_info()
        self.assertIn("OS:", info)
        self.assertIn("Python:", info)


if __name__ == "__main__":
    unittest.main()
