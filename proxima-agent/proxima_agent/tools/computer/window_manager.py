"""Proxima — Window Manager.
Cross-platform window enumeration, finding, and targeting.
"""

import platform

_OS = platform.system()


def _configure_user32(user32):
    """Configures HWND argtypes/restypes to prevent 64-bit pointer truncation on Windows."""
    import ctypes
    from ctypes import wintypes
    if getattr(user32, "_proxima_prototyped", False):
        return
    HWND = ctypes.c_void_p
    user32.GetForegroundWindow.restype = HWND
    user32.GetForegroundWindow.argtypes = []
    user32.IsWindowVisible.argtypes = [HWND]
    user32.IsWindowVisible.restype = ctypes.c_bool
    user32.GetWindowTextLengthW.argtypes = [HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [HWND, ctypes.c_wchar_p, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.GetClassNameW.argtypes = [HWND, ctypes.c_wchar_p, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetWindowRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = ctypes.c_bool
    user32.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.SetForegroundWindow.argtypes = [HWND]
    user32.SetForegroundWindow.restype = ctypes.c_bool
    user32.ShowWindow.argtypes = [HWND, ctypes.c_int]
    user32.ShowWindow.restype = ctypes.c_bool
    user32.GetCurrentThreadId.argtypes = []
    user32.GetCurrentThreadId.restype = wintypes.DWORD
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, ctypes.c_bool]
    user32.AttachThreadInput.restype = ctypes.c_bool
    user32.EnumWindows.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.EnumWindows.restype = ctypes.c_bool
    user32._proxima_prototyped = True



# macOS exposes no stable window handle, so we synthesize a stable one from app + title.
_MAC_WINDOWS: dict[int, dict] = {}


def _mac_handle(app: str, title: str) -> int:
    import hashlib
    key = f"{app}|{title}"
    h = int(hashlib.sha1(key.encode("utf-8")).hexdigest()[:8], 16) or 1
    _MAC_WINDOWS[h] = {"app": app, "title": title}
    return h


def _is_wayland() -> bool:
    """True on a Wayland session where X11 tools do not work."""
    import os
    if os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
        return True
    return bool(os.environ.get("WAYLAND_DISPLAY")) and not os.environ.get("DISPLAY")


def _linux_session_note() -> str:
    import shutil
    if _is_wayland():
        return ("This is a WAYLAND session — X11 window automation (xdotool/wmctrl) "
                "and pyautogui input do not work here. Log into an 'Xorg'/X11 session, "
                "or use the browser (CDP) tools instead.")
    missing = [t for t in ("xdotool", "wmctrl") if not shutil.which(t)]
    if missing:
        return (f"Missing Linux tool(s): {', '.join(missing)}. Install them "
                f"(e.g. 'sudo apt install xdotool wmctrl') for window automation, "
                f"or use the browser (CDP) tools.")
    return ""


def enumerate_windows() -> list[dict]:
    if _OS == "Windows":
        return _windows_enumerate()
    elif _OS == "Darwin":
        return _mac_enumerate()
    else:
        return _linux_enumerate()


def get_active_window() -> dict | None:
    if _OS == "Windows":
        return _windows_active()
    elif _OS == "Darwin":
        return _mac_active()
    else:
        return _linux_active()


def find_window(query: str) -> dict | None:
    query_lower = query.lower()
    for win in enumerate_windows():
        if query_lower in win.get("title", "").lower():
            return win
    return None


def get_window_rect(handle: int) -> dict | None:
    if _OS == "Windows":
        return _windows_rect(handle)
    elif _OS == "Linux":
        return _linux_rect(handle)
    elif _OS == "Darwin":
        return _mac_rect(handle)
    return None


def focus_window(handle: int) -> bool:
    if _OS == "Windows":
        return _windows_focus(handle)
    elif _OS == "Darwin":
        return _mac_focus(handle)
    else:
        return _linux_focus(handle)




def _windows_enumerate() -> list[dict]:
    import ctypes
    import ctypes.wintypes

    user32 = ctypes.windll.user32
    _configure_user32(user32)
    
    # Get display info for mapping windows to monitors
    from .display_info import enumerate_displays
    displays = enumerate_displays()

    results = []

    def _enum_callback(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value
        if not title.strip():
            return True

        rect = ctypes.wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        x, y = rect.left, rect.top
        width = rect.right - rect.left
        height = rect.bottom - rect.top

        if width <= 0 or height <= 0:
            return True

        # Skip offscreen windows (minimized to negative coords but still "visible")
        if x < -10000 or y < -10000:
            return True

        # Determine which display this window is on
        center_x = x + width // 2
        center_y = y + height // 2
        display_index = 0
        for i, disp in enumerate(displays):
            dx, dy = disp["position"]["x"], disp["position"]["y"]
            dw, dh = disp["size"]["width"], disp["size"]["height"]
            if dx <= center_x < dx + dw and dy <= center_y < dy + dh:
                display_index = i
                break

        pid = ctypes.wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

        # Get class name (helps identify app type)
        class_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_buf, 256)

        results.append({
            "title": title,
            "handle": hwnd,
            "position": {"x": x, "y": y},
            "size": {"width": width, "height": height},
            "display": display_index,
            "process_id": pid.value,
            "class_name": class_buf.value,
        })
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    user32.EnumWindows(WNDENUMPROC(_enum_callback), 0)

    return results


def _windows_active() -> dict | None:
    import ctypes
    import ctypes.wintypes

    user32 = ctypes.windll.user32
    _configure_user32(user32)
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None

    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)

    rect = ctypes.wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))

    return {
        "title": buf.value,
        "handle": hwnd,
        "position": {"x": rect.left, "y": rect.top},
        "size": {
            "width": rect.right - rect.left,
            "height": rect.bottom - rect.top,
        },
    }


def _windows_rect(handle: int) -> dict | None:
    import ctypes
    import ctypes.wintypes

    user32 = ctypes.windll.user32
    _configure_user32(user32)
    rect = ctypes.wintypes.RECT()
    result = user32.GetWindowRect(handle, ctypes.byref(rect))
    if not result:
        return None

    return {
        "x": rect.left,
        "y": rect.top,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    }


def _windows_focus(handle: int) -> bool:
    import ctypes

    user32 = ctypes.windll.user32
    _configure_user32(user32)
    # Attach thread input to allow SetForegroundWindow from background
    current_thread = user32.GetCurrentThreadId()
    target_thread = user32.GetWindowThreadProcessId(handle, None)
    if current_thread != target_thread:
        user32.AttachThreadInput(current_thread, target_thread, True)
    
    user32.ShowWindow(handle, 9)  # SW_RESTORE
    result = user32.SetForegroundWindow(handle)
    
    if current_thread != target_thread:
        user32.AttachThreadInput(current_thread, target_thread, False)
    
    return bool(result)




def _mac_enumerate() -> list[dict]:
    import subprocess

    try:
        script = '''
        tell application "System Events"
            set windowList to {}
            repeat with proc in (processes whose visible is true)
                try
                    repeat with win in windows of proc
                        set winName to name of win
                        set winPos to position of win
                        set winSize to size of win
                        set appName to name of proc
                        set end of windowList to appName & "|" & winName & "|" & (item 1 of winPos as text) & "|" & (item 2 of winPos as text) & "|" & (item 1 of winSize as text) & "|" & (item 2 of winSize as text)
                    end repeat
                end try
            end repeat
            set AppleScript's text item delimiters to linefeed
            return windowList as text
        end tell
        '''
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10
        )
        windows = []
        for entry in result.stdout.strip().split("\n"):
            entry = entry.strip()
            if not entry:
                continue
            parts = entry.split("|")
            if len(parts) >= 6:
                windows.append({
                    "title": parts[1],
                    # Synthetic stable handle (app|title) so focus/rect can
                    # re-resolve this window later — macOS exposes no real handle.
                    "handle": _mac_handle(parts[0], parts[1]),
                    "position": {"x": int(parts[2]), "y": int(parts[3])},
                    "size": {"width": int(parts[4]), "height": int(parts[5])},
                    "display": 0,
                    "app": parts[0],
                })
        return windows
    except Exception:
        return []


def _mac_active() -> dict | None:
    import subprocess

    try:
        script = '''
        tell application "System Events"
            set frontApp to first process whose frontmost is true
            set winName to name of first window of frontApp
            set winPos to position of first window of frontApp
            set winSize to size of first window of frontApp
            return (name of frontApp) & "|" & winName & "|" & (item 1 of winPos) & "|" & (item 2 of winPos) & "|" & (item 1 of winSize) & "|" & (item 2 of winSize)
        end tell
        '''
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5
        )
        parts = result.stdout.strip().split("|")
        if len(parts) >= 6:
            return {
                "title": parts[1],
                "handle": _mac_handle(parts[0], parts[1]),
                "position": {"x": int(parts[2]), "y": int(parts[3])},
                "size": {"width": int(parts[4]), "height": int(parts[5])},
                "app": parts[0],
            }
    except Exception:
        pass
    return None


def _mac_focus(handle: int) -> bool:
    import subprocess
    info = _MAC_WINDOWS.get(handle)
    if not info:
        return False
    app = info["app"].replace('"', '')
    title = info["title"].replace('"', '')
    try:
        script = f'''
        tell application "{app}" to activate
        delay 0.1
        tell application "System Events"
            tell process "{app}"
                set frontmost to true
                try
                    perform action "AXRaise" of (first window whose name is "{title}")
                end try
            end tell
        end tell
        return "ok"
        '''
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=8
        )
        return "ok" in (result.stdout or "")
    except Exception:
        return False


def _mac_rect(handle: int) -> dict | None:
    import subprocess
    info = _MAC_WINDOWS.get(handle)
    if not info:
        return None
    app = info["app"].replace('"', '')
    title = info["title"].replace('"', '')
    try:
        script = f'''
        tell application "System Events"
            tell process "{app}"
                set w to (first window whose name is "{title}")
                set p to position of w
                set s to size of w
                return ((item 1 of p) as text) & "|" & ((item 2 of p) as text) & "|" & ((item 1 of s) as text) & "|" & ((item 2 of s) as text)
            end tell
        end tell
        '''
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=8
        )
        parts = (result.stdout or "").strip().split("|")
        if len(parts) == 4:
            return {
                "x": int(float(parts[0])), "y": int(float(parts[1])),
                "width": int(float(parts[2])), "height": int(float(parts[3])),
            }
    except Exception:
        pass
    return None




def _linux_enumerate() -> list[dict]:
    import subprocess
    import shutil

    if shutil.which("wmctrl"):
        try:
            result = subprocess.run(
                ["wmctrl", "-l", "-G"],
                capture_output=True, text=True, timeout=5
            )
            windows = []
            for line in result.stdout.strip().split("\n"):
                parts = line.split(None, 7)
                if len(parts) >= 8:
                    windows.append({
                        "title": parts[7],
                        "handle": int(parts[0], 16),
                        "position": {"x": int(parts[2]), "y": int(parts[3])},
                        "size": {"width": int(parts[4]), "height": int(parts[5])},
                        "display": 0,  # TODO: detect from position
                    })
            return windows
        except Exception:
            pass

    # Fallback: xdotool (often present even when wmctrl isn't). Enumerates
    # visible windows and queries each one's geometry. Bounded to 60 windows.
    if shutil.which("xdotool"):
        try:
            ids = subprocess.run(
                ["xdotool", "search", "--onlyvisible", "--name", ""],
                capture_output=True, text=True, timeout=5
            ).stdout.split()
            windows = []
            for wid in ids[:60]:
                try:
                    name = subprocess.run(
                        ["xdotool", "getwindowname", wid],
                        capture_output=True, text=True, timeout=3
                    ).stdout.strip()
                    if not name:
                        continue
                    geom = subprocess.run(
                        ["xdotool", "getwindowgeometry", "--shell", wid],
                        capture_output=True, text=True, timeout=3
                    ).stdout
                    info = {}
                    for ln in geom.split("\n"):
                        if "=" in ln:
                            k, v = ln.split("=", 1)
                            info[k.strip()] = v.strip()
                    windows.append({
                        "title": name,
                        "handle": int(wid),
                        "position": {"x": int(info.get("X", 0)), "y": int(info.get("Y", 0))},
                        "size": {"width": int(info.get("WIDTH", 0)), "height": int(info.get("HEIGHT", 0))},
                        "display": 0,
                    })
                except Exception:
                    continue
            return windows
        except Exception:
            pass
    return []


def _linux_active() -> dict | None:
    import subprocess
    import shutil

    if shutil.which("xdotool"):
        try:
            wid = subprocess.run(
                ["xdotool", "getactivewindow"],
                capture_output=True, text=True, timeout=5
            ).stdout.strip()
            name = subprocess.run(
                ["xdotool", "getactivewindow", "getwindowname"],
                capture_output=True, text=True, timeout=5
            ).stdout.strip()
            geom = subprocess.run(
                ["xdotool", "getactivewindow", "getwindowgeometry", "--shell"],
                capture_output=True, text=True, timeout=5
            ).stdout.strip()
            
            info = {}
            for line in geom.split("\n"):
                if "=" in line:
                    k, v = line.split("=", 1)
                    info[k.strip()] = int(v.strip())
            
            return {
                "title": name,
                "handle": int(wid),
                "position": {"x": info.get("X", 0), "y": info.get("Y", 0)},
                "size": {"width": info.get("WIDTH", 0), "height": info.get("HEIGHT", 0)},
            }
        except Exception:
            pass
    return None


def _linux_rect(handle: int) -> dict | None:
    import subprocess
    import shutil

    if not shutil.which("xdotool"):
        return None
    try:
        out = subprocess.run(
            ["xdotool", "getwindowgeometry", "--shell", str(handle)],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        info = {}
        for line in out.split("\n"):
            if "=" in line:
                k, v = line.split("=", 1)
                info[k.strip()] = v.strip()
        if "X" in info and "WIDTH" in info:
            return {
                "x": int(info["X"]),
                "y": int(info["Y"]),
                "width": int(info["WIDTH"]),
                "height": int(info["HEIGHT"]),
            }
    except Exception:
        pass
    return None


def _linux_focus(handle: int) -> bool:
    import subprocess
    import shutil

    if shutil.which("wmctrl"):
        try:
            subprocess.run(
                ["wmctrl", "-i", "-a", hex(handle)],
                timeout=5
            )
            return True
        except Exception:
            pass
    elif shutil.which("xdotool"):
        try:
            subprocess.run(
                ["xdotool", "windowactivate", str(handle)],
                timeout=5
            )
            return True
        except Exception:
            pass
    return False
