"""Tests for proxima_agent.tools.coding.git_ops — git command wrappers.

subprocess.run is the boundary and is mocked (no real git repo needed). We
verify the exact argv each helper builds (shell=False safety) and how _git maps
returncode/stdout/stderr/timeout into the returned string.
"""
import subprocess
import unittest
from unittest.mock import patch, MagicMock

from proxima_agent.tools.coding import git_ops


def _completed(returncode=0, stdout="", stderr=""):
    m = MagicMock()
    m.returncode = returncode
    m.stdout = stdout
    m.stderr = stderr
    return m


class TestGitCore(unittest.TestCase):
    def test_success_returns_stdout(self):
        with patch.object(git_ops.subprocess, "run", return_value=_completed(0, "clean tree", "warn")) as run:
            out = git_ops._git(["status"])
        self.assertEqual(out, "clean tree")  # stdout preferred over stderr
        # shell=False and git prefix.
        args, kwargs = run.call_args
        self.assertEqual(args[0][0], "git")
        self.assertIs(kwargs["shell"], False)

    def test_failure_surfaces_stderr(self):
        with patch.object(git_ops.subprocess, "run", return_value=_completed(1, "", "fatal: not a repo")):
            out = git_ops._git(["status"])
        self.assertIn("not a repo", out)

    def test_timeout_returns_message(self):
        with patch.object(git_ops.subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 30)):
            out = git_ops._git(["log"])
        self.assertIn("timed out", out)

    def test_non_interactive_env_is_set(self):
        with patch.object(git_ops.subprocess, "run", return_value=_completed(0, "ok")) as run:
            git_ops._git(["status"])
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["GIT_TERMINAL_PROMPT"], "0")


class TestGitCommands(unittest.TestCase):
    def _capture_args(self):
        run = MagicMock(return_value=_completed(0, "out"))
        return run

    def test_status_args(self):
        run = self._capture_args()
        with patch.object(git_ops.subprocess, "run", run):
            git_ops.git_status()
        self.assertEqual(run.call_args[0][0], ["git", "status", "--short"])

    def test_diff_stat_and_path_args(self):
        run = self._capture_args()
        with patch.object(git_ops.subprocess, "run", run):
            git_ops.git_diff(path="src/x.py", stat=True)
        self.assertEqual(run.call_args[0][0], ["git", "diff", "--stat", "--", "src/x.py"])

    def test_log_oneline_args(self):
        run = self._capture_args()
        with patch.object(git_ops.subprocess, "run", run):
            git_ops.git_log(n=5, oneline=True)
        self.assertEqual(run.call_args[0][0], ["git", "log", "-n", "5", "--oneline"])

    def test_commit_message_passed_as_argv(self):
        run = self._capture_args()
        with patch.object(git_ops.subprocess, "run", run):
            git_ops.git_commit("fix: safe; message", add_all=False)
        # Message is a discrete argv entry — no shell interpolation.
        self.assertEqual(run.call_args[0][0], ["git", "commit", "-m", "fix: safe; message"])

    def test_branch_create_args(self):
        run = self._capture_args()
        with patch.object(git_ops.subprocess, "run", run):
            git_ops.git_branch(name="feature/x")
        self.assertEqual(run.call_args[0][0], ["git", "checkout", "-b", "feature/x"])


if __name__ == "__main__":
    unittest.main()
