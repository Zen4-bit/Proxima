"""Proxima — Shell Operations.
Cross-platform shell command and background process execution.
"""
import os
import subprocess
import platform
import threading

_OS = platform.system()

# Subprocess output is decoded as UTF-8 to prevent Mojibake and encoding crashes.
# Force Windows PowerShell 5.1 to emit UTF-8.
_PS_UTF8_PREFIX = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "

# Background process registry
_BG_PROCS: dict[int, subprocess.Popen] = {}
_BG_LOCK = threading.Lock()


def _reap_finished_bg():
    with _BG_LOCK:
        for pid in list(_BG_PROCS):
            proc = _BG_PROCS[pid]
            try:
                if proc.poll() is not None:
                    _BG_PROCS.pop(pid, None)
            except Exception:
                _BG_PROCS.pop(pid, None)


def kill_background_processes() -> int:
    with _BG_LOCK:
        procs = list(_BG_PROCS.items())
        _BG_PROCS.clear()
    killed = 0
    for _pid, proc in procs:
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                killed += 1
        except Exception:
            pass
    return killed


def _format_result(result):
    output = ""
    if result.stdout:
        output += result.stdout
    if result.stderr:
        output += ("\n--- stderr ---\n" + result.stderr) if result.stdout else result.stderr
    if result.returncode != 0:
        output += f"\n[exit code: {result.returncode}]"
    return output.strip() or "(no output)"


def _run_argv(argv, cwd=None, timeout=60):
    try:
        result = subprocess.run(
            argv, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            cwd=cwd or os.getcwd(), timeout=timeout,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"}
        )
        return _format_result(result)
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout}s: {argv}"
    except Exception as e:
        return f"Error: {e}"


def run_shell(cmd, cwd=None, timeout=60):
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            cwd=cwd or os.getcwd(), timeout=timeout,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"}
        )
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            output += ("\n--- stderr ---\n" + result.stderr) if result.stdout else result.stderr
        if result.returncode != 0:
            output += f"\n[exit code: {result.returncode}]"
        return output.strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout}s: {cmd}"
    except Exception as e:
        return f"Error: {e}"


def run_shell_bg(cmd, cwd=None):
    _reap_finished_bg()
    proc = subprocess.Popen(
        cmd, shell=True, cwd=cwd or os.getcwd(),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    with _BG_LOCK:
        _BG_PROCS[proc.pid] = proc
    return f"Started background process (PID: {proc.pid}): {cmd}"


def native_shell(cmd, cwd=None, timeout=60):
    if _OS == "Windows":
        return powershell(cmd, cwd=cwd, timeout=timeout)
    else:
        # Try bash first, fallback to sh. Pass cmd as a single argv argument so
        # embedded quotes/`$()`/backticks can't break out of an outer wrapper.
        bash = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"
        return _run_argv([bash, "-c", cmd], cwd=cwd, timeout=timeout)


def powershell(cmd, cwd=None, timeout=60):
    if _OS != "Windows":
        # Check if pwsh (PowerShell Core) is available cross-platform
        import shutil
        if shutil.which("pwsh"):
            return _run_argv(["pwsh", "-NoProfile", "-Command", _PS_UTF8_PREFIX + cmd], cwd=cwd, timeout=timeout)
        return "PowerShell not available on this OS. Use native_shell() or run_shell() instead."
    return _run_argv(["powershell", "-NoProfile", "-Command", _PS_UTF8_PREFIX + cmd], cwd=cwd, timeout=timeout)


# Aliases
shell = run_shell
shell_bg = run_shell_bg
