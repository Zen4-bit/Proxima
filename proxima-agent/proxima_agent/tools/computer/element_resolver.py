"""Proxima — Element Resolver.
Unified fallback chain for finding UI elements across contexts.
"""

import time
import platform
from dataclasses import dataclass

_OS = platform.system()


@dataclass
class ElementRef:
    found: bool = False
    strategy: str = ""          # which strategy found it: direct/parent/coord/ocr
    context: str = ""           # "browser" or "desktop"
    handle: object = None       # backend-specific element reference
    x: int = 0                  # screen x (for click fallback)
    y: int = 0                  # screen y (for click fallback)
    query: str = ""             # original text query (for robust re-resolution)
    description: str = ""       # human-readable what was found
    error: str = ""             # error message if not found


class ElementResolver:

    def __init__(self):
        # Cache ONE ChromeBrowser instance, reused across find/click/fill. A
        # fresh instance per call opened a new CDP WebSocket every time.
        self._browser = None
        # Cache ONE Desktop instance connected to the active window. Keyed by
        # the active window handle so it transparently reconnects when the
        # foreground window changes (and drops a connection whose window closed).
        self._desktop = None
        self._desktop_win_handle = None

    def find_element(self, query: str, context: str = "auto",
             kind: str = "any", timeout: float = 5.0,
             coords: tuple = None) -> ElementRef:
        tried = []

        # Determine which contexts to try
        if context == "auto":
            contexts = self._detect_contexts()
        else:
            contexts = [context]

        # ── Strategy 1: Direct reference ──
        for ctx in contexts:
            ref = self._try_direct(query, ctx, kind, timeout)
            if ref.found:
                return ref
            tried.append(f"direct({ctx}): {ref.error}")

        # ── Strategy 2: Parent/ancestor search ──
        for ctx in contexts:
            ref = self._try_parent_search(query, ctx, kind, timeout)
            if ref.found:
                return ref
            tried.append(f"parent({ctx}): {ref.error}")

        # ── Strategy 3: Coordinate-based ──
        if coords:
            for ctx in contexts:
                ref = self._try_coordinates(coords[0], coords[1], ctx)
                if ref.found:
                    return ref
                tried.append(f"coords({ctx}): {ref.error}")

        # ── Strategy 4: OCR text search ──
        ref = self._try_ocr(query)
        if ref.found:
            return ref
        tried.append(f"ocr: {ref.error}")

        # All strategies failed
        return ElementRef(
            found=False,
            error=f"Element '{query}' not found. Tried: " + " → ".join(tried),
        )

    def click(self, ref: ElementRef) -> str:
        if not ref.found:
            return f"Error: Cannot click — {ref.error}"

        if ref.context == "browser":
            return self._browser_click(ref)
        elif ref.context == "desktop":
            return self._desktop_click(ref)
        elif ref.context == "ocr":
            return self._ocr_click(ref)
        return f"Error: Unknown context '{ref.context}'"

    def write_text(self, ref: ElementRef, value: str) -> str:
        if not ref.found:
            return f"Error: Cannot fill — {ref.error}"

        if ref.context == "browser":
            return self._browser_fill(ref, value)
        elif ref.context == "desktop":
            return self._desktop_fill(ref, value)
        return f"Error: fill not supported for context '{ref.context}'"



    def _detect_contexts(self) -> list[str]:
        contexts = []
        # Check if Chrome CDP is reachable
        try:
            import urllib.request
            from ..config import CDP_URL
            urllib.request.urlopen(f"{CDP_URL}/json", timeout=1)
            contexts.append("browser")
        except Exception:
            pass
        # Desktop is always available
        contexts.append("desktop")
        return contexts if contexts else ["desktop"]

    def _try_direct(self, query: str, context: str,
                    kind: str, timeout: float) -> ElementRef:
        if context == "browser":
            return self._browser_find_direct(query, kind, timeout)
        elif context == "desktop":
            return self._desktop_find_direct(query, kind, timeout)
        return ElementRef(error="unknown context")

    def _try_parent_search(self, query: str, context: str,
                           kind: str, timeout: float) -> ElementRef:
        if context == "browser":
            return self._browser_find_parent(query, kind, timeout)
        elif context == "desktop":
            return self._desktop_find_parent(query, kind, timeout)
        return ElementRef(error="unknown context")

    def _try_coordinates(self, x: int, y: int, context: str) -> ElementRef:
        if context == "browser":
            return self._browser_element_at(x, y)
        elif context == "desktop":
            return self._desktop_element_at(x, y)
        return ElementRef(error="unknown context")

    def _try_ocr(self, query: str) -> ElementRef:
        try:
            from ..ocr import find_text_on_screen
            matches = find_text_on_screen(query, threshold=0.6)
            if matches:
                m = matches[0]
                return ElementRef(
                    found=True,
                    strategy="ocr",
                    context="ocr",
                    handle=m,
                    x=m["center_x"],
                    y=m["center_y"],
                    description=f"OCR: '{m['text']}' at ({m['center_x']},{m['center_y']})",
                )
            return ElementRef(error="text not found on screen")
        except Exception as e:
            return ElementRef(error=f"OCR unavailable: {e}")



    def _get_browser(self):
        if self._browser is None:
            try:
                from ..browser_cdp import ChromeBrowser
                self._browser = ChromeBrowser()
            except Exception:
                self._browser = None
        return self._browser

    def _browser_find_direct(self, query: str, kind: str,
                             timeout: float) -> ElementRef:
        b = self._get_browser()
        if not b:
            return ElementRef(error="browser not connected")
        try:
            el = b._find_element(query, kind=kind, timeout=timeout)
            if el:
                return ElementRef(
                    found=True,
                    strategy="direct",
                    context="browser",
                    handle=el,
                    x=int(el.get("x", 0)),
                    y=int(el.get("y", 0)),
                    query=query,
                    description=f"CDP: '{el.get('found', query)}' mode={el.get('mode')}",
                )
            return ElementRef(error="not found via CDP")
        except Exception as e:
            return ElementRef(error=f"CDP error: {e}")

    def _browser_find_parent(self, query: str, kind: str,
                             timeout: float) -> ElementRef:
        b = self._get_browser()
        if not b:
            return ElementRef(error="browser not connected")
        try:
            # Use JavaScript to find label text and search parent tree.
            # Pre-escape the query OUTSIDE the f-string expression — backslashes
            # inside f-string expression braces are a SyntaxError on Python < 3.12.
            q_escaped = query.replace('"', '\\"')
            js = f'''
            (function() {{
                var q = "{q_escaped}";
                var qLow = q.toLowerCase();
                var allEls = document.querySelectorAll('*');
                for (var el of allEls) {{
                    var t = (el.textContent || '').trim();
                    if (t.toLowerCase().includes(qLow) && t.length < 100 && el.children.length < 5) {{
                        // Found label — search parent tree for input
                        var p = el.parentElement;
                        for (var up = 0; up < 6 && p; up++) {{
                            var input = p.querySelector(
                                'input, textarea, select, [contenteditable="true"], '
                                + '[role="textbox"], [role="combobox"], button, a'
                            );
                            if (input && input !== el) {{
                                var r = input.getBoundingClientRect();
                                if (r.width > 0 && r.height > 0) {{
                                    input.scrollIntoView({{block: "center", behavior: "instant"}});
                                    r = input.getBoundingClientRect();
                                    return JSON.stringify({{
                                        x: Math.round(r.left + r.width/2),
                                        y: Math.round(r.top + r.height/2),
                                        tag: input.tagName.toLowerCase(),
                                        mode: input.contentEditable === 'true' ? 'contenteditable' : 'input',
                                        found: 'parent:' + t.substring(0,30)
                                    }});
                                }}
                            }}
                            p = p.parentElement;
                        }}
                    }}
                }}
                return null;
            }})()
            '''
            result = b._js(js)
            if result and result != "null":
                import json
                el = json.loads(result)
                return ElementRef(
                    found=True,
                    strategy="parent",
                    context="browser",
                    handle=el,
                    x=int(el.get("x", 0)),
                    y=int(el.get("y", 0)),
                    query=query,
                    description=f"parent: '{el.get('found', query)}'",
                )
            return ElementRef(error="not found in parent tree")
        except Exception as e:
            return ElementRef(error=f"parent search error: {e}")

    def _browser_element_at(self, x: int, y: int) -> ElementRef:
        b = self._get_browser()
        if not b:
            return ElementRef(error="browser not connected")
        try:
            js = f'''
            (function() {{
                var el = document.elementFromPoint({x}, {y});
                if (!el) return null;
                var r = el.getBoundingClientRect();
                return JSON.stringify({{
                    x: Math.round(r.left + r.width/2),
                    y: Math.round(r.top + r.height/2),
                    tag: el.tagName.toLowerCase(),
                    mode: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? 'input'
                        : el.contentEditable === 'true' ? 'contenteditable' : 'clickable',
                    found: el.placeholder || el.getAttribute('aria-label') || el.name || el.tagName
                }});
            }})()
            '''
            result = b._js(js)
            if result and result != "null":
                import json
                el = json.loads(result)
                return ElementRef(
                    found=True,
                    strategy="coord",
                    context="browser",
                    handle=el,
                    x=int(el.get("x", 0)),
                    y=int(el.get("y", 0)),
                    description=f"coord: '{el.get('found', '?')}' at ({x},{y})",
                )
            return ElementRef(error="no element at coordinates")
        except Exception as e:
            return ElementRef(error=f"coord error: {e}")

    def _browser_click(self, ref: ElementRef) -> str:
        b = self._get_browser()
        if not b:
            return "Error: browser not connected"
        try:
            if ref.query:
                return b.click_text(ref.query)
            b.click(ref.x, ref.y)
            time.sleep(0.2)
            return f"Clicked '{ref.description}' at ({ref.x},{ref.y})"
        except Exception as e:
            return f"Error: click failed — {e}"

    def _browser_fill(self, ref: ElementRef, value: str) -> str:
        b = self._get_browser()
        if not b:
            return "Error: browser not connected"
        try:
            if ref.query:
                return b.write_text(ref.query, value)
            # Fallback for coordinate-derived refs: focus by clicking, then
            # engine-level insert (browser handles React/Vue/vanilla).
            b.click(ref.x, ref.y)
            time.sleep(0.15)
            b._cdp("Input.insertText", {"text": value})
            time.sleep(0.1)
            return f"Filled '{ref.description}' with '{value[:30]}'"
        except Exception as e:
            return f"Error: fill failed — {e}"



    def _get_desktop(self):
        # We cache the connection by the active window handle so we reconnect transparently
        # when the foreground window changes or the previous window is closed/reopened.
        # This also disambiguates windows sharing the same title.
        try:
            from ..desktop import Desktop
        except Exception:
            return None

        try:
            from .window_manager import get_active_window
            active = get_active_window() or {}
        except Exception:
            active = {}

        handle = active.get("handle")
        # Cross-platform target name: macOS exposes the app name under "app"
        # (its connect() matches by app name); Windows/Linux have no "app" key
        # so this falls back to the window title.
        target = active.get("app") or active.get("title") or ""

        # Reuse the cached connection only when it targets the SAME window and is
        # still connected.
        if (self._desktop is not None and handle is not None
                and self._desktop_win_handle == handle):
            try:
                if self._desktop.is_connected():
                    return self._desktop
            except Exception:
                pass  # fall through and rebuild

        try:
            d = Desktop()
        except Exception:
            return None

        # Connect to the exact foreground window. handle is unique (disambiguates
        # same-title windows, no connect timeout); target/title is the macOS
        # fallback. A failure leaves an UNCONNECTED Desktop → OCR fallback.
        connected = False
        try:
            if handle is not None or target:
                d.connect(title=target or None, handle=handle)
                connected = bool(getattr(d, "is_connected", lambda: True)())
        except Exception:
            connected = False

        self._desktop = d
        self._desktop_win_handle = handle if connected else None
        return d

    def _desktop_find_direct(self, query: str, kind: str,
                             timeout: float) -> ElementRef:
        d = self._get_desktop()
        if not d:
            return ElementRef(error="desktop automation unavailable")
        try:
            control_type = "Edit" if kind == "input" else None
            el = d._find(query, control_type=control_type, timeout=timeout)
            if el:
                return ElementRef(
                    found=True,
                    strategy="direct",
                    context="desktop",
                    handle=el,
                    description=f"UIA: '{query}'",
                )
            return ElementRef(error="not found via UIA")
        except Exception as e:
            return ElementRef(error=f"UIA error: {e}")

    def _desktop_find_parent(self, query: str, kind: str,
                             timeout: float) -> ElementRef:
        d = self._get_desktop()
        if not d:
            return ElementRef(error="desktop automation unavailable")
        try:
            # Find any element containing the query text
            import re as _re
            el = d._win.child_window(title_re=f".*{_re.escape(query)}.*")
            try:
                el.wait("exists", timeout=min(timeout, 2.0))
            except Exception:
                return ElementRef(error="label not found for parent search")

            # Walk up to parent and look for Edit/ComboBox nearby
            parent = el.parent()
            if parent:
                for child in parent.children():
                    try:
                        ct = child.element_info.control_type
                        if ct in ("Edit", "ComboBox", "Document"):
                            return ElementRef(
                                found=True,
                                strategy="parent",
                                context="desktop",
                                handle=child,
                                description=f"UIA parent: near '{query}'",
                            )
                    except Exception:
                        continue
            return ElementRef(error="no input found near label")
        except Exception as e:
            return ElementRef(error=f"parent search error: {e}")

    def _desktop_element_at(self, x: int, y: int) -> ElementRef:
        if _OS != "Windows":
            return ElementRef(error="coordinate UIA only on Windows")
        try:
            import comtypes.client
            # Ensure the UIAutomationClient typelib is generated before use.
            comtypes.client.GetModule("UIAutomationCore.dll")
            from comtypes.gen import UIAutomationClient as _UIA
            uia = comtypes.client.CreateObject(
                "{ff48dba4-60ef-4201-aa87-54103eef594e}",
                interface=_UIA.IUIAutomation,
            )
            # ElementFromPoint expects a POINT struct, not a dict.
            from ctypes.wintypes import POINT
            el = uia.ElementFromPoint(POINT(int(x), int(y)))
            if el:
                name = el.CurrentName or "(unnamed)"
                return ElementRef(
                    found=True,
                    strategy="coord",
                    context="desktop",
                    handle=el,
                    x=x, y=y,
                    description=f"UIA coord: '{name}' at ({x},{y})",
                )
            return ElementRef(error="no UIA element at coords")
        except Exception as e:
            return ElementRef(error=f"UIA coord error: {e}")

    def _desktop_click(self, ref: ElementRef) -> str:
        try:
            el = ref.handle
            # Try Invoke pattern first (no mouse needed)
            try:
                iface = el.iface_invoke
                if iface:
                    iface.Invoke()
                    time.sleep(0.2)
                    return f"Invoked '{ref.description}'"
            except Exception:
                pass
            # Fallback to click_input
            el.click_input()
            time.sleep(0.2)
            return f"Clicked '{ref.description}'"
        except Exception as e:
            return f"Error clicking: {e}"

    def _desktop_fill(self, ref: ElementRef, value: str) -> str:
        try:
            el = ref.handle
            # Try ValuePattern first
            try:
                vp = el.iface_value
                if vp:
                    vp.SetValue(value)
                    time.sleep(0.1)
                    return f"Filled '{ref.description}' via ValuePattern"
            except Exception:
                pass
            # Fallback: focus + type_keys
            el.set_focus()
            el.type_keys("^a", pause=0.02)  # Ctrl+A
            el.type_keys(value, pause=0.02, with_spaces=True)
            time.sleep(0.1)
            return f"Typed into '{ref.description}'"
        except Exception as e:
            return f"Error filling: {e}"



    def _ocr_click(self, ref: ElementRef) -> str:
        try:
            from .actions import click_in_window
            from .window_manager import get_active_window
            active = get_active_window()
            if active and active.get("handle"):
                # Convert screen coords to window-relative
                from .window_manager import get_window_rect
                rect = get_window_rect(active["handle"])
                if rect:
                    rel_x = ref.x - rect["x"]
                    rel_y = ref.y - rect["y"]
                    return click_in_window(active["handle"], rel_x, rel_y)
            # Fallback: raw screen click via pyautogui
            import pyautogui
            pyautogui.click(ref.x, ref.y)
            return f"OCR clicked at ({ref.x},{ref.y})"
        except Exception as e:
            return f"Error OCR clicking: {e}"

    # Backward-compatible aliases
    find = find_element
    fill = write_text
