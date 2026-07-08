"""Proxima — Environment Context.
Dynamic system environment snapshot for the agent.
"""

import os
import platform

_OS = platform.system()

# CDP endpoint used by proxima's automated Chrome — centralized in config
# (overridable via PROXIMA_CDP_PORT), with a safe local fallback.
try:
    from ...config import CDP_PORT as _CDP_PORT, CDP_URL as _CDP_URL
except Exception:
    _CDP_PORT = 9222
    _CDP_URL = f"http://127.0.0.1:{_CDP_PORT}"


def get_environment_context(browser_instance=None, desktop_instance=None) -> str:
    sections = []

    # ── System Info ──
    sections.append(_system_section())

    # ── Displays ──
    sections.append(_displays_section())

    # ── Windows ──
    sections.append(_windows_section())

    # ── Active Window ──
    sections.append(_active_section())

    # ── Tools Status ──
    sections.append(_tools_section(browser_instance, desktop_instance))

    return "\n\n".join(s for s in sections if s)


def _system_section() -> str:
    info = platform.uname()
    return (
        f"System: {info.system} {info.release} ({info.machine})\n"
        f"  Python: {platform.python_version()}\n"
        f"  CWD: {os.getcwd()}"
    )


def _displays_section() -> str:
    try:
        from .display_info import enumerate_displays
        displays = enumerate_displays()
        if not displays:
            return "Displays: Unknown"

        lines = [f"Displays: {len(displays)}"]
        for d in displays:
            primary = " (primary)" if d.get("primary") else ""
            size = d.get("size", {})
            pos = d.get("position", {})
            scale = d.get("scale", 1.0)
            lines.append(
                f'  [{d.get("index", 0)}] {d.get("name", "?")}{primary}  '
                f'{size.get("width", 0)}x{size.get("height", 0)} '
                f'at ({pos.get("x", 0)},{pos.get("y", 0)}) scale={scale}'
            )
        return "\n".join(lines)
    except Exception as e:
        return f"Displays: Error ({e})"


def _windows_section() -> str:
    try:
        from .window_manager import enumerate_windows
        windows = enumerate_windows()
        if not windows:
            return "Open Windows: None detected"

        # Check if CDP Chrome is running
        cdp_titles = _get_cdp_chrome_titles()

        lines = [f"Open Windows: {len(windows)}"]
        for i, w in enumerate(windows):
            title = w.get("title", "?")
            handle = w.get("handle", 0)
            display = w.get("display", 0)
            pos = w.get("position", {})
            size = w.get("size", {})
            class_name = w.get("class_name", "")

            # Determine window type and suggest interaction
            wtype, suggestion = _classify_window(title, class_name, cdp_titles, handle)

            lines.append(
                f'  [{i}] "{title[:60]}"'
            )
            lines.append(
                f'      Type: {wtype}  |  Display: {display}  |  '
                f'Handle: 0x{handle:X}'
            )
            lines.append(
                f'      Position: ({pos.get("x", 0)},{pos.get("y", 0)})  '
                f'Size: {size.get("width", 0)}x{size.get("height", 0)}'
            )
            lines.append(
                f'      Interact: {suggestion}'
            )

        return "\n".join(lines)
    except Exception as e:
        return f"Open Windows: Error ({e})"


def _active_section() -> str:
    try:
        from .window_manager import get_active_window
        win = get_active_window()
        if not win:
            return "Active Window: None"

        title = win.get("title", "?")
        handle = win.get("handle", 0)
        return f'Active Window: "{title}" (handle=0x{handle:X})'
    except Exception:
        return "Active Window: Unknown"


def _tools_section(browser_instance, desktop_instance) -> str:
    lines = ["Tools Status:"]

    # ChromeBrowser (CDP)
    cdp_status = "Not connected"
    try:
        if browser_instance is not None:
            browser_instance.eval_js("1")
            url = browser_instance.eval_js("location.href") or "?"
            cdp_status = f"Connected — {url}"
        else:
            # Quick check without creating instance
            import threading
            result = [None]

            def _check():
                try:
                    import requests
                    r = requests.get(f"{_CDP_URL}/json", timeout=2)
                    tabs = r.json()
                    result[0] = f"Running ({len(tabs)} tabs)"
                except Exception:
                    pass

            t = threading.Thread(target=_check, daemon=True)
            t.start()
            t.join(timeout=3)
            if result[0]:
                cdp_status = result[0]
    except Exception:
        pass

    lines.append(f"  ChromeBrowser (CDP port {_CDP_PORT}): {cdp_status}")
    lines.append(f"      NOTE: This is Proxima's automated Chrome, NOT user's browser")

    # Desktop (UIAutomation)
    desktop_status = "Available"
    if desktop_instance is not None:
        try:
            if desktop_instance._win is not None:
                win_title = desktop_instance._win.window_text()
                desktop_status = f"Connected to '{win_title}'"
        except Exception:
            pass
    lines.append(f"  Desktop (UIAutomation): {desktop_status}")

    # Computer module
    lines.append(f"  Computer (window-scoped): Available")
    lines.append(f"      Use: computer.target('window name') → click/type/screenshot")

    return "\n".join(lines)


def _get_cdp_chrome_titles() -> set:
    titles = set()
    try:
        import threading
        result = [None]

        def _fetch():
            try:
                import requests
                r = requests.get(f"{_CDP_URL}/json", timeout=2)
                result[0] = r.json()
            except Exception:
                pass

        t = threading.Thread(target=_fetch, daemon=True)
        t.start()
        t.join(timeout=3)

        if result[0]:
            for tab in result[0]:
                title = tab.get("title", "")
                if title:
                    titles.add(title.lower())
    except Exception:
        pass
    return titles


def _classify_window(title: str, class_name: str, cdp_titles: set,
                     handle: int = 0) -> tuple:
    title_lower = title.lower()

    # Only special case: our own CDP Chrome
    if title_lower in cdp_titles:
        return (
            "Proxima Chrome (CDP — automated)",
            "ChromeBrowser (b.goto, b.fill, b.click_text, etc.)"
        )

    # Get process name for this window
    process = _get_process_name(handle) if handle else "unknown"

    # System/background windows — skip noise
    system_classes = {"shell_traydll", "shell_tray", "progman",
                      "windows.ui", "inputapp", "corewindow"}
    if class_name.lower().replace("_", "").replace(".", "") in system_classes:
        return ("System", "Background — usually not interactive")

    # Everything else: show process name, generic suggestion
    return (
        f"{process}",
        f"Desktop.connect('{title[:50]}') or computer.target('{title[:50]}')"
    )


def _get_process_name(handle: int) -> str:
    if _OS == "Windows":
        return _get_process_name_win(handle)
    elif _OS == "Darwin":
        return _get_process_name_mac(handle)
    else:
        return _get_process_name_linux(handle)


def _get_process_name_win(handle: int) -> str:
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        psapi = ctypes.windll.psapi

        # Get process ID from window handle
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))

        if pid.value == 0:
            return "unknown"

        # Open process with query rights
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        proc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)

        if not proc:
            return f"pid:{pid.value}"

        try:
            # Get executable path
            buf = ctypes.create_unicode_buffer(260)
            size = wintypes.DWORD(260)
            if kernel32.QueryFullProcessImageNameW(proc, 0, buf, ctypes.byref(size)):
                # Return just the exe name without path
                path = buf.value
                return path.rsplit("\\", 1)[-1] if "\\" in path else path
            return f"pid:{pid.value}"
        finally:
            kernel32.CloseHandle(proc)

    except Exception:
        return "unknown"


def _get_process_name_mac(handle: int) -> str:
    try:
        import subprocess
        result = subprocess.run(
            ["osascript", "-e",
             'tell application "System Events" to get name of first process '
             'whose frontmost is true'],
            capture_output=True, text=True, timeout=3
        )
        return result.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def _get_process_name_linux(handle: int) -> str:
    try:
        import subprocess
        # Get PID from window ID using xdotool
        result = subprocess.run(
            ["xdotool", "getwindowpid", str(handle)],
            capture_output=True, text=True, timeout=3
        )
        pid = result.stdout.strip()
        if pid:
            # Read process name from /proc
            with open(f"/proc/{pid}/comm", "r") as f:
                return f.read().strip()
        return "unknown"
    except Exception:
        return "unknown"
