"""Proxima — State Probe.
Queries the operating system and active browser (CDP) for current runtime state.
"""
import os
import time
import platform
import subprocess

_OS = platform.system()


def _cdp_alive() -> bool:
    """Checks if Chrome DevTools Protocol endpoint is active."""
    try:
        import json as _json
        import urllib.request as _req
        from proxima_agent.config import CDP_URL
        with _req.urlopen(f"{CDP_URL}/json/version", timeout=0.3) as resp:
            _json.loads(resp.read())
        return True
    except Exception:
        return False


def probe_browser() -> str:
    """Gets current browser state via CDP."""
    if not _cdp_alive():
        return "Browser: not connected"
    try:
        from proxima_agent.tools.browser_cdp import ChromeBrowser
        b = ChromeBrowser()

        parts = []

        try:
            url = b.eval_js("window.location.href") or "unknown"
            title = b.eval_js("document.title") or "unknown"
            parts.append(f"URL: {url}")
            parts.append(f"Title: {title}")
        except Exception:
            parts.append("URL: (could not read)")

        try:
            raw_tabs = b._get_tabs()
            pages = [t for t in raw_tabs if isinstance(t, dict) and t.get("type") == "page"]
            if pages:
                parts.append(f"Tabs: {len(pages)} open")
                for i, tab in enumerate(pages[:5]):
                    title = (tab.get("title") or "?")[:50]
                    turl = (tab.get("url") or "?")[:60]
                    parts.append(f"  [{i}] {title} — {turl}")
        except Exception:
            pass

        try:
            has_dialog = b.eval_js(
                "document.querySelector('dialog[open], [role=dialog], "
                ".modal, .popup, [aria-modal=true]') !== null"
            )
            if has_dialog:
                parts.append("Dialog: OPEN (popup/modal detected)")
        except Exception:
            pass

        try:
            forms = b.eval_js("""
                (() => {
                    const fields = [];
                    document.querySelectorAll('input, textarea, select').forEach((el, i) => {
                        if (i >= 10) return;
                        const label = el.getAttribute('aria-label') || el.getAttribute('placeholder')
                            || el.getAttribute('name') || el.type || 'unknown';
                        const val = el.value || '';
                        const status = val ? 'FILLED' : 'EMPTY';
                        fields.push(label + ': ' + status + (val ? ' (' + val.substring(0, 30) + ')' : ''));
                    });
                    return fields;
                })()
            """)
            if forms:
                parts.append("Form fields:")
                for f in forms:
                    parts.append(f"  {f}")
        except Exception:
            pass

        try:
            snippet = b.eval_js("document.body?.innerText?.substring(0, 200) || ''")
            if snippet:
                parts.append(f"Page text: {snippet[:200]}")
        except Exception:
            pass

        return "\n".join(parts) if parts else "Browser: not connected"

    except Exception as e:
        return f"Browser: unavailable ({e})"


def _get_focused_window_windows() -> str:
    """Gets focused window title on Windows."""
    try:
        import ctypes
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        return buf.value or "(unknown)"
    except Exception:
        return "(unknown)"


def _get_focused_window_mac() -> str:
    """Gets focused window title on macOS."""
    try:
        result = subprocess.run(
            ["osascript", "-e",
             'tell application "System Events" to get name of first '
             'application process whose frontmost is true'],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip() or "(unknown)"
    except Exception:
        return "(unknown)"


def _get_focused_window_linux() -> str:
    """Gets focused window title on Linux."""
    try:
        result = subprocess.run(
            ["xdotool", "getactivewindow", "getwindowname"],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip() or "(unknown)"
    except Exception:
        try:
            result = subprocess.run(
                ["wmctrl", "-l"], capture_output=True, text=True, timeout=5
            )
            return result.stdout.strip()[:200] or "(unknown)"
        except Exception:
            return "(unknown)"


def _get_focused_window() -> str:
    """Gets focused window with auto OS detection."""
    if _OS == "Windows":
        return _get_focused_window_windows()
    elif _OS == "Darwin":
        return _get_focused_window_mac()
    else:
        return _get_focused_window_linux()


def probe_desktop() -> str:
    """Gets current desktop state."""
    parts = []

    focused = _get_focused_window()
    if focused and focused != "(unknown)":
        parts.append(f"Focused window: {focused}")

    if _OS == "Windows":
        try:
            from proxima_agent.tools.desktop import Desktop
            d = Desktop()
            windows = d.windows()
            if windows:
                parts.append(f"Open windows:\n{windows}")
        except Exception:
            pass
    elif _OS == "Darwin":
        try:
            result = subprocess.run(
                ["osascript", "-e",
                 'tell application "System Events" to get name of '
                 'every application process whose visible is true'],
                capture_output=True, text=True, timeout=5
            )
            if result.stdout.strip():
                parts.append(f"Visible apps: {result.stdout.strip()[:200]}")
        except Exception:
            pass
    else:
        try:
            result = subprocess.run(
                ["wmctrl", "-l"], capture_output=True, text=True, timeout=5
            )
            if result.stdout.strip():
                parts.append(f"Open windows:\n{result.stdout.strip()[:300]}")
        except Exception:
            pass

    return "\n".join(parts) if parts else "Desktop: no info"


def probe_system() -> str:
    """Gets relevant system state."""
    parts = []

    try:
        from proxima_agent.config import get_workspace_dir
        _cwd = get_workspace_dir()
    except Exception:
        _cwd = os.getcwd()

    parts.append(f"OS: {_OS} ({platform.platform()})")
    parts.append(f"CWD: {_cwd}")

    try:
        cwd_files = []
        for entry in os.scandir(_cwd):
            if entry.is_file():
                cwd_files.append((entry.name, entry.stat().st_mtime))
        cwd_files.sort(key=lambda x: x[1], reverse=True)
        if cwd_files:
            parts.append("Recent files:")
            for name, mtime in cwd_files[:5]:
                age = time.time() - mtime
                if age < 60:
                    parts.append(f"  {name} (modified {int(age)}s ago)")
                elif age < 3600:
                    parts.append(f"  {name} (modified {int(age/60)}m ago)")
    except Exception:
        pass

    return "\n".join(parts)


def probe_all(include_browser: bool = True, include_desktop: bool = False) -> str:
    """Returns full environment state as structured text."""
    sections = []

    sections.append(f"[SYSTEM STATE]\n{probe_system()}")

    if include_browser:
        sections.append(f"[BROWSER STATE]\n{probe_browser()}")

    if include_desktop:
        sections.append(f"[DESKTOP STATE]\n{probe_desktop()}")

    sections.append(f"[TIMESTAMP] {time.strftime('%Y-%m-%d %H:%M:%S')}")

    return "\n\n".join(sections)
