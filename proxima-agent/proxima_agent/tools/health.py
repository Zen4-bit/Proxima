"""Proxima — Tool Health Dashboard.
Provides lazy, cached health and availability status checks for active tools.
"""
from __future__ import annotations

import os
import time
import shutil
import subprocess
from typing import Optional

_cache: dict[str, tuple[float, dict]] = {}
_DEFAULT_TTL = 30


def _cached(category: str, ttl: int = _DEFAULT_TTL) -> Optional[dict]:
    """Returns cached result if fresh, else None."""
    if category in _cache:
        ts, result = _cache[category]
        if time.time() - ts < ttl:
            return result
    return None


def _store(category: str, result: dict) -> dict:
    """Caches and returns the health check result."""
    _cache[category] = (time.time(), result)
    return result


def _check_browser() -> dict:
    """Checks if Chrome CDP is reachable."""
    try:
        import socket
        port = int(os.environ.get("PROXIMA_CDP_PORT", "9222"))
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        result = sock.connect_ex(("127.0.0.1", port))
        sock.close()
        if result == 0:
            return {"status": "connected", "port": port}
        return {"status": "not_running", "port": port}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _check_desktop() -> dict:
    """Checks if desktop automation is available."""
    try:
        import pywinauto
        return {"status": "ready", "backend": "pywinauto"}
    except ImportError:
        pass
    import platform
    os_name = platform.system()
    if os_name == "Darwin":
        return {"status": "ready", "backend": "applescript"}
    elif os_name == "Linux":
        if shutil.which("xdotool"):
            return {"status": "ready", "backend": "xdotool"}
        return {"status": "unavailable", "reason": "xdotool not installed"}
    return {"status": "unavailable", "reason": "unsupported OS"}


def _check_ocr() -> dict:
    """Checks OCR engine availability."""
    engines = []
    import platform
    if platform.system() == "Windows" and _probe_windows_ocr():
        engines.append("windows_native")
    if shutil.which("tesseract"):
        engines.append("tesseract")
    if engines:
        return {"status": "ready", "engines": engines}
    return {"status": "unavailable", "reason": "no OCR engine found"}


def _probe_windows_ocr() -> bool:
    """Verifies if the Windows native OCR runtime can be instantiated."""
    try:
        script = (
            "Add-Type -AssemblyName System.Runtime.WindowsRuntime;"
            "$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime];"
            "if([Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()){'ok'}else{'none'}"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            capture_output=True, text=True, timeout=8,
        )
        return "ok" in (result.stdout or "")
    except Exception:
        return False


def _check_git() -> dict:
    """Checks if git is installed and we are in a repository."""
    if not shutil.which("git"):
        return {"status": "unavailable", "reason": "git not installed"}
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            branch = result.stdout.strip()
            return {"status": "ready", "branch": branch, "in_repo": True}
        return {"status": "ready", "in_repo": False}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _check_shell() -> dict:
    """Checks shell availability."""
    import platform
    os_name = platform.system()
    cwd = os.getcwd()
    if os_name == "Windows":
        shell = "powershell" if shutil.which("powershell") else "cmd"
    else:
        shell = os.environ.get("SHELL", "/bin/sh")
    return {"status": "ready", "shell": shell, "cwd": cwd}


def _check_network() -> dict:
    """Checks network reachability."""
    try:
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        result = sock.connect_ex(("8.8.8.8", 53))
        sock.close()
        if result == 0:
            return {"status": "online"}
        return {"status": "offline"}
    except Exception:
        return {"status": "offline"}


def _check_files() -> dict:
    """File operations health check."""
    return {"status": "ready"}


_CHECKS = {
    "browser": _check_browser,
    "desktop": _check_desktop,
    "computer": _check_desktop,
    "ocr": _check_ocr,
    "git": _check_git,
    "shell": _check_shell,
    "network": _check_network,
    "files": _check_files,
    "search": _check_files,
    "code": _check_files,
    "utils": _check_files,
    "attach": _check_files,
    "tool_docs": _check_files,
    "brain": _check_files,
}


def tools_health(category: Optional[str] = None, ttl: int = _DEFAULT_TTL) -> dict:
    """Checks health/availability of a single or all tool categories."""
    if category is not None:
        if category not in _CHECKS:
            return {"status": "unknown", "reason": f"no health check for '{category}'"}
        cached = _cached(category, ttl)
        if cached is not None:
            return cached
        return _store(category, _CHECKS[category]())

    results = {}
    for cat, check_fn in _CHECKS.items():
        cached = _cached(cat, ttl)
        if cached is not None:
            results[cat] = cached
        else:
            results[cat] = _store(cat, check_fn())
    return results


def invalidate_cache(category: Optional[str] = None):
    """Clears cached health results for a category or all categories."""
    if category is not None:
        _cache.pop(category, None)
    else:
        _cache.clear()
