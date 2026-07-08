"""Tests for proxima_agent.tools.system.shell_ops — command execution wrappers.

subprocess is the boundary and is mocked. Covers _format_result, run_shell
success/timeout, native_shell/powershell argv construction (shell=False, no
quote-injection), and the background-process registry (reap + kill).
"""
import subprocess
import unittest
from unittest.mock import patch, MagicMock

from proxima_agent.tools.system import shell_ops


def _completed(returncode=0, stdout="", stderr=""):
    m = MagicMock()
    m.returncode = returncode
    m.stdout = stdout
    m.stderr = stderr
    return m


class TestFormatResult(unittest.TestCase):
    def test_stdout_only(self):
        self.assertEqual(shell_ops._format_result(_completed(0, "hello")), "hello")

    def test_stderr_appended(self):
        out = shell_ops._format_result(_completed(0, "out", "warn"))
        self.assertIn("out", out)
        self.assertIn("--- stderr ---", out)
        self.assertIn("warn", out)

    def test_exit_code_appended_on_failure(self):
        out = shell_ops._format_result(_completed(1, "x"))
        self.assertIn("[exit code: 1]", out)

    def test_no_output(self):
        self.assertEqual(shell_ops._format_result(_completed(0, "", "")), "(no output)")


class TestRunShell(unittest.TestCase):
    def test_success(self):
        with patch.object(shell_ops.subprocess, "run", return_value=_completed(0, "done")):
            self.assertEqual(shell_ops.run_shell("echo done"), "done")

    def test_timeout(self):
        with patch.object(shell_ops.subprocess, "run", side_effect=subprocess.TimeoutExpired("cmd", 60)):
            out = shell_ops.run_shell("sleep 100")
        self.assertIn("timed out", out)


class TestNativeShellArgv(unittest.TestCase):
    def test_powershell_passes_command_as_single_argv(self):
        with patch.object(shell_ops, "_run_argv", return_value="ok") as ra:
            shell_ops.powershell("Get-Process")
        argv = ra.call_args[0][0]
        # Command is a discrete argv entry after -Command (no wrapping quotes).
        self.assertIn("-Command", argv)
        self.assertTrue(any("Get-Process" in a for a in argv))

    def test_run_argv_shell_false(self):
        with patch.object(shell_ops.subprocess, "run", return_value=_completed(0, "x")) as run:
            shell_ops._run_argv(["echo", "hi"])
        # _run_argv never passes shell=True.
        self.assertNotIn("shell", run.call_args.kwargs)


class TestBackgroundRegistry(unittest.TestCase):
    def tearDown(self):
        with shell_ops._BG_LOCK:
            shell_ops._BG_PROCS.clear()

    def test_reap_removes_exited_processes(self):
        exited = MagicMock()
        exited.poll.return_value = 0  # already exited
        running = MagicMock()
        running.poll.return_value = None
        with shell_ops._BG_LOCK:
            shell_ops._BG_PROCS.clear()
            shell_ops._BG_PROCS[1] = exited
            shell_ops._BG_PROCS[2] = running
        shell_ops._reap_finished_bg()
        self.assertNotIn(1, shell_ops._BG_PROCS)
        self.assertIn(2, shell_ops._BG_PROCS)

    def test_kill_background_terminates_running(self):
        proc = MagicMock()
        proc.poll.return_value = None  # running
        with shell_ops._BG_LOCK:
            shell_ops._BG_PROCS.clear()
            shell_ops._BG_PROCS[99] = proc
        killed = shell_ops.kill_background_processes()
        self.assertEqual(killed, 1)
        proc.terminate.assert_called_once()
        self.assertEqual(len(shell_ops._BG_PROCS), 0)

    def test_run_shell_bg_tracks_pid(self):
        fake_proc = MagicMock()
        fake_proc.pid = 4321
        with patch.object(shell_ops.subprocess, "Popen", return_value=fake_proc):
            out = shell_ops.run_shell_bg("npm run dev")
        self.assertIn("4321", out)
        self.assertIn(4321, shell_ops._BG_PROCS)


if __name__ == "__main__":
    unittest.main()
