"""Proxima — macOS Desktop Automation Backend.
Desktop automation via AppleScript (osascript) and Accessibility API.
"""

import time
import subprocess


def _as_str(s) -> str:
    """Escapes a value for Safe interpolation inside AppleScript double-quotes to prevent code injection.
    Order matters: backslash must be escaped first.
    """
    if s is None:
        return ""
    text = str(s)
    text = text.replace("\\", "\\\\")   # backslash FIRST
    text = text.replace('"', '\\"')      # then double-quote
    text = text.replace("\r", "\\r")     # neutralize carriage return
    text = text.replace("\n", "\\n")     # neutralize newline
    return text


class MacDesktop:

    def __init__(self):
        self._app_name = None  # connected app name

    def _run_applescript(self, script: str, timeout: float = 10) -> str:
        """Runs a static AppleScript without caller-supplied parameters."""
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=timeout
            )
            if result.returncode != 0 and result.stderr.strip():
                raise RuntimeError(result.stderr.strip())
            return result.stdout.strip()
        except subprocess.TimeoutExpired:
            raise RuntimeError("AppleScript timed out")
        except FileNotFoundError:
            raise RuntimeError("osascript not found — are you on macOS?")

    def _run_applescript_args(self, script: str, *args, timeout: float = 10) -> str:
        """Runs an AppleScript passing dynamic arguments safely via argv to prevent injection."""
        cmd = ["osascript", "-e", script, "--"]
        cmd.extend(str(a) for a in args)
        try:
            result = subprocess.run(
                cmd,
                capture_output=True, text=True, timeout=timeout
            )
            if result.returncode != 0 and result.stderr.strip():
                raise RuntimeError(result.stderr.strip())
            return result.stdout.strip()
        except subprocess.TimeoutExpired:
            raise RuntimeError("AppleScript timed out")
        except FileNotFoundError:
            raise RuntimeError("osascript not found — are you on macOS?")



    def windows(self) -> str:
        script = '''
            set output to ""
            tell application "System Events"
                set appList to every application process whose visible is true
                repeat with a in appList
                    set appName to name of a
                    try
                        set winList to every window of a
                        repeat with w in winList
                            set winTitle to name of w
                            set output to output & appName & " — " & winTitle & linefeed
                        end repeat
                    end try
                end repeat
            end tell
            return output
        '''
        result = self._run_applescript(script)
        lines = [line for line in result.split("\n") if line.strip()]
        formatted = [f"  [{i}] {line}" for i, line in enumerate(lines)]
        return f"Found {len(formatted)} windows:\n" + "\n".join(formatted)

    def connect(self, title: str = None, pid: int = None,
                path: str = None, handle: int = None) -> str:
        if path:
            subprocess.run(["open", path], timeout=10)
            time.sleep(2)
            # Extract app name from path
            import os
            self._app_name = os.path.basename(path).replace(".app", "")
        elif title:
            self._app_name = title
        elif pid:
            # Get app name from PID. The pid travels via argv (as item 1 of argv)
            # and is coerced to an integer inside AppleScript, so nothing from the
            # caller is interpolated into the script body.
            script = '''
                on run argv
                    tell application "System Events"
                        set p to first application process whose unix id is ((item 1 of argv) as integer)
                        return name of p
                    end tell
                end run
            '''
            self._app_name = self._run_applescript_args(script, pid)
        else:
            raise ValueError("Provide title, pid, or path")

        # Verify app exists and bring to front. The app name (untrusted text)
        # is passed as argv item 1, never interpolated into the script.
        try:
            self._run_applescript_args(
                'on run argv\n'
                '    tell application (item 1 of argv) to activate\n'
                'end run',
                self._app_name,
            )
            time.sleep(0.5)
            return f'Connected to: "{self._app_name}"'
        except Exception as e:
            self._app_name = None
            raise RuntimeError(f"connect failed: {e}")

    def focus(self) -> str:
        self._ensure_connected()
        self._run_applescript_args(
            'on run argv\n'
            '    tell application (item 1 of argv) to activate\n'
            'end run',
            self._app_name,
        )
        return "Window focused"

    def _ensure_connected(self):
        if not self._app_name:
            raise RuntimeError("Not connected. Use d.connect('App Name') first.")

    def is_connected(self) -> bool:
        return self._app_name is not None



    def elements(self, depth: int = 3) -> str:
        self._ensure_connected()
        # App name (untrusted) is passed as argv item 1, never interpolated.
        script = '''
            on run argv
                set appName to item 1 of argv
                tell application "System Events"
                    tell process appName
                        set output to ""
                        try
                            set uiList to entire contents of window 1
                            repeat with el in uiList
                                try
                                    set elRole to role of el
                                    set elTitle to ""
                                    try
                                        set elTitle to title of el
                                    end try
                                    if elTitle is not "" then
                                        set output to output & elRole & ": " & elTitle & linefeed
                                    end if
                                end try
                            end repeat
                        end try
                        return output
                    end tell
                end tell
            end run
        '''
        result = self._run_applescript_args(script, self._app_name, timeout=15)
        lines = [line for line in result.split("\n") if line.strip()]

        if not lines:
            return "No interactive elements found (Accessibility access may be needed)"

        input_roles = {"AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"}
        click_roles = {"AXButton", "AXLink", "AXMenuItem", "AXTab"}
        toggle_roles = {"AXCheckBox", "AXRadioButton"}

        groups = {
            "INPUT FIELDS (writable \u2014 use write_text)": [],
            "CLICKABLE (use click)": [],
            "TOGGLEABLE (use toggle_check)": [],
            "OTHER": [],
        }
        for i, line in enumerate(lines):
            role = line.split(":")[0].strip() if ":" in line else ""
            entry = f"  [{i}] {line}"
            if role in input_roles:
                groups["INPUT FIELDS (writable \u2014 use write_text)"].append(entry)
            elif role in click_roles:
                groups["CLICKABLE (use click)"].append(entry)
            elif role in toggle_roles:
                groups["TOGGLEABLE (use toggle_check)"].append(entry)
            else:
                groups["OTHER"].append(entry)

        out = [f"Found {len(lines)} elements:"]
        for group_name, entries in groups.items():
            if entries:
                out.append(f"\n\u2500\u2500 {group_name} ({len(entries)}) \u2500\u2500")
                out.extend(entries)
        return "\n".join(out)



    def click(self, name: str, timeout: float = 5.0) -> str:
        self._ensure_connected()
        # App name (item 1) and element name (item 2) travel via argv so quotes,
        # backslashes or AppleScript metacharacters in them are inert.
        script = '''
            on run argv
                set appName to item 1 of argv
                set elName to item 2 of argv
                tell application "System Events"
                    tell process appName
                        try
                            click button elName of window 1
                            return "clicked button"
                        end try
                        try
                            click menu item elName of menu bar 1
                            return "clicked menu item"
                        end try
                        try
                            -- Search deeper
                            set uiList to entire contents of window 1
                            repeat with el in uiList
                                try
                                    if title of el is elName then
                                        click el
                                        return "clicked element"
                                    end if
                                end try
                            end repeat
                        end try
                        return "not found"
                    end tell
                end tell
            end run
        '''
        result = self._run_applescript_args(
            script, self._app_name, name, timeout=timeout + 5
        )
        if "not found" in result:
            raise RuntimeError(
                f"click('{name}') failed: element not found.\n"
                f"Use d.elements() to see available elements."
            )
        return f"Clicked '{name}'"

    def write_text(self, name: str, value: str, timeout: float = 5.0) -> str:
        self._ensure_connected()
        # App name (item 1), field name (item 2) and the value to type (item 3)
        # all travel via argv, so none of them can break out of the script.
        script = '''
            on run argv
                set appName to item 1 of argv
                set elName to item 2 of argv
                set elValue to item 3 of argv
                tell application "System Events"
                    tell process appName
                        try
                            set value of text field elName of window 1 to elValue
                            delay 0.1
                            set readback to value of text field elName of window 1
                            return "filled|" & (count of elValue) & "|" & (count of readback) & "|" & readback
                        end try
                        try
                            -- Search deeper
                            set uiList to entire contents of window 1
                            repeat with el in uiList
                                try
                                    if title of el is elName or description of el is elName then
                                        set focused of el to true
                                        set value of el to elValue
                                        return "filled|" & (count of elValue) & "|-1|"
                                    end if
                                end try
                            end repeat
                        end try
                        return "not found"
                    end tell
                end tell
            end run
        '''
        result = self._run_applescript_args(
            script, self._app_name, name, value, timeout=timeout + 5
        )
        if "not found" in result:
            raise RuntimeError(f"fill('{name}') failed: text field not found")

        parts = result.split("|")
        chars_sent = len(value)
        if len(parts) >= 4:
            try:
                chars_verified = int(parts[2])
            except ValueError:
                chars_verified = -1
            readback = parts[3] if len(parts) > 3 else ""
            if chars_verified >= 0:
                match = readback.strip() == value.strip()
                match_str = "MATCH" if match else f"MISMATCH (got: '{readback[:50]}')"
                return (
                    f"Filled '{name}' | chars_sent={chars_sent}, "
                    f"chars_verified={chars_verified}, {match_str}"
                )
        return (
            f"Filled '{name}' | chars_sent={chars_sent}, "
            f"readback=unavailable (verify manually)"
        )

    def read_text(self, name: str = None, timeout: float = 5.0) -> str:
        self._ensure_connected()
        if name is None:
            # Only the app name is dynamic — passed as argv item 1.
            script = '''
                on run argv
                    set appName to item 1 of argv
                    tell application "System Events"
                        tell process appName
                            try
                                return value of text area 1 of scroll area 1 of window 1
                            end try
                            try
                                return title of window 1
                            end try
                            return ""
                        end tell
                    end tell
                end run
            '''
            return self._run_applescript_args(
                script, self._app_name, timeout=timeout + 5
            )
        else:
            # App name (item 1) and element name (item 2) travel via argv.
            script = '''
                on run argv
                    set appName to item 1 of argv
                    set elName to item 2 of argv
                    tell application "System Events"
                        tell process appName
                            try
                                return value of text field elName of window 1
                            end try
                            try
                                return title of static text elName of window 1
                            end try
                            return ""
                        end tell
                    end tell
                end run
            '''
            return self._run_applescript_args(
                script, self._app_name, name, timeout=timeout + 5
            )

    def select(self, name: str, option: str, timeout: float = 5.0) -> str:
        self._ensure_connected()
        # App name (item 1), popup name (item 2) and option text (item 3) all
        # travel via argv so they cannot break out of the script.
        script = '''
            on run argv
                set appName to item 1 of argv
                set elName to item 2 of argv
                set optName to item 3 of argv
                tell application "System Events"
                    tell process appName
                        try
                            click pop up button elName of window 1
                            delay 0.3
                            click menu item optName of menu 1 of pop up button elName of window 1
                            return "selected"
                        end try
                        return "not found"
                    end tell
                end tell
            end run
        '''
        result = self._run_applescript_args(
            script, self._app_name, name, option, timeout=timeout + 5
        )
        if "not found" in result:
            raise RuntimeError(f"select('{name}', '{option}') failed")
        return f"Selected '{option}' in '{name}'"

    def toggle_check(self, name: str, state: bool = True, timeout: float = 5.0) -> str:
        self._ensure_connected()
        target = 1 if state else 0
        # App name (item 1) and checkbox name (item 2) travel via argv. The
        # target state (item 3) is a controlled int but is still passed via argv
        # and coerced to an integer inside AppleScript for consistency.
        script = '''
            on run argv
                set appName to item 1 of argv
                set elName to item 2 of argv
                set targetState to ((item 3 of argv) as integer)
                tell application "System Events"
                    tell process appName
                        try
                            set cb to checkbox elName of window 1
                            if value of cb is not targetState then
                                click cb
                            end if
                            return "done"
                        end try
                        return "not found"
                    end tell
                end tell
            end run
        '''
        result = self._run_applescript_args(
            script, self._app_name, name, target, timeout=timeout + 5
        )
        if "not found" in result:
            raise RuntimeError(f"check('{name}') failed: checkbox not found")
        action = "Checked" if state else "Unchecked"
        return f"{action} '{name}'"

    def click_menu(self, path: str) -> str:
        self._ensure_connected()
        parts = [p.strip() for p in path.replace("->", "->").split("->")]

        if len(parts) < 2:
            raise RuntimeError("Menu path needs at least 'Menu -> Item' format")

        # Build AppleScript for menu navigation
        menu_name = parts[0]
        item_chain = parts[1:]

        # All dynamic pieces (app name, menu name, every item in the chain) ride
        # in argv. The script body is fully static and loops over argv items 4..N
        # for any nested submenu levels.
        #   item 1 = app name
        #   item 2 = top-level menu name
        #   item 3 = first menu item
        #   item 4..N = subsequent nested submenu items
        script = (
            'on run argv\n'
            '    set appName to item 1 of argv\n'
            '    set menuName to item 2 of argv\n'
            '    set firstItem to item 3 of argv\n'
            '    tell application "System Events"\n'
            '        tell process appName\n'
            '            click menu item firstItem of menu menuName of menu bar 1\n'
            '            repeat with i from 4 to (count of argv)\n'
            '                click menu item (item i of argv) of menu 1\n'
            '            end repeat\n'
            '        end tell\n'
            '    end tell\n'
            'end run'
        )

        self._run_applescript_args(
            script, self._app_name, menu_name, *item_chain
        )
        time.sleep(0.3)
        return f"Menu: {path}"

    def type_keys(self, keystrokes: str) -> str:
        self._ensure_connected()

        # Map common key names to AppleScript key codes
        key_map = {
            "{ENTER}": ("return", []),
            "{RETURN}": ("return", []),
            "{TAB}": ("tab", []),
            "{DELETE}": (51, []),  # key code
            "{ESCAPE}": ("escape", []),
            "{SPACE}": ("space", []),
            "^c": ("c", ["command down"]),
            "^v": ("v", ["command down"]),
            "^a": ("a", ["command down"]),
            "^s": ("s", ["command down"]),
            "^z": ("z", ["command down"]),
        }

        if keystrokes in key_map:
            key, modifiers = key_map[keystrokes]
            mod_str = " using {" + ", ".join(modifiers) + "}" if modifiers else ""
            if isinstance(key, int):
                script = f'''
                    tell application "System Events"
                        key code {key}{mod_str}
                    end tell
                '''
            else:
                script = f'''
                    tell application "System Events"
                        keystroke "{key}"{mod_str}
                    end tell
                '''
        else:
            # Plain text input — the keystrokes are agent/page-controlled, so they
            # travel via argv (item 1) instead of being interpolated.
            script = '''
                on run argv
                    tell application "System Events"
                        keystroke (item 1 of argv)
                    end tell
                end run
            '''
            self._run_applescript_args(script, keystrokes)
            time.sleep(0.1)
            return f"Sent keys: {keystrokes}"

        self._run_applescript(script)
        time.sleep(0.1)
        return f"Sent keys: {keystrokes}"



    def ui_tree(self, depth: int = 4) -> str:
        self._ensure_connected()
        # App name (untrusted) passed as argv item 1.
        script = '''
            on run argv
                set appName to item 1 of argv
                tell application "System Events"
                    tell process appName
                        set output to ""
                        try
                            set uiList to entire contents of window 1
                            repeat with el in uiList
                                try
                                    set elRole to role of el
                                    set elTitle to ""
                                    set elValue to ""
                                    try
                                        set elTitle to title of el
                                    end try
                                    try
                                        set elValue to value of el
                                    end try
                                    set output to output & elRole & " | " & elTitle & " | " & elValue & linefeed
                                end try
                            end repeat
                        end try
                        return output
                    end tell
                end tell
            end run
        '''
        result = self._run_applescript_args(script, self._app_name, timeout=15)
        lines = result.split("\n")[:200]
        formatted = [f"  {line}" for line in lines if line.strip()]
        return "\n".join(formatted) if formatted else "No UI tree available"

    def screenshot(self, path: str = "desktop_screenshot.png") -> str:
        """Screenshot the connected app window, falling back to full-screen if not connected."""
        if not self._app_name:
            from ..utils import screenshot as _full_screenshot
            return _full_screenshot(path)
        try:
            # App name (untrusted) passed as argv item 1; the resolved window id
            # is then handed to screencapture as a normal argument.
            window_id = self._run_applescript_args(
                'on run argv\n'
                '    tell application "System Events" to tell process (item 1 of argv) '
                'to return id of window 1\n'
                'end run',
                self._app_name,
            )
            subprocess.run(
                ["screencapture", "-l", window_id, path],
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
            # Fallback: screenshot entire screen
            try:
                subprocess.run(["screencapture", path], timeout=10)
                result = f"Full screenshot saved: {path}"
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
            # App name (untrusted) passed as argv item 1.
            self._run_applescript_args(
                'on run argv\n'
                '    tell application (item 1 of argv) to close window 1\n'
                'end run',
                self._app_name,
            )
            self._app_name = None
            return "Window closed"
        except Exception as e:
            return f"Close failed: {e}"

    def __repr__(self):
        app = self._app_name or "not connected"
        return f'Desktop(backend="mac", app="{app}")'

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
