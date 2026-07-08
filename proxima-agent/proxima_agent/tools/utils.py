"""Proxima — Shared Utilities.
General-purpose helper functions for JSON, environment settings, and system information.
"""
import os
import json
from pathlib import Path


def json_read(path):
    """Reads and parses a JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def json_write(path, data, indent=2):
    """Writes data to a JSON file."""
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=indent, ensure_ascii=False)
    return f"✓ JSON written: {path}"


def env_get(key, default=None):
    """Gets an environment variable."""
    return os.environ.get(key, default)


def env_set(key, value):
    """Sets an environment variable."""
    os.environ[key] = str(value)
    return f"✓ Set {key}={value}"


def system_info():
    """Returns system details."""
    import platform
    info = {
        "OS": platform.system(),
        "Version": platform.version(),
        "Machine": platform.machine(),
        "Processor": platform.processor(),
        "Python": platform.python_version(),
        "CWD": os.getcwd(),
        "User": os.getenv("USERNAME") or os.getenv("USER"),
        "Home": str(Path.home()),
    }
    return "\n".join(f"  {k}: {v}" for k, v in info.items())


def workspace(*parts) -> str:
    """Returns the agent's workspace directory path."""
    from ..config import get_workspace_dir
    base = get_workspace_dir()
    if parts:
        full = os.path.join(base, *[str(p) for p in parts])
        parent = os.path.dirname(full)
        if parent:
            try:
                os.makedirs(parent, exist_ok=True)
            except Exception:
                pass
        return full
    return base


def screenshot(path: str = None) -> str:
    """Captures a screenshot of the entire screen."""
    if not path:
        import time as _t
        path = workspace(f"screen_{int(_t.time())}.png")

    try:
        import pyautogui
    except Exception:
        return ("Error: pyautogui is not available, so a full-screen screenshot "
                "can't be taken here. If you need a window, use desktop.connect() "
                "then desktop.screenshot().")

    try:
        img = pyautogui.screenshot()
        parent = os.path.abspath(path)
        parent_dir = os.path.dirname(parent)
        if parent_dir:
            os.makedirs(parent_dir, exist_ok=True)
        img.save(path)
        result = f"Full screen captured: {path} ({img.width}x{img.height})"
        try:
            from .attach import note_screenshot
            result += note_screenshot(path)
        except Exception:
            pass
        return result
    except Exception as e:
        return f"Screenshot failed: {e}"
