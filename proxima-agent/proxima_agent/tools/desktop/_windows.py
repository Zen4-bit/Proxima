"""Proxima — Windows Desktop Automation Backend.
Desktop automation via pywinauto with UIA backend.
"""

import time
import re


def _escape_type_keys(text: str) -> str:
    """Escapes text for pywinauto type_keys special syntax (e.g. curly braces, newlines)."""
    out = []
    for ch in text:
        if ch == "\n":
            out.append("{ENTER}")
        elif ch == "\r":
            continue
        elif ch == "\t":
            out.append("{TAB}")
        elif ch in "{}()+^%~[]":
            out.append("{" + ch + "}")
        else:
            out.append(ch)
    return "".join(out)


def _set_clipboard(text: str) -> bool:
    """Sets clipboard text for lossless pasting instead of character-by-character typing."""
    try:
        import win32clipboard
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
        finally:
            win32clipboard.CloseClipboard()
        return True
    except Exception:
        pass
    try:
        import tkinter
        _r = tkinter.Tk()
        _r.withdraw()
        _r.clipboard_clear()
        _r.clipboard_append(text)
        _r.update()  # flush to the OS clipboard before destroying the root
        _r.destroy()
        return True
    except Exception:
        return False


class WindowsDesktop:

    def __init__(self):
        try:
            from pywinauto import Desktop as PWDesktop
            from pywinauto.application import Application
            self._Application = Application
            self._PWDesktop = PWDesktop
            self._app = None
            self._win = None
        except ImportError:
            raise RuntimeError(
                "pywinauto not installed. Run: pip install pywinauto"
            )



    def windows(self) -> str:
        desktop = self._PWDesktop(backend="uia")
        wins = desktop.windows()
        lines = []
        for i, w in enumerate(wins):
            title = w.window_text()
            if not title or title.strip() == "":
                continue
            try:
                cls = w.element_info.class_name or ""
            except Exception:
                cls = ""
            try:
                pid = w.process_id()
            except Exception:
                pid = "?"
            lines.append(f'  [{i}] "{title}" (class={cls}, pid={pid})')
        return f"Found {len(lines)} windows:\n" + "\n".join(lines)

    def connect(self, title: str = None, pid: int = None,
                path: str = None, handle: int = None) -> str:
        try:
            if handle:
                # Connect by exact HWND — unique, no same-title ambiguity.
                hwnd = int(handle)
                self._app = self._Application(backend="uia").connect(handle=hwnd)
                self._win = self._app.window(handle=hwnd)
            elif pid:
                self._app = self._Application(backend="uia").connect(process=pid)
                self._win = self._app.top_window()
            elif title:
                self._app = self._Application(backend="uia").connect(
                    title_re=f".*{re.escape(title)}.*", timeout=5
                )
                self._win = self._app.top_window()
            elif path:
                self._app = self._Application(backend="uia").start(path)
                time.sleep(2)
                self._win = self._app.top_window()
            else:
                raise ValueError("Provide title, pid, path, or handle")

            win_title = self._win.window_text()
            return f'Connected to: "{win_title}"'

        except Exception as e:
            # Leave state clean so a failed connect never looks "connected".
            self._app = None
            self._win = None
            raise RuntimeError(
                f"connect failed: {e}\n"
                f"Use d.windows() to see available windows."
            )

    def is_connected(self) -> bool:
        return self._win is not None

    def focus(self) -> str:
        self._ensure_connected()
        try:
            self._win.set_focus()
            return "Window focused"
        except Exception as e:
            return f"Focus failed: {e}"

    def _ensure_connected(self):
        if not self._win:
            raise RuntimeError("Not connected. Use d.connect('window title') first.")



    # ── Role categories for element hinting ──
    _INPUT_TYPES = {"Edit", "Document"}
    _CLICKABLE_TYPES = {"Button", "Hyperlink", "MenuItem", "TabItem", "ListItem", "TreeItem", "DataItem"}
    _TOGGLEABLE_TYPES = {"CheckBox", "RadioButton"}
    _SELECTION_TYPES = {"ComboBox", "Slider", "Spinner"}

    def elements(self, depth: int = 3) -> str:
        self._ensure_connected()
        items = []
        self._collect_elements(self._win.wrapper_object(), items, depth=depth, current_depth=0)

        if not items:
            return "No interactive elements found"

        groups = {
            "INPUT FIELDS (writable — use write_text)": [],
            "CLICKABLE (use click)": [],
            "TOGGLEABLE (use toggle_check)": [],
            "SELECTION (use select)": [],
            "OTHER": [],
        }
        idx = 0
        for el in items:
            t = el["type"]
            entry = (
                f'  [{idx}] <{t}> "{el["name"]}" '
                f'(auto_id="{el["auto_id"]}", enabled={el["enabled"]})'
            )
            idx += 1
            if t in self._INPUT_TYPES:
                groups["INPUT FIELDS (writable — use write_text)"].append(entry)
            elif t in self._CLICKABLE_TYPES:
                groups["CLICKABLE (use click)"].append(entry)
            elif t in self._TOGGLEABLE_TYPES:
                groups["TOGGLEABLE (use toggle_check)"].append(entry)
            elif t in self._SELECTION_TYPES:
                groups["SELECTION (use select)"].append(entry)
            else:
                groups["OTHER"].append(entry)

        lines = [f"Found {len(items)} elements:"]
        for group_name, entries in groups.items():
            if entries:
                lines.append(f"\n── {group_name} ({len(entries)}) ──")
                lines.extend(entries)
        return "\n".join(lines)

    def _collect_elements(self, wrapper, result, depth, current_depth):
        if current_depth > depth:
            return

        interactive_types = {
            "Button", "Edit", "ComboBox", "CheckBox", "RadioButton",
            "ListItem", "MenuItem", "TabItem", "Hyperlink", "Slider",
            "Spinner", "TreeItem", "DataItem", "Text", "Document",
        }

        try:
            children = wrapper.children()
        except Exception:
            return

        for child in children:
            try:
                ctrl_type = child.element_info.control_type or ""
                name = child.element_info.name or ""
                auto_id = child.element_info.automation_id or ""
                enabled = child.is_enabled()

                if ctrl_type in interactive_types and (name or auto_id):
                    result.append({
                        "type": ctrl_type,
                        "name": name,
                        "auto_id": auto_id,
                        "enabled": enabled,
                        "_wrapper": child,
                    })
            except Exception:
                pass

            self._collect_elements(child, result, depth, current_depth + 1)

    def _find(self, query: str, control_type: str = None, timeout: float = 5.0):
        self._ensure_connected()

        # Strategy 1: Exact title match
        try:
            kwargs = {"title": query, "enabled_only": True}
            if control_type:
                kwargs["control_type"] = control_type
            el = self._win.child_window(**kwargs)
            el.wait("exists visible", timeout=timeout)
            return el
        except Exception:
            pass

        # Strategy 2: automation_id match
        try:
            kwargs = {"auto_id": query, "enabled_only": True}
            if control_type:
                kwargs["control_type"] = control_type
            el = self._win.child_window(**kwargs)
            el.wait("exists visible", timeout=timeout)
            return el
        except Exception:
            pass

        # Strategy 3: Partial title match (regex)
        try:
            kwargs = {"title_re": f".*{re.escape(query)}.*", "enabled_only": True}
            if control_type:
                kwargs["control_type"] = control_type
            el = self._win.child_window(**kwargs)
            el.wait("exists visible", timeout=timeout)
            return el
        except Exception:
            pass

        # Strategy 4: Best match from all descendants
        try:
            query_lower = query.lower()
            descendants = self._win.descendants()
            for desc in descendants:
                try:
                    name = (desc.element_info.name or "").lower()
                    aid = (desc.element_info.automation_id or "").lower()
                    if query_lower in name or query_lower in aid:
                        if control_type is None or desc.element_info.control_type == control_type:
                            return desc
                except Exception:
                    continue
        except Exception:
            pass

        return None



    def click(self, name: str, timeout: float = 5.0) -> str:
        el = self._find(name, timeout=timeout)
        if not el:
            raise RuntimeError(
                f"click('{name}') failed: element not found.\n"
                f"Use d.elements() to see available elements."
            )

        try:
            iface = el.iface_invoke
            if iface:
                iface.Invoke()
                time.sleep(0.2)
                return f"Invoked '{name}' (Invoke pattern, no mouse)"
        except Exception:
            pass

        try:
            iface = el.iface_toggle
            if iface:
                iface.Toggle()
                time.sleep(0.2)
                return f"Toggled '{name}' (Toggle pattern, no mouse)"
        except Exception:
            pass

        try:
            iface = el.iface_select
            if iface:
                iface.Select()
                time.sleep(0.2)
                return f"Selected '{name}' (Selection pattern, no mouse)"
        except Exception:
            pass

        try:
            el.click_input()
            time.sleep(0.2)
            return f"Clicked '{name}' (click_input)"
        except Exception as e:
            raise RuntimeError(f"click('{name}') all strategies failed: {e}")

    def write_text(self, name: str, value: str, timeout: float = 5.0) -> str:
        el = self._find(name, control_type="Edit", timeout=timeout)
        if not el:
            el = self._find(name, timeout=timeout)
        if not el:
            raise RuntimeError(
                f"fill('{name}') failed: text field not found.\n"
                f"Use d.elements() to see available elements."
            )

        method = None
        try:
            iface = el.iface_value
            if iface:
                iface.SetValue(value)
                time.sleep(0.1)
                method = "Value pattern"
        except Exception:
            pass

        if not method:
            try:
                el.set_edit_text(value)
                time.sleep(0.1)
                method = "set_edit_text"
            except Exception:
                pass

        if not method:
            # Clipboard paste fallback for fast/lossless pasting of special keys.
            try:
                if _set_clipboard(value):
                    el.set_focus()
                    time.sleep(0.05)
                    el.type_keys("^a{DELETE}", with_spaces=True)
                    el.type_keys("^v", with_spaces=True)
                    time.sleep(0.1)
                    method = "clipboard_paste"
            except Exception:
                pass

        if not method:
            try:
                el.set_focus()
                el.type_keys("^a{DELETE}", with_spaces=True)
                # Escape special characters so literal text is typed verbatim.
                el.type_keys(_escape_type_keys(value), with_spaces=True)
                method = "type_keys"
            except Exception as e:
                raise RuntimeError(f"fill('{name}') all strategies failed: {e}")


        readback = None
        verified = False
        try:
            texts = el.texts()
            if texts:
                readback = texts[0] if len(texts) == 1 else "".join(texts)
        except Exception:
            pass
        if readback is None:
            try:
                iface = el.iface_value
                if iface:
                    readback = iface.CurrentValue
            except Exception:
                pass

        chars_sent = len(value)
        if readback is not None:
            chars_verified = len(readback)
            verified = readback.strip() == value.strip()
            match_str = "MATCH" if verified else f"MISMATCH (got: '{readback[:50]}')"
            return (
                f"Filled '{name}' | method={method} | "
                f"chars_sent={chars_sent}, chars_verified={chars_verified}, {match_str}"
            )
        else:
            return (
                f"Filled '{name}' | method={method} | "
                f"chars_sent={chars_sent}, readback=unavailable (verify manually)"
            )

    def read_text(self, name: str = None, timeout: float = 5.0) -> str:
        self._ensure_connected()

        if name is None:
            all_text = []

            # Strategy 1: Try descendants' texts (deep read)
            try:
                descendants = self._win.descendants()
                for child in descendants:
                    try:
                        t = child.window_text()
                        if t and t.strip() and len(t.strip()) > 1:
                            all_text.append(t.strip())
                    except Exception:
                        continue
            except Exception:
                pass

            # Strategy 2: Try known editor control types directly
            if not all_text or all(len(t) < 50 for t in all_text):
                for ctrl_type in ["Edit", "Document", "RichEdit20W", "RichEditD2DPT"]:
                    try:
                        edit = self._win.child_window(control_type=ctrl_type)
                        if edit.exists(timeout=1):
                            val = edit.window_text()
                            if val and val.strip():
                                # Editor content found — return it with window title
                                title = self._win.window_text()
                                return f"Window: {title}\nContent:\n{val}"
                    except Exception:
                        continue

            if all_text:
                return "\n".join(dict.fromkeys(all_text))  # deduplicate, preserve order

            # Strategy 3: Fallback to basic window text
            return self._win.window_text()

        el = self._find(name, timeout=timeout)

        # Special case: if name is a control type name (like 'Edit'),
        # _find may match a menu/label instead of the actual control.
        # Try control_type search as fallback for known editor types.
        _EDITOR_TYPES = {"Edit", "Document", "RichEdit20W", "RichEditD2DPT"}
        if name in _EDITOR_TYPES:
            try:
                ctrl = self._win.child_window(control_type=name)
                if ctrl.exists(timeout=2):
                    val = ctrl.window_text()
                    if val and val.strip() and val.strip() != name:
                        return val
            except Exception:
                pass

        if not el:
            raise RuntimeError(f"text('{name}') failed: element not found")

        # Try IAccessible value (for value-bearing controls)
        try:
            iface = el.iface_value
            if iface:
                val = iface.CurrentValue
                if val and val.strip():
                    return val
        except Exception:
            pass

        # Try legacy text pattern
        try:
            from pywinauto.uia_defines import IUIA
            import comtypes
            text_pattern = el.iface_text
            if text_pattern:
                val = text_pattern.DocumentRange.GetText(-1)
                if val and val.strip():
                    return val
        except Exception:
            pass

        try:
            return el.window_text()
        except Exception:
            return el.element_info.name or ""

    def select(self, name: str, option: str, timeout: float = 5.0) -> str:
        el = self._find(name, control_type="ComboBox", timeout=timeout)
        if not el:
            el = self._find(name, timeout=timeout)
        if not el:
            raise RuntimeError(f"select('{name}') failed: dropdown not found")

        try:
            el.select(option)
            time.sleep(0.2)
            return f"Selected '{option}' in '{name}'"
        except Exception:
            pass

        try:
            try:
                el.expand()
                time.sleep(0.3)
            except Exception:
                pass
            item = el.child_window(title=option)
            item.click_input()
            time.sleep(0.2)
            return f"Selected '{option}' in '{name}'"
        except Exception as e:
            raise RuntimeError(f"select('{name}', '{option}') failed: {e}")

    def toggle_check(self, name: str, state: bool = True, timeout: float = 5.0) -> str:
        el = self._find(name, control_type="CheckBox", timeout=timeout)
        if not el:
            el = self._find(name, timeout=timeout)
        if not el:
            raise RuntimeError(f"check('{name}') failed: checkbox not found")

        try:
            current = el.get_toggle_state()
            desired = 1 if state else 0
            if current != desired:
                el.toggle()
                time.sleep(0.1)
            action = "Checked" if state else "Unchecked"
            return f"{action} '{name}' (Toggle pattern, no mouse)"
        except Exception as e:
            raise RuntimeError(f"check('{name}') failed: {e}")

    def click_menu(self, path: str) -> str:
        """Click a menu item by path (e.g. 'File -> Save As')."""
        self._ensure_connected()
        # Normalize arrow separators for pywinauto
        path = path.replace(" -> ", "->").replace("-> ", "->").replace(" ->", "->")
        try:
            self._win.menu_select(path)
            time.sleep(0.3)
            return f"Menu: {path}"
        except Exception as e:
            raise RuntimeError(f"menu('{path}') failed: {e}")

    def type_keys(self, keystrokes: str) -> str:
        self._ensure_connected()
        try:
            self._win.type_keys(keystrokes, with_spaces=True)
            time.sleep(0.1)
            return f"Sent keys: {keystrokes}"
        except Exception as e:
            raise RuntimeError(f"keys('{keystrokes}') failed: {e}")



    def ui_tree(self, depth: int = 4) -> str:
        self._ensure_connected()
        lines = []
        self._print_tree(self._win.wrapper_object(), lines, depth=depth, indent=0)
        return "\n".join(lines[:200])

    def _print_tree(self, wrapper, lines, depth, indent):
        if indent > depth:
            return
        try:
            info = wrapper.element_info
            name = info.name or ""
            ctrl = info.control_type or ""
            aid = info.automation_id or ""
            prefix = "  " * indent
            display = f'{prefix}<{ctrl}> "{name[:40]}"'
            if aid:
                display += f" [id={aid}]"
            lines.append(display)
        except Exception:
            return

        try:
            for child in wrapper.children():
                self._print_tree(child, lines, depth, indent + 1)
        except Exception:
            pass

    def screenshot(self, path: str = "desktop_screenshot.png") -> str:
        """Screenshot the connected window, falling back to full-screen if not connected."""
        if not self._win:
            from ..utils import screenshot as _full_screenshot
            return _full_screenshot(path)
        try:
            img = self._win.capture_as_image()
            img.save(path)
            result = f"Window screenshot saved: {path}"
            try:
                from proxima_agent.tools.attach import note_screenshot
                result += note_screenshot(path)
            except Exception:
                pass
            return result
        except Exception as e:
            return f"Screenshot failed: {e}"



    def close(self) -> str:
        self._ensure_connected()
        try:
            self._win.close()
            self._win = None
            self._app = None
            return "Window closed"
        except Exception as e:
            return f"Close failed: {e}"

    def __repr__(self):
        win = self._win.window_text() if self._win else "not connected"
        return f'Desktop(backend="windows", window="{win}")'

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
