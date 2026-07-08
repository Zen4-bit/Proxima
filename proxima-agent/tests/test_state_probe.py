"""Tests for proxima_agent.brain.state — the environment state probe.

The browser/desktop probes are runtime-bound (CDP/OS). We test the pure,
deterministic paths: _cdp_alive is patched so no real Chrome is contacted or
launched, and the workspace dir is redirected to a temp dir. Assertions cover
probe_system output, the "not connected" browser fast-path, and probe_all
composition.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

from proxima_agent.brain import state


class TestProbeSystem(unittest.TestCase):
    def test_reports_os_cwd_and_recent_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "recent.txt"), "w") as f:
                f.write("x")
            with patch("proxima_agent.config.get_workspace_dir", return_value=tmp):
                out = state.probe_system()
        self.assertIn("OS:", out)
        self.assertIn("CWD:", out)
        self.assertIn("recent.txt", out)


class TestProbeBrowser(unittest.TestCase):
    def test_not_connected_when_cdp_down(self):
        # A passive probe must never launch Chrome — when CDP is unreachable it
        # returns the not-connected marker without constructing ChromeBrowser.
        with patch.object(state, "_cdp_alive", return_value=False):
            self.assertEqual(state.probe_browser(), "Browser: not connected")


class TestProbeAll(unittest.TestCase):
    def test_composes_system_browser_and_timestamp_sections(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch("proxima_agent.config.get_workspace_dir", return_value=tmp), \
             patch.object(state, "_cdp_alive", return_value=False):
            out = state.probe_all(include_browser=True, include_desktop=False)
        self.assertIn("[SYSTEM STATE]", out)
        self.assertIn("[BROWSER STATE]", out)
        self.assertIn("[TIMESTAMP]", out)
        self.assertIn("Browser: not connected", out)

    def test_browser_section_omitted_when_disabled(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch("proxima_agent.config.get_workspace_dir", return_value=tmp):
            out = state.probe_all(include_browser=False, include_desktop=False)
        self.assertNotIn("[BROWSER STATE]", out)
        self.assertIn("[SYSTEM STATE]", out)


if __name__ == "__main__":
    unittest.main()
