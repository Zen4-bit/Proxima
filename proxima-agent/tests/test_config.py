"""Tests for proxima_agent.config — endpoints, workspace, limits, BYOK keys.

CONFIG_PATH is a module constant resolved from ~/.proxima-agent at import time,
so tests patch config.CONFIG_PATH to a throwaway temp file. No real user config
is read or written.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

from proxima_agent import config


class TestNormalizeLocalhost(unittest.TestCase):
    def test_rewrites_http_https_ws_localhost(self):
        with patch.object(config, "LOCAL_HOST", "127.0.0.1"):
            self.assertEqual(
                config.normalize_localhost("http://localhost:3210/v1"),
                "http://127.0.0.1:3210/v1",
            )
            self.assertEqual(
                config.normalize_localhost("ws://localhost:8500/ws"),
                "ws://127.0.0.1:8500/ws",
            )

    def test_noop_for_non_localhost_and_empty(self):
        self.assertEqual(config.normalize_localhost("https://api.example.com/v1"),
                         "https://api.example.com/v1")
        self.assertEqual(config.normalize_localhost(""), "")
        self.assertIsNone(config.normalize_localhost(None))


class TestGetWorkspaceDir(unittest.TestCase):
    def test_creates_and_returns_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = os.path.join(tmp, "Proxima")
            with patch.object(config, "WORKSPACE_DIR", ws):
                got = config.get_workspace_dir()
                self.assertEqual(got, ws)
                self.assertTrue(os.path.isdir(ws))


class TestGetLimit(unittest.TestCase):
    def test_returns_default_for_missing_key(self):
        with patch.object(config, "load_config", return_value={}):
            self.assertEqual(config.get_limit("nope", 42), 42)

    def test_rejects_non_positive_and_malformed(self):
        with patch.object(config, "load_config", return_value={"x": 0}):
            self.assertEqual(config.get_limit("x", 10), 10)  # 0 → default
        with patch.object(config, "load_config", return_value={"x": "abc"}):
            self.assertEqual(config.get_limit("x", 7), 7)    # unparseable → default

    def test_returns_configured_positive_value(self):
        with patch.object(config, "load_config", return_value={"x": 99}):
            self.assertEqual(config.get_limit("x", 10), 99)


class TestConfigRoundTrip(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._path = os.path.join(self._tmp, "config.json")
        self._patcher = patch.object(config, "CONFIG_PATH", self._path)
        self._patcher.start()

    def tearDown(self):
        self._patcher.stop()

    def test_defaults_when_no_file(self):
        cfg = config.load_config()
        self.assertEqual(cfg["model"], "gemini")
        # api_url is always normalized to 127.0.0.1.
        self.assertNotIn("localhost", cfg["api_url"])

    def test_save_then_load_merges_over_defaults(self):
        config.save_config({"model": "claude", "temperature": 0.1})
        cfg = config.load_config()
        self.assertEqual(cfg["model"], "claude")
        self.assertEqual(cfg["temperature"], 0.1)
        # Untouched defaults survive the merge.
        self.assertEqual(cfg["max_tool_iterations"], 50)


class TestBYOKKeys(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._path = os.path.join(self._tmp, "config.json")
        self._patcher = patch.object(config, "CONFIG_PATH", self._path)
        self._patcher.start()

    def tearDown(self):
        self._patcher.stop()

    def test_save_and_get_valid_key(self):
        config.save_agent_byok_key("chatgpt", "sk-abcdefg")
        self.assertEqual(config.get_agent_byok_key("chatgpt"), "sk-abcdefg")

    def test_invalid_provider_rejected(self):
        with self.assertRaises(ValueError):
            config.save_agent_byok_key("notaprovider", "sk-abcdefg")

    def test_short_key_rejected(self):
        with self.assertRaises(ValueError):
            config.save_agent_byok_key("chatgpt", "abc")

    def test_list_status_reports_configured_providers(self):
        config.save_agent_byok_key("gemini", "sk-geminikey")
        status = config.list_agent_byok_keys()
        self.assertTrue(status["gemini"])
        self.assertFalse(status["chatgpt"])

    def test_remove_key_also_clears_saved_model(self):
        config.save_agent_byok_key("groq", "sk-groqkey")
        config.save_agent_byok_model("groq", "llama-3.1")
        self.assertEqual(config.get_agent_byok_model("groq"), "llama-3.1")
        config.remove_agent_byok_key("groq")
        self.assertIsNone(config.get_agent_byok_key("groq"))
        self.assertIsNone(config.get_agent_byok_model("groq"))


if __name__ == "__main__":
    unittest.main()
