"""Tests for proxima_agent.tools.health — tool availability dashboard.

Deterministic paths only: unknown category, always-available files/shell checks,
git check with `git` absent (shutil.which patched), TTL caching, and cache
invalidation. Network/browser socket probes are runtime-bound and not asserted
on here (they'd depend on the host); the caching + dispatch logic that wraps
them is covered.
"""
import unittest
from unittest.mock import patch

from proxima_agent.tools import health


class HealthBase(unittest.TestCase):
    def setUp(self):
        health.invalidate_cache()

    def tearDown(self):
        health.invalidate_cache()


class TestToolsHealth(HealthBase):
    def test_unknown_category(self):
        res = health.tools_health("does-not-exist")
        self.assertEqual(res["status"], "unknown")

    def test_files_always_ready(self):
        self.assertEqual(health.tools_health("files")["status"], "ready")

    def test_shell_reports_shell_and_cwd(self):
        res = health.tools_health("shell")
        self.assertEqual(res["status"], "ready")
        self.assertIn("shell", res)
        self.assertIn("cwd", res)

    def test_git_unavailable_when_git_missing(self):
        with patch.object(health.shutil, "which", return_value=None):
            res = health.tools_health("git")
        self.assertEqual(res["status"], "unavailable")

    def test_result_is_cached_within_ttl(self):
        calls = {"n": 0}

        def fake_check():
            calls["n"] += 1
            return {"status": "ready", "n": calls["n"]}

        with patch.dict(health._CHECKS, {"files": fake_check}):
            first = health.tools_health("files")
            second = health.tools_health("files")
        self.assertEqual(first, second)
        self.assertEqual(calls["n"], 1, "second call served from cache")

    def test_invalidate_cache_forces_recheck(self):
        calls = {"n": 0}

        def fake_check():
            calls["n"] += 1
            return {"status": "ready"}

        with patch.dict(health._CHECKS, {"files": fake_check}):
            health.tools_health("files")
            health.invalidate_cache("files")
            health.tools_health("files")
        self.assertEqual(calls["n"], 2)

    def test_all_categories_returns_mapping(self):
        # Only assert structure/keys — values depend on host (network/browser).
        with patch.object(health, "_check_browser", return_value={"status": "not_running"}), \
             patch.object(health, "_check_network", return_value={"status": "offline"}):
            res = health.tools_health()
        self.assertIn("files", res)
        self.assertIn("git", res)
        self.assertEqual(res["files"]["status"], "ready")


if __name__ == "__main__":
    unittest.main()
