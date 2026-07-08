"""Window-scoped Actions — click, type, screenshot relative to a target window.

All actions are scoped to a specific window handle.
Coordinates are RELATIVE to the window's top-left corner.

This module converts window-relative coordinates to screen coordinates
and sends input to the correct window, even on multi-monitor setups.
"""

import platform
import time

_OS = platform.system()


def click_in_window(handle: int, x: int, y: int, button: str = "left",
                     double: bool = False) -> str:
    """Click at (x, y) relative to a window — smart wrapper.

    Coordinates are window-relative PHYSICAL pixels. The process is DPI-aware
    (set at worker startup), so the window rect, screen metrics, screenshots and
    these coordinates all share ONE physical-pixel space — no DPI scaling is
    applied here (doing so would double-count DPI and miss the target).

    Steps:
      1. Get live window position & size (get_window_rect)
      2. Bounds-check the window-relative coordinates
      3. Convert to absolute screen coordinates
      4. Focus the window + verify it is the foreground window (retry up to 3x)
      5. Click via SendInput (Windows) or pyautogui fallback

    Args:
        handle: Window handle (HWND on Windows, int on Linux, 0 on Mac)
        x: X coordinate relative to window's top-left
        y: Y coordinate relative to window's top-left
        button: 'left', 'right', or 'middle'
        double: True for double-click

    Returns:
        Status message (success or error)
    """
    from .window_manager import get_window_rect, focus_window, get_active_window

    # ── Step 1: Get LIVE window position & size from OS ──
    rect = get_window_rect(handle)
    if not rect:
        # Honest, actionable failure instead of a dead-end error — route the
        # agent to tools that DO work on this OS rather than silently missing.
        hint = ""
        if _OS == "Linux":
            try:
                from .window_manager import _linux_session_note
                note = _linux_session_note()
                if note:
                    hint = " " + note
            except Exception:
                pass
        elif _OS == "Darwin":
            hint = (" On macOS, grant the app Accessibility + Screen-Recording "
                    "permission (System Settings → Privacy), or use the browser "
                    "(b.click_text) / desktop tools.")
        return (
            f"Error: could not resolve window {handle}'s rect. Re-target with "
            f"computer.target('<title>'), or use the browser (b.click_text / "
            f"b.click) or OCR click_text — these work on every OS.{hint}"
        )

    # ── Step 2: Bounds check (window-relative, physical pixels) ──
    if x < 0 or y < 0 or x > rect["width"] or y > rect["height"]:
        return (
            f"Error: Coords ({x},{y}) are outside the window "
            f"({rect['width']}x{rect['height']})"
        )

    # ── Step 3: Convert window-relative → absolute screen coordinates ──
    screen_x = rect["x"] + x
    screen_y = rect["y"] + y

    # ── Step 4: Focus window + verify (retry up to 3x) ──
    focus_ok = _focus_and_verify(handle, focus_window, get_active_window)
    if not focus_ok:
        return f"Error: Could not focus window handle {handle} after 3 retries"

    # ── Step 5: Re-fetch window rect (focus may have moved it) ──
    rect_after = get_window_rect(handle)
    if rect_after and (rect_after["x"] != rect["x"] or rect_after["y"] != rect["y"]):
        # Window moved during focus (e.g. restored from minimized) — recalculate
        screen_x = rect_after["x"] + x
        screen_y = rect_after["y"] + y

    # ── Step 6: Click ──
    if _OS == "Windows":
        return _windows_click(handle, screen_x, screen_y, button, double)
    else:
        return _fallback_click(screen_x, screen_y, button, double)


def _focus_and_verify(handle: int, focus_fn, active_fn, max_retries: int = 3) -> bool:
    """Focus a window and verify it actually became the foreground window.
    
    Retries up to max_retries times. Uses OS-native active window detection
    to verify — doesn't trust the focus call's return value alone.
    
    Args:
        handle: Window handle to focus
        focus_fn: focus_window function
        active_fn: get_active_window function
        max_retries: Maximum focus attempts
    
    Returns:
        True if window is confirmed active, False if all retries failed
    """
    for attempt in range(max_retries):
        focus_fn(handle)
        time.sleep(0.1 + attempt * 0.1)  # increasing backoff: 100ms, 200ms, 300ms

        active = active_fn()
        if active and active.get("handle") == handle:
            return True

    return False


def type_in_window(handle: int, text: str, interval: float = 0.02) -> str:
    """Type text into a specific window.
    
    Focuses the window first, then types. Uses the most reliable method
    available for the OS.
    
    Args:
        handle: Window handle
        text: Text to type
        interval: Delay between characters (seconds)
    
    Returns:
        Status message
    """
    if _OS == "Windows":
        return _windows_type(handle, text, interval)
    else:
        return _fallback_type(handle, text, interval)


def screenshot_window(handle: int, path: str = "window_screenshot.png") -> str:
    """Take a screenshot of a specific window only (not full screen).
    
    Args:
        handle: Window handle
        path: File path to save the screenshot
    
    Returns:
        Status message with file path
    """
    if _OS == "Windows":
        result = _windows_screenshot(handle, path)
    else:
        result = _fallback_screenshot(handle, path)
    # Auto-queue the screenshot for the model (only on success — failures start
    # with "Screenshot failed"/"Error").
    try:
        if isinstance(result, str) and "saved" in result.lower():
            from proxima_agent.tools.attach import note_screenshot
            result += note_screenshot(path)
    except Exception:
        pass
    return result





# ─── Windows Backend ────────────────────────────────────────────

def _windows_click(handle: int, screen_x: int, screen_y: int,
                    button: str, double: bool) -> str:
    """Click using Win32 SendInput — works without stealing focus from terminal."""
    import ctypes

    # Focus already handled by click_in_window -> _focus_and_verify

    # Use SendInput for reliable clicking
    INPUT_MOUSE = 0
    MOUSEEVENTF_MOVE = 0x0001
    MOUSEEVENTF_LEFTDOWN = 0x0002
    MOUSEEVENTF_LEFTUP = 0x0004
    MOUSEEVENTF_RIGHTDOWN = 0x0008
    MOUSEEVENTF_RIGHTUP = 0x0010
    MOUSEEVENTF_MIDDLEDOWN = 0x0020
    MOUSEEVENTF_MIDDLEUP = 0x0040
    MOUSEEVENTF_ABSOLUTE = 0x8000
    # Map absolute coordinates across the ENTIRE virtual desktop (all monitors).
    # This is REQUIRED because the coordinates below are normalized against the
    # virtual-screen metrics (SM_*VIRTUALSCREEN). Without VIRTUALDESK the OS
    # interprets the absolute point relative to the PRIMARY monitor only, so
    # every click on a secondary monitor — or any layout with a negative-origin
    # monitor (e.g. secondary-on-left) — lands on the wrong spot. This was the
    # root cause of "clicks land in the wrong place" on multi-monitor setups.
    MOUSEEVENTF_VIRTUALDESK = 0x4000

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", ctypes.c_long),
            ("dy", ctypes.c_long),
            ("mouseData", ctypes.c_ulong),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class INPUT(ctypes.Structure):
        class _INPUT(ctypes.Union):
            _fields_ = [("mi", MOUSEINPUT)]
        _fields_ = [
            ("type", ctypes.c_ulong),
            ("_input", _INPUT),
        ]

    # Convert to absolute coordinates (0-65535 range)
    sm_cx = ctypes.windll.user32.GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
    sm_cy = ctypes.windll.user32.GetSystemMetrics(79)  # SM_CYVIRTUALSCREEN
    sm_x = ctypes.windll.user32.GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
    sm_y = ctypes.windll.user32.GetSystemMetrics(77)   # SM_YVIRTUALSCREEN

    # Normalize the physical pixel onto the 0..65535 absolute range SendInput
    # expects. Divide by (extent - 1) so the last pixel maps exactly to 65535
    # (MS-documented normalization), guard against degenerate/zero metrics, and
    # clamp so a slightly off-screen target can never wrap to the opposite edge.
    span_x = (sm_cx - 1) if sm_cx > 1 else 1
    span_y = (sm_cy - 1) if sm_cy > 1 else 1
    abs_x = max(0, min(65535, round((screen_x - sm_x) * 65535 / span_x)))
    abs_y = max(0, min(65535, round((screen_y - sm_y) * 65535 / span_y)))

    # Button flags
    if button == "right":
        down_flag = MOUSEEVENTF_RIGHTDOWN
        up_flag = MOUSEEVENTF_RIGHTUP
    elif button == "middle":
        down_flag = MOUSEEVENTF_MIDDLEDOWN
        up_flag = MOUSEEVENTF_MIDDLEUP
    else:
        down_flag = MOUSEEVENTF_LEFTDOWN
        up_flag = MOUSEEVENTF_LEFTUP

    def make_input(flags):
        inp = INPUT()
        inp.type = INPUT_MOUSE
        inp._input.mi.dx = abs_x
        inp._input.mi.dy = abs_y
        inp._input.mi.dwFlags = flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE | MOUSEEVENTF_VIRTUALDESK
        return inp

    clicks = 2 if double else 1
    for _ in range(clicks):
        inputs = (INPUT * 2)(make_input(down_flag), make_input(up_flag))
        ctypes.windll.user32.SendInput(2, inputs, ctypes.sizeof(INPUT))
        if double:
            time.sleep(0.05)

    return f"Clicked ({screen_x}, {screen_y}) button={button} double={double}"


def _windows_type(handle: int, text: str, interval: float) -> str:
    """Type text into a window using SendInput on Windows."""
    import ctypes
    import struct

    from .window_manager import focus_window
    focus_window(handle)
    time.sleep(0.15)

    INPUT_KEYBOARD = 1
    KEYEVENTF_UNICODE = 0x0004
    KEYEVENTF_KEYUP = 0x0002

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", ctypes.c_ushort),
            ("wScan", ctypes.c_ushort),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class INPUT(ctypes.Structure):
        class _INPUT(ctypes.Union):
            _fields_ = [("ki", KEYBDINPUT)]
        _fields_ = [
            ("type", ctypes.c_ulong),
            ("_input", _INPUT),
        ]

    # Iterate UTF-16-LE code units so non-BMP characters (emoji, etc.) are sent
    # as their surrogate pair instead of overflowing the 16-bit scan field
    # (ord(ch) > 0xFFFF would wrap and type the wrong character).
    _utf16 = text.encode("utf-16-le") if text else b""
    code_units = struct.unpack(f"<{len(_utf16) // 2}H", _utf16) if _utf16 else ()

    for cu in code_units:
        inp_down = INPUT()
        inp_down.type = INPUT_KEYBOARD
        inp_down._input.ki.wScan = cu
        inp_down._input.ki.dwFlags = KEYEVENTF_UNICODE

        inp_up = INPUT()
        inp_up.type = INPUT_KEYBOARD
        inp_up._input.ki.wScan = cu
        inp_up._input.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP

        inputs = (INPUT * 2)(inp_down, inp_up)
        ctypes.windll.user32.SendInput(2, inputs, ctypes.sizeof(INPUT))

        if interval > 0:
            time.sleep(interval)

    return f"Typed {len(text)} chars into window {handle}"


def _windows_screenshot(handle: int, path: str) -> str:
    """Screenshot a specific window on Windows using PrintWindow."""
    import ctypes
    import ctypes.wintypes

    from .window_manager import get_window_rect
    rect = get_window_rect(handle)
    if not rect:
        return f"Error: Could not get window rect for handle {handle}"

    width = rect["width"]
    height = rect["height"]

    # Use PrintWindow API to capture even partially hidden windows
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32

    hwnd_dc = user32.GetWindowDC(handle)
    mem_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bitmap = gdi32.CreateCompatibleBitmap(hwnd_dc, width, height)
    gdi32.SelectObject(mem_dc, bitmap)

    # PrintWindow with PW_RENDERFULLCONTENT flag (2) for better capture
    user32.PrintWindow(handle, mem_dc, 2)

    # Save using PIL if available
    try:
        from PIL import Image
        import io

        # Get bitmap data
        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [
                ("biSize", ctypes.c_ulong),
                ("biWidth", ctypes.c_long),
                ("biHeight", ctypes.c_long),
                ("biPlanes", ctypes.c_ushort),
                ("biBitCount", ctypes.c_ushort),
                ("biCompression", ctypes.c_ulong),
                ("biSizeImage", ctypes.c_ulong),
                ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long),
                ("biClrUsed", ctypes.c_ulong),
                ("biClrImportant", ctypes.c_ulong),
            ]

        bmi = BITMAPINFOHEADER()
        bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.biWidth = width
        bmi.biHeight = -height  # Top-down
        bmi.biPlanes = 1
        bmi.biBitCount = 32
        bmi.biCompression = 0  # BI_RGB

        buffer = ctypes.create_string_buffer(width * height * 4)
        gdi32.GetDIBits(mem_dc, bitmap, 0, height, buffer, ctypes.byref(bmi), 0)

        img = Image.frombuffer("RGBA", (width, height), buffer, "raw", "BGRA", 0, 1)
        img.save(path)
        result = f"Window screenshot saved: {path} ({width}x{height})"
    except ImportError:
        result = f"Error: PIL not available for screenshot. Install: pip install Pillow"
    finally:
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(handle, hwnd_dc)

    return result


# ─── Fallback (pyautogui) ──────────────────────────────────────

def _fallback_click(screen_x: int, screen_y: int, button: str, double: bool) -> str:
    """Fallback click using pyautogui (cross-platform: Windows/macOS/Linux-X11)."""
    if _OS == "Linux":
        try:
            from .window_manager import _is_wayland, _linux_session_note
            if _is_wayland():
                return "Error: " + (_linux_session_note() or "Wayland input not supported.")
        except Exception:
            pass
    try:
        import pyautogui
        clicks = 2 if double else 1
        pyautogui.click(screen_x, screen_y, button=button, clicks=clicks)
        return f"Clicked ({screen_x}, {screen_y}) via pyautogui"
    except ImportError:
        return "Error: No click backend available (install pyautogui)"


def _fallback_type(handle: int, text: str, interval: float) -> str:
    """Fallback type using pyautogui (cross-platform: Windows/macOS/Linux-X11)."""
    if _OS == "Linux":
        try:
            from .window_manager import _is_wayland, _linux_session_note
            if _is_wayland():
                return "Error: " + (_linux_session_note() or "Wayland input not supported.")
        except Exception:
            pass
    try:
        from .window_manager import focus_window
        focus_window(handle)
        time.sleep(0.15)
        
        import pyautogui
        pyautogui.typewrite(text, interval=interval) if text.isascii() else pyautogui.write(text)
        return f"Typed {len(text)} chars via pyautogui"
    except ImportError:
        return "Error: No type backend available (install pyautogui)"


def _fallback_screenshot(handle: int, path: str) -> str:
    """Fallback screenshot using pyautogui (captures full screen)."""
    try:
        import pyautogui
        img = pyautogui.screenshot()
        
        from .window_manager import get_window_rect
        rect = get_window_rect(handle)
        if rect:
            img = img.crop((
                rect["x"], rect["y"],
                rect["x"] + rect["width"],
                rect["y"] + rect["height"]
            ))
        
        img.save(path)
        return f"Screenshot saved: {path}"
    except ImportError:
        return "Error: No screenshot backend available (install pyautogui)"
