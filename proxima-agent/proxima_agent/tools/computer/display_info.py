"""Proxima — Display Information.
Cross-platform multi-monitor detection.
"""

import platform

_OS = platform.system()


def enumerate_displays() -> list[dict]:
    if _OS == "Windows":
        return _windows_displays()
    elif _OS == "Darwin":
        return _mac_displays()
    else:
        return _linux_displays()


def get_primary_display() -> dict | None:
    for disp in enumerate_displays():
        if disp.get("primary"):
            return disp
    # Fallback: return first display
    displays = enumerate_displays()
    return displays[0] if displays else None


def get_virtual_screen_size() -> dict:
    displays = enumerate_displays()
    if not displays:
        return {"width": 1920, "height": 1080, "x_min": 0, "y_min": 0, "x_max": 1920, "y_max": 1080}
    
    x_min = min(d["position"]["x"] for d in displays)
    y_min = min(d["position"]["y"] for d in displays)
    x_max = max(d["position"]["x"] + d["size"]["width"] for d in displays)
    y_max = max(d["position"]["y"] + d["size"]["height"] for d in displays)
    
    return {
        "width": x_max - x_min,
        "height": y_max - y_min,
        "x_min": x_min,
        "y_min": y_min,
        "x_max": x_max,
        "y_max": y_max,
    }




def _windows_displays() -> list[dict]:
    import ctypes
    import ctypes.wintypes

    displays = []

    class MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.wintypes.DWORD),
            ("rcMonitor", ctypes.wintypes.RECT),
            ("rcWork", ctypes.wintypes.RECT),
            ("dwFlags", ctypes.wintypes.DWORD),
        ]

    def _monitor_callback(hmonitor, hdc, lprect, lparam):
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        ctypes.windll.user32.GetMonitorInfoW(hmonitor, ctypes.byref(info))

        work = info.rcWork
        monitor = info.rcMonitor
        is_primary = bool(info.dwFlags & 1)  # MONITORINFOF_PRIMARY

        # Get DPI for this monitor (Windows 8.1+)
        scale = 1.0
        try:
            dpi_x = ctypes.c_uint()
            dpi_y = ctypes.c_uint()
            ctypes.windll.shcore.GetDpiForMonitor(
                hmonitor, 0,  # MDT_EFFECTIVE_DPI
                ctypes.byref(dpi_x), ctypes.byref(dpi_y)
            )
            scale = dpi_x.value / 96.0
        except Exception:
            pass

        displays.append({
            "index": len(displays),
            "name": f"Monitor {len(displays) + 1}",
            "position": {"x": monitor.left, "y": monitor.top},
            "size": {
                "width": monitor.right - monitor.left,
                "height": monitor.bottom - monitor.top,
            },
            "work_area": {
                "x": work.left,
                "y": work.top,
                "width": work.right - work.left,
                "height": work.bottom - work.top,
            },
            "primary": is_primary,
            "scale": round(scale, 2),
        })
        return True

    MONITORENUMPROC = ctypes.WINFUNCTYPE(
        ctypes.c_bool,
        ctypes.c_void_p,   # hMonitor
        ctypes.c_void_p,   # hDC
        ctypes.c_void_p,   # lprcMonitor
        ctypes.c_void_p,   # lParam
    )
    ctypes.windll.user32.EnumDisplayMonitors(
        None, None, MONITORENUMPROC(_monitor_callback), 0
    )

    # Sort: primary first
    displays.sort(key=lambda d: (not d["primary"], d["index"]))
    for i, d in enumerate(displays):
        d["index"] = i

    return displays




def _mac_displays() -> list[dict]:
    import subprocess
    import json

    try:
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType", "-json"],
            capture_output=True, text=True, timeout=10
        )
        data = json.loads(result.stdout)
        displays = []

        for gpu in data.get("SPDisplaysDataType", []):
            for disp in gpu.get("spdisplays_ndrvs", []):
                resolution = disp.get("_spdisplays_resolution", "")
                # Parse "1920 x 1080" format
                parts = resolution.replace("Retina", "").strip().split(" x ")
                width = int(parts[0].strip()) if len(parts) >= 2 else 1920
                height = int(parts[1].split()[0].strip()) if len(parts) >= 2 else 1080

                displays.append({
                    "index": len(displays),
                    "name": disp.get("_name", f"Display {len(displays) + 1}"),
                    "position": {"x": 0, "y": 0},  # macOS doesn't easily expose this
                    "size": {"width": width, "height": height},
                    "primary": len(displays) == 0,
                    "scale": 2.0 if "Retina" in resolution else 1.0,
                })
        return displays if displays else _fallback_display()
    except Exception:
        return _fallback_display()




def _linux_displays() -> list[dict]:
    import subprocess
    import shutil
    import re

    if not shutil.which("xrandr"):
        return _fallback_display()

    try:
        result = subprocess.run(
            ["xrandr", "--query"],
            capture_output=True, text=True, timeout=5
        )
        displays = []
        # Match lines like: "HDMI-1 connected primary 1920x1080+0+0"
        pattern = re.compile(
            r'^(\S+)\s+connected\s*(primary)?\s*(\d+)x(\d+)\+(\d+)\+(\d+)',
            re.MULTILINE
        )
        for match in pattern.finditer(result.stdout):
            name, primary, w, h, x, y = match.groups()
            displays.append({
                "index": len(displays),
                "name": name,
                "position": {"x": int(x), "y": int(y)},
                "size": {"width": int(w), "height": int(h)},
                "primary": primary is not None,
                "scale": 1.0,
            })
        return displays if displays else _fallback_display()
    except Exception:
        return _fallback_display()




def _fallback_display() -> list[dict]:
    return [{
        "index": 0,
        "name": "Display 1",
        "position": {"x": 0, "y": 0},
        "size": {"width": 1920, "height": 1080},
        "primary": True,
        "scale": 1.0,
    }]
