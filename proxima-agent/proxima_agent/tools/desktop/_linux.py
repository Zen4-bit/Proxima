"""Proxima — Linux Desktop Automation Backend.
Desktop automation via xdotool, wmctrl, and xprop on Linux.
"""

import time
import subprocess
import shutil
import os


class LinuxDesktop:

    def __init__(self):
        self._window_id = None  # X11 window ID
        self._app_name = None

        # Check available tools
        self._has_xdotool = shutil.which("xdotool") is not None
        self._has_wmctrl = shutil.which("wmctrl") is not None
        self._has_xprop = shutil.which("xprop") is not None

        if not self._has_xdotool and not self._has_wmctrl:
            raise RuntimeError(
                "xdotool or wmctrl not found.\n"
                "Install: sudo apt install xdotool wmctrl"
            )

    def _run(self, cmd: list, timeout: float = 10) -> str:
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout
            )
            return result.stdout.strip()
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Command timed out: {' '.join(cmd)}")
        except FileNotFoundError:
            raise RuntimeError(f"Command not found: {cmd[0]}")



    def windows(self) -> str:
        if self._has_wmctrl:
            output = self._run(["wmctrl", "-l", "-p"])
            lines = output.split("\n")
            formatted = []
            for i, line in enumerate(lines):
                if line.strip():
                    parts = line.split(None, 4)
                    title = parts[4] if len(parts) > 4 else "(no title)"
                    wid = parts[0] if parts else "?"
                    pid = parts[2] if len(parts) > 2 else "?"
                    formatted.append(f'  [{i}] "{title}" (wid={wid}, pid={pid})')
            return f"Found {len(formatted)} windows:\n" + "\n".join(formatted)
        elif self._has_xdotool:
            output = self._run(["xdotool", "search", "--name", ""])
            wids = output.split("\n")
            formatted = []
            for i, wid in enumerate(wids[:20]):
                if wid.strip():
                    try:
                        name = self._run(["xdotool", "getwindowname", wid])
                        formatted.append(f'  [{i}] "{name}" (wid={wid})')
                    except Exception:
                        pass
            return f"Found {len(formatted)} windows:\n" + "\n".join(formatted)
        return "No window management tool available"

    def connect(self, title: str = None, pid: int = None,
                path: str = None, handle: int = None) -> str:
        if path:
            subprocess.Popen(
                [path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            time.sleep(2)
            # Try to find the window by executable name
            self._app_name = os.path.basename(path)
            title = self._app_name

        if handle is not None:
            # Unique X11 window id — no search, no same-title ambiguity.
            self._window_id = str(handle)
        elif pid and self._has_xdotool:
            output = self._run(["xdotool", "search", "--pid", str(pid)])
            wids = output.split("\n")
            if wids and wids[0].strip():
                self._window_id = wids[0].strip()
            else:
                raise RuntimeError(f"No window found for PID {pid}")
        elif title:
            self._app_name = title
            if self._has_xdotool:
                output = self._run(
                    ["xdotool", "search", "--name", title]
                )
                wids = output.split("\n")
                if wids and wids[0].strip():
                    self._window_id = wids[0].strip()
                else:
                    raise RuntimeError(
                        f"No window matching '{title}'. Use d.windows() to see available."
                    )
            elif self._has_wmctrl:
                output = self._run(["wmctrl", "-l"])
                for line in output.split("\n"):
                    if title.lower() in line.lower():
                        self._window_id = line.split()[0]
                        break
                if not self._window_id:
                    raise RuntimeError(f"No window matching '{title}'")
        else:
            raise ValueError("Provide title, pid, or path")

        # Activate the window
        self._activate()
        win_name = self._get_window_name()
        return f'Connected to: "{win_name}"'

    def _activate(self):
        if self._window_id:
            if self._has_wmctrl:
                self._run(["wmctrl", "-i", "-a", self._window_id])
            elif self._has_xdotool:
                self._run(["xdotool", "windowactivate", self._window_id])

    def _get_window_name(self) -> str:
        if self._window_id and self._has_xdotool:
            try:
                return self._run(["xdotool", "getwindowname", self._window_id])
            except Exception:
                pass
        return self._app_name or "(unknown)"

    def focus(self) -> str:
        self._ensure_connected()
        self._activate()
        return "Window focused"

    def _ensure_connected(self):
        if not self._window_id:
            raise RuntimeError("Not connected. Use d.connect('window title') first.")

    def is_connected(self) -> bool:
        return self._window_id is not None



    def elements(self, depth: int = 3) -> str:
        self._ensure_connected()

        # Try AT-SPI via python-atspi
        try:
            import pyatspi as atspi  # module is 'pyatspi'; 'atspi' was a typo → ImportError
            # AT-SPI element discovery
            desktop = atspi.Registry.getDesktop(0)
            elements = []
            for app in desktop:
                if self._app_name and self._app_name.lower() in app.name.lower():
                    self._collect_atspi(app, elements, depth, 0)
                    break
            if elements:
                input_roles = {"text", "combo box", "search bar", "entry"}
                click_roles = {"push button", "link", "menu item", "tab", "list item", "tree item"}
                toggle_roles = {"check box", "radio button", "toggle button"}
                select_roles = {"slider", "spin button"}

                groups = {
                    "INPUT FIELDS (writable \u2014 use write_text)": [],
                    "CLICKABLE (use click)": [],
                    "TOGGLEABLE (use toggle_check)": [],
                    "SELECTION": [],
                    "OTHER": [],
                }
                for i, el_str in enumerate(elements):
                    # el_str format: '<role> "name"'
                    role = el_str.split(">")[0].lstrip("<").strip().lower() if "<" in el_str else ""
                    entry = f"  [{i}] {el_str}"
                    if role in input_roles:
                        groups["INPUT FIELDS (writable \u2014 use write_text)"].append(entry)
                    elif role in click_roles:
                        groups["CLICKABLE (use click)"].append(entry)
                    elif role in toggle_roles:
                        groups["TOGGLEABLE (use toggle_check)"].append(entry)
                    elif role in select_roles:
                        groups["SELECTION"].append(entry)
                    else:
                        groups["OTHER"].append(entry)

                out = [f"Found {len(elements)} elements:"]
                for group_name, entries in groups.items():
                    if entries:
                        out.append(f"\n\u2500\u2500 {group_name} ({len(entries)}) \u2500\u2500")
                        out.extend(entries)
                return "\n".join(out)
        except ImportError:
            pass

        # Fallback: xprop
        if self._has_xprop:
            try:
                output = self._run(["xprop", "-id", self._window_id])
                # Parse relevant properties
                lines = [
                    line for line in output.split("\n")
                    if any(k in line for k in ["WM_NAME", "WM_CLASS", "_NET_WM_PID"])
                ]
                return "Window properties:\n" + "\n".join(f"  {l}" for l in lines[:20])
            except Exception:
                pass

        return (
            "Element discovery limited on Linux.\n"
            "Install python-atspi for full UI element access:\n"
            "  pip install pyatspi  (or: sudo apt install python3-pyatspi)"
        )

    def _collect_atspi(self, node, result, max_depth, depth):
        if depth > max_depth:
            return
        try:
            role = node.getRoleName()
            name = node.name or ""
            if name and role in (
                "push button", "text", "combo box", "check box",
                "radio button", "menu item", "tab", "slider"
            ):
                result.append(f'<{role}> "{name}"')
            for i in range(node.childCount):
                self._collect_atspi(node.getChildAtIndex(i), result, max_depth, depth + 1)
        except Exception:
            pass



    def click(self, name: str, timeout: float = 5.0) -> str:
        self._ensure_connected()
        self._activate()

        # Try AT-SPI
        try:
            import pyatspi as atspi  # module is 'pyatspi'; 'atspi' was a typo → ImportError
            desktop = atspi.Registry.getDesktop(0)
            for app in desktop:
                if self._app_name and self._app_name.lower() in app.name.lower():
                    el = self._find_atspi(app, name)
                    if el:
                        action = el.queryAction()
                        if action:
                            action.doAction(0)
                            time.sleep(0.2)
                            return f"Clicked '{name}' (AT-SPI)"
        except (ImportError, Exception):
            pass

        # Fallback: xdotool type + Tab navigation (best effort)
        raise RuntimeError(
            f"click('{name}') failed: element not found.\n"
            "Install python-atspi for click-by-name support.\n"
            "Alternative: use d.keys() with Tab + Enter to navigate."
        )

    def _find_atspi(self, node, name, depth=0, max_depth=5):
        if depth > max_depth:
            return None
        try:
            if node.name and name.lower() in node.name.lower():
                return node
            for i in range(node.childCount):
                found = self._find_atspi(node.getChildAtIndex(i), name, depth + 1, max_depth)
                if found:
                    return found
        except Exception:
            pass
        return None

    def write_text(self, name: str, value: str, timeout: float = 5.0) -> str:
        self._ensure_connected()
        self._activate()

        # Try AT-SPI
        try:
            import pyatspi as atspi  # module is 'pyatspi'; 'atspi' was a typo → ImportError
            desktop = atspi.Registry.getDesktop(0)
            for app in desktop:
                if self._app_name and self._app_name.lower() in app.name.lower():
                    el = self._find_atspi(app, name)
                    if el:
                        text_iface = el.queryEditableText()
                        if text_iface:
                            text_iface.setTextContents(value)
                            time.sleep(0.1)
                            # Read-back verification
                            try:
                                readback = el.queryText().getText(0, -1)
                                chars_v = len(readback)
                                match = readback.strip() == value.strip()
                                match_str = "MATCH" if match else f"MISMATCH (got: '{readback[:50]}')"
                                return (
                                    f"Filled '{name}' | method=AT-SPI | "
                                    f"chars_sent={len(value)}, chars_verified={chars_v}, {match_str}"
                                )
                            except Exception:
                                pass
                            return (
                                f"Filled '{name}' | method=AT-SPI | "
                                f"chars_sent={len(value)}, readback=unavailable (verify manually)"
                            )
        except (ImportError, Exception):
            pass

        # Fallback: xdotool type (requires field to be focused)
        if self._has_xdotool:
            # Clear existing and type new
            self._run(["xdotool", "key", "--window", self._window_id, "ctrl+a"])
            time.sleep(0.1)
            self._run(["xdotool", "type", "--window", self._window_id, "--clearmodifiers", value])
            return (
                f"Filled '{name}' | method=xdotool | "
                f"chars_sent={len(value)}, readback=unavailable (ensure field was focused)"
            )

        raise RuntimeError(f"fill('{name}') failed: no input method available")

    def read_text(self, name: str = None, timeout: float = 5.0) -> str:
        self._ensure_connected()

        if name is None:
            return self._get_window_name()

        # Try AT-SPI
        try:
            import pyatspi as atspi  # module is 'pyatspi'; 'atspi' was a typo → ImportError
            desktop = atspi.Registry.getDesktop(0)
            for app in desktop:
                if self._app_name and self._app_name.lower() in app.name.lower():
                    el = self._find_atspi(app, name)
                    if el:
                        try:
                            return el.queryText().getText(0, -1)
                        except Exception:
                            return el.name or ""
        except (ImportError, Exception):
            pass

        return f"(could not read text from '{name}' — install python-atspi)"

    def select(self, name: str, option: str, timeout: float = 5.0) -> str:
        self._ensure_connected()
        # Best effort via AT-SPI or keyboard
        raise RuntimeError(
            f"select('{name}', '{option}') — use d.keys() with Arrow keys.\n"
            "Install python-atspi for richer dropdown support."
        )

    def toggle_check(self, name: str, state: bool = True, timeout: float = 5.0) -> str:
        self._ensure_connected()
        # Try click via AT-SPI
        return self.click(name, timeout)

    def click_menu(self, path: str) -> str:
        self._ensure_connected()
        self._activate()

        parts = [p.strip() for p in path.replace("->", "->").split("->")]

        if self._has_xdotool:
            # Press F10 to activate menu bar, then navigate
            self._run(["xdotool", "key", "--window", self._window_id, "F10"])
            time.sleep(0.3)

            for part in parts:
                # Type the first letter to navigate, or search
                self._run(
                    ["xdotool", "type", "--window", self._window_id, "--clearmodifiers", part[0]]
                )
                time.sleep(0.2)
                self._run(["xdotool", "key", "--window", self._window_id, "Return"])
                time.sleep(0.2)

            return f"Menu: {path} (keyboard navigation)"

        raise RuntimeError("Menu navigation requires xdotool")

    def type_keys(self, keystrokes: str) -> str:
        self._ensure_connected()

        if not self._has_xdotool:
            raise RuntimeError("keys() requires xdotool")

        # Map common key names
        key_map = {
            "{ENTER}": "Return",
            "{RETURN}": "Return",
            "{TAB}": "Tab",
            "{DELETE}": "BackSpace",
            "{ESCAPE}": "Escape",
            "{SPACE}": "space",
            "^c": "ctrl+c",
            "^v": "ctrl+v",
            "^a": "ctrl+a",
            "^s": "ctrl+s",
            "^z": "ctrl+z",
        }

        key = key_map.get(keystrokes)
        if key:
            self._run(["xdotool", "key", "--window", self._window_id, key])
        else:
            # Plain text
            self._run(
                ["xdotool", "type", "--window", self._window_id, "--clearmodifiers", keystrokes]
            )

        time.sleep(0.1)
        return f"Sent keys: {keystrokes}"



    def ui_tree(self, depth: int = 4) -> str:
        return self.elements(depth=depth)

    def screenshot(self, path: str = "desktop_screenshot.png") -> str:
        """Screenshot the connected app window, falling back to full-screen if not connected."""
        if not self._window_id:
            from ..utils import screenshot as _full_screenshot
            return _full_screenshot(path)

        # Try import-based screenshot (xdotool + import from ImageMagick)
        for tool in ["import", "scrot", "gnome-screenshot"]:
            if shutil.which(tool):
                try:
                    if tool == "import":
                        self._run(
                            ["import", "-window", self._window_id, path],
                            timeout=10
                        )
                    elif tool == "scrot":
                        self._run(["scrot", "-u", path], timeout=10)
                    else:
                        self._run(
                            ["gnome-screenshot", "-w", "-f", path],
                            timeout=10
                        )
                    result = f"Window screenshot saved: {path}"
                    try:
                        from proxima_agent.tools.attach import note_screenshot
                        result += note_screenshot(path)
                    except Exception:
                        pass
                    return result
                except Exception:
                    continue

        return "Screenshot failed: no screenshot tool found (install scrot or imagemagick)"



    def close(self) -> str:
        self._ensure_connected()
        try:
            if self._has_wmctrl:
                self._run(["wmctrl", "-i", "-c", self._window_id])
            elif self._has_xdotool:
                self._run(["xdotool", "windowclose", self._window_id])
            self._window_id = None
            self._app_name = None
            return "Window closed"
        except Exception as e:
            return f"Close failed: {e}"

    def __repr__(self):
        name = self._get_window_name() if self._window_id else "not connected"
        return f'Desktop(backend="linux", window="{name}")'

    # Backward-compatible aliases
    fill = write_text
    text = read_text
    check = toggle_check
    menu = click_menu
    keys = type_keys
    tree = ui_tree

    # Synonym aliases
    list_windows = windows
    attach = connect
    open = connect
    elements_list = elements
    list_elements = elements
    click_element = click
    click_button = click
    press = click
    input_text = write_text
    set_text = write_text
    enter_text = write_text
    get_text = read_text
    read = read_text
    select_option = select
    toggle = toggle_check
    click_menu_item = click_menu
    send_keys = type_keys
    capture = screenshot
    screen_shot = screenshot
