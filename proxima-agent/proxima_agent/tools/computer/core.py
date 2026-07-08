"""Proxima — Computer Unified Interface.
Unified interface for controlling the user's computer on-demand.
"""

import os
import subprocess
import platform

_OS = platform.system()


class Computer:

    def __init__(self):
        self._target_window = None  # Currently targeted window
        self._browser_instance = None  # Lazy-loaded ChromeBrowser
        self._desktop_instance = None  # Lazy-loaded Desktop
        self._resolver_instance = None  # Lazy-loaded ElementResolver



    def windows(self) -> str:
        from .window_manager import enumerate_windows

        wins = enumerate_windows()
        if not wins:
            msg = "No visible windows found"
            # On Linux a Wayland session or missing xdotool/wmctrl yields an
            # empty list silently — surface WHY so the agent can adapt.
            if _OS == "Linux":
                try:
                    from .window_manager import _linux_session_note
                    note = _linux_session_note()
                    if note:
                        msg += f"\n{note}"
                except Exception:
                    pass
            elif _OS == "Darwin":
                msg += ("\n(macOS needs Accessibility permission for window "
                        "enumeration; the browser/desktop tools also work.)")
            return msg

        lines = []
        for i, w in enumerate(wins):
            title = w.get("title", "?")[:60]
            handle = w.get("handle", 0)
            display = w.get("display", 0)
            pos = w.get("position", {})
            size = w.get("size", {})
            lines.append(
                f'  [{i}] "{title}"  '
                f'handle=0x{handle:X}  display={display}  '
                f'pos=({pos.get("x", 0)},{pos.get("y", 0)}) '
                f'size={size.get("width", 0)}x{size.get("height", 0)}'
            )

        return f"Found {len(lines)} windows:\n" + "\n".join(lines)

    def displays(self) -> str:
        from .display_info import enumerate_displays

        disps = enumerate_displays()
        if not disps:
            return "No displays detected"

        lines = []
        for d in disps:
            name = d.get("name", "?")
            primary = " (primary)" if d.get("primary") else ""
            size = d.get("size", {})
            pos = d.get("position", {})
            scale = d.get("scale", 1.0)
            lines.append(
                f'  [{d.get("index", 0)}] {name}{primary}  '
                f'{size.get("width", 0)}x{size.get("height", 0)} '
                f'at ({pos.get("x", 0)},{pos.get("y", 0)}) '
                f'scale={scale}'
            )

        return f"Found {len(disps)} displays:\n" + "\n".join(lines)

    def active_window(self) -> str:
        from .window_manager import get_active_window

        win = get_active_window()
        if not win:
            return "No active window detected"

        title = win.get("title", "?")
        handle = win.get("handle", 0)
        pos = win.get("position", {})
        size = win.get("size", {})

        return (
            f'Active: "{title}"  handle=0x{handle:X}  '
            f'pos=({pos.get("x", 0)},{pos.get("y", 0)}) '
            f'size={size.get("width", 0)}x{size.get("height", 0)}'
        )



    def target(self, query: str) -> str:
        from .window_manager import find_window

        win = find_window(query)
        if not win:
            return (
                f"Window '{query}' not found.\n"
                f"Use computer.windows() to see all open windows."
            )

        self._target_window = win
        title = win.get("title", "?")
        handle = win.get("handle", 0)
        pos = win.get("position", {})
        size = win.get("size", {})
        display = win.get("display", 0)

        return (
            f'Targeted: "{title}"\n'
            f'  Handle: 0x{handle:X}\n'
            f'  Display: {display}\n'
            f'  Position: ({pos.get("x", 0)}, {pos.get("y", 0)})\n'
            f'  Size: {size.get("width", 0)}x{size.get("height", 0)}\n'
            f'  All click/type/screenshot actions now scoped to this window.'
        )

    def target_handle(self, handle: int) -> str:
        from .window_manager import get_window_rect

        rect = get_window_rect(handle)
        if not rect:
            return f"Window with handle 0x{handle:X} not found"

        self._target_window = {
            "handle": handle,
            "title": "?",
            "position": {"x": rect["x"], "y": rect["y"]},
            "size": {"width": rect["width"], "height": rect["height"]},
        }
        return f"Targeted window handle 0x{handle:X} ({rect['width']}x{rect['height']})"

    @property
    def targeted(self) -> dict | None:
        return self._target_window

    def _require_target(self):
        if not self._target_window:
            raise RuntimeError(
                "No window targeted. Use computer.target('window name') first.\n"
                "Use computer.windows() to see available windows."
            )



    def click(self, x: int, y: int, button: str = "left",
              double: bool = False) -> str:
        self._require_target()
        from .actions import click_in_window

        handle = self._target_window["handle"]
        return click_in_window(handle, x, y, button, double)

    def type_text(self, text: str, interval: float = 0.02) -> str:
        self._require_target()
        from .actions import type_in_window

        handle = self._target_window["handle"]
        return type_in_window(handle, text, interval)

    def screenshot(self, path: str = "window_screenshot.png") -> str:
        if not self._target_window:
            return self.screenshot_full(path)
        from .actions import screenshot_window

        handle = self._target_window["handle"]
        return screenshot_window(handle, path)

    def focus(self) -> str:
        self._require_target()
        from .window_manager import focus_window

        handle = self._target_window["handle"]
        success = focus_window(handle)
        title = self._target_window.get("title", "?")
        if success:
            return f'Focused: "{title}"'
        return f'Failed to focus: "{title}"'



    @property
    def browser(self):
        if self._browser_instance is None:
            from proxima_agent.tools.browser_cdp import ChromeBrowser
            self._browser_instance = ChromeBrowser()
        return self._browser_instance

    @property
    def desktop(self):
        if self._desktop_instance is None:
            from proxima_agent.tools.desktop import Desktop
            self._desktop_instance = Desktop()
        return self._desktop_instance

    @property
    def resolver(self):
        if self._resolver_instance is None:
            from .element_resolver import ElementResolver
            self._resolver_instance = ElementResolver()
        return self._resolver_instance

    def find_element(self, query: str, context: str = "auto",
                     kind: str = "any", timeout: float = 5.0,
                     coords: tuple = None) -> 'ElementRef':
        return self.resolver.find(query, context, kind, timeout, coords)

    def smart_click(self, query: str, context: str = "auto",
                    timeout: float = 5.0) -> str:
        ref = self.resolver.find(query, context, kind="clickable", timeout=timeout)
        if not ref.found:
            return f"Error: {ref.error}"
        return self.resolver.click(ref)

    def smart_write(self, query: str, value: str,
                   context: str = "auto", timeout: float = 5.0) -> str:
        ref = self.resolver.find(query, context, kind="input", timeout=timeout)
        if not ref.found:
            return f"Error: {ref.error}"
        return self.resolver.fill(ref, value)



    def verify(self, expected: str | None = None,
               context: str | None = None,
               target_file: str | None = None) -> str:
        from .verify import smart_verify

        result = smart_verify(
            expected=expected,
            context=context,
            target_file=target_file,
            browser_instance=self._browser_instance,
            desktop_instance=self._desktop_instance,
        )
        return str(result)



    def context(self) -> str:
        from .environment import get_environment_context

        return get_environment_context(
            browser_instance=self._browser_instance,
            desktop_instance=self._desktop_instance,
        )



    def run_shell(self, command: str, timeout: int = 30) -> str:
        try:
            # Decode as UTF-8 with replacement (NOT the locale codepage). text=True
            # alone uses locale.getpreferredencoding() (cp1252 on Windows), which
            # raises UnicodeDecodeError on the UTF-8 output of common tooling
            # (git/npm/node/python) — turning a successful command into a fake
            # "Shell error". errors="replace" guarantees no crash on odd bytes.
            # PYTHONIOENCODING nudges child Python processes to emit UTF-8 too.
            # Mirrors the hardening already applied in tools/system/shell_ops.py.
            if _OS == "Windows":
                result = subprocess.run(
                    command, shell=True, capture_output=True,
                    text=True, encoding="utf-8", errors="replace",
                    timeout=timeout,
                    env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                )
            else:
                result = subprocess.run(
                    command, shell=True, capture_output=True,
                    text=True, encoding="utf-8", errors="replace",
                    timeout=timeout, executable="/bin/bash",
                    env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                )

            output = result.stdout or ""
            if result.stderr:
                output += f"\n[stderr] {result.stderr}"
            if result.returncode != 0:
                output += f"\n[exit code: {result.returncode}]"
            return output.strip() or "(no output)"
        except subprocess.TimeoutExpired:
            return f"Command timed out after {timeout}s"
        except Exception as e:
            return f"Shell error: {e}"



    def screenshot_full(self, path: str = "full_screenshot.png") -> str:
        try:
            import pyautogui
            img = pyautogui.screenshot()
            img.save(path)
            result = f"Full screenshot saved: {path} ({img.width}x{img.height})"
            try:
                from proxima_agent.tools.attach import note_screenshot
                result += note_screenshot(path)
            except Exception:
                pass
            return result
        except ImportError:
            return "Error: pyautogui not installed for full screenshot"



    def reset(self):
        self._target_window = None
        if self._browser_instance:
            try:
                self._browser_instance.close()
            except Exception:
                pass
            self._browser_instance = None
        if self._desktop_instance:
            self._desktop_instance = None
        # Drop the resolver too — it caches its own ChromeBrowser, which would
        # otherwise be left pointing at a closed connection after reset.
        self._resolver_instance = None

    def __repr__(self):
        target = self._target_window
        if target:
            return f'Computer(target="{target.get("title", "?")[:40]}")'
        return "Computer(no target)"

    # Backward-compatible aliases
    smart_fill = smart_write
    shell = run_shell
