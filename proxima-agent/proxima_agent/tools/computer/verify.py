"""Proxima — Smart Verification.
Context-aware verification helper.
"""

import platform
import time
import os

_OS = platform.system()


def _cdp_alive() -> bool:
    """Returns True if CDP is reachable. Uses raw ping to avoid starting Chrome as a side effect."""
    try:
        import json as _json
        import urllib.request as _req
        from proxima_agent.config import CDP_URL
        with _req.urlopen(f"{CDP_URL}/json/version", timeout=0.3) as resp:
            _json.loads(resp.read())
        return True
    except Exception:
        return False


class VerifyResult:

    def __init__(self, context: str, success: bool, message: str,
                 details: dict | None = None):
        self.context = context      # 'browser', 'desktop', 'file', 'shell', 'screen'
        self.success = success
        self.message = message
        self.details = details or {}

    def __str__(self):
        icon = "✅" if self.success else "❌"
        header = f"[Smart Verify — {self.context}] {icon} {self.message}"

        detail_lines = []
        for key, value in self.details.items():
            # Truncate long values
            val_str = str(value)
            if len(val_str) > 200:
                val_str = val_str[:200] + "..."
            detail_lines.append(f"  {key}: {val_str}")

        if detail_lines:
            return header + "\n" + "\n".join(detail_lines)
        return header


def smart_verify(expected: str | None = None,
                 context: str | None = None,
                 target_file: str | None = None,
                 browser_instance=None,
                 desktop_instance=None) -> VerifyResult:
    # ── Auto-detect context ──
    if context is None:
        context = _detect_context(browser_instance, desktop_instance, target_file)

    # ── Dispatch to the right verifier ──
    if context == "browser":
        return _verify_browser(browser_instance, expected)
    elif context == "desktop":
        return _verify_desktop(desktop_instance, expected)
    elif context == "file":
        return _verify_file(target_file, expected)
    elif context == "screen":
        return _verify_screen(expected)
    else:
        return _verify_screen(expected)  # Fallback: screenshot + OCR


def _detect_context(browser_instance, desktop_instance, target_file) -> str:
    # Priority order: explicit file > browser > desktop > screen fallback

    if target_file and os.path.exists(target_file):
        return "file"

    if browser_instance is not None:
        try:
            # Check if browser is actually active/connected
            browser_instance.eval_js("1")
            return "browser"
        except Exception:
            pass

    if desktop_instance is not None:
        try:
            if desktop_instance._win is not None:
                return "desktop"
        except Exception:
            pass

    # Fallback: check if any browser CDP is ALREADY running. Use a raw ping —
    # constructing ChromeBrowser here would LAUNCH Chrome, turning a passive
    # context probe into a side effect (spawning a browser the user never asked
    # for). A live CDP endpoint means Proxima's automated Chrome is up already.
    if _cdp_alive():
        return "browser"

    # Check if Desktop has a connected window
    try:
        from proxima_agent.tools.desktop import Desktop
        d = Desktop()
        if d._win is not None:
            return "desktop"
    except Exception:
        pass

    return "screen"  # Fallback


# ─── Browser Verification ──────────────────────────────────────

def _verify_browser(browser_instance, expected: str | None) -> VerifyResult:
    try:
        # Get or create browser instance
        if browser_instance is None:
            # Never LAUNCH Chrome just to verify. If the agent didn't pass a live
            # browser and no CDP endpoint is up, report "not connected" instead of
            # spawning a fresh (blank) browser that would fail every check anyway.
            if not _cdp_alive():
                return VerifyResult(
                    "browser", False,
                    "Browser not connected (no live CDP endpoint to verify against)"
                )
            from proxima_agent.tools.browser_cdp import ChromeBrowser
            browser_instance = ChromeBrowser()

        # ── Gather state (multiple signals, not just one) ──
        url = ""
        title = ""
        page_text = ""
        screenshot_path = ""

        try:
            url = browser_instance.eval_js("location.href") or ""
        except Exception:
            pass

        try:
            title = browser_instance.eval_js("document.title") or ""
        except Exception:
            pass

        try:
            page_text = browser_instance.text() or ""
        except Exception:
            pass

        try:
            screenshot_path = os.path.join(
                os.path.expanduser("~"), ".proxima-agent", "verify_screenshot.png"
            )
            os.makedirs(os.path.dirname(screenshot_path), exist_ok=True)
            browser_instance.screenshot(screenshot_path)
        except Exception:
            screenshot_path = ""

        # ── Build details ──
        details = {
            "url": url,
            "page_title": title,
            "page_text_length": len(page_text),
            "page_text_preview": page_text[:300] if page_text else "(empty)",
        }
        if screenshot_path:
            details["screenshot"] = screenshot_path

        # ── Check expected content ──
        if expected:
            found_in_text = expected.lower() in page_text.lower()
            found_in_title = expected.lower() in title.lower()
            found = found_in_text or found_in_title

            details["expected"] = expected
            details["found_in_page_text"] = found_in_text
            details["found_in_title"] = found_in_title

            if found:
                return VerifyResult(
                    "browser", True,
                    f"Content '{expected[:50]}' found in page",
                    details
                )
            else:
                return VerifyResult(
                    "browser", False,
                    f"Content '{expected[:50]}' NOT found in page",
                    details
                )

        # No expected content — just return current state
        return VerifyResult(
            "browser", True,
            f"Browser state captured — {url}",
            details
        )

    except Exception as e:
        return VerifyResult("browser", False, f"Browser verify failed: {e}")


# ─── Desktop Verification ──────────────────────────────────────

def _verify_desktop(desktop_instance, expected: str | None) -> VerifyResult:
    try:
        # Get or create desktop instance
        if desktop_instance is None:
            from proxima_agent.tools.desktop import Desktop
            desktop_instance = Desktop()

        # Check if connected
        if desktop_instance._win is None:
            return VerifyResult(
                "desktop", False,
                "No desktop app connected — use desktop.connect('App Name')"
            )

        # ── Gather state ──
        window_title = ""
        window_text = ""
        elements_summary = ""

        try:
            window_title = desktop_instance._win.window_text()
        except Exception:
            pass

        try:
            window_text = desktop_instance.text()
        except Exception:
            pass

        try:
            elements_summary = desktop_instance.elements()
        except Exception:
            pass

        details = {
            "window_title": window_title,
            "window_text_length": len(window_text),
            "window_text_preview": window_text[:300] if window_text else "(empty)",
            "elements": elements_summary[:300] if elements_summary else "(none)",
        }

        # ── Check expected content ──
        if expected:
            found = expected.lower() in window_text.lower()
            details["expected"] = expected
            details["found_in_text"] = found

            if found:
                return VerifyResult(
                    "desktop", True,
                    f"Content '{expected[:50]}' found in app window",
                    details
                )
            else:
                return VerifyResult(
                    "desktop", False,
                    f"Content '{expected[:50]}' NOT found in app window",
                    details
                )

        return VerifyResult(
            "desktop", True,
            f"Desktop state captured — {window_title}",
            details
        )

    except Exception as e:
        return VerifyResult("desktop", False, f"Desktop verify failed: {e}")


# ─── File Verification ─────────────────────────────────────────

def _verify_file(target_file: str | None, expected: str | None) -> VerifyResult:
    if not target_file:
        return VerifyResult("file", False, "No target file specified")

    try:
        if not os.path.exists(target_file):
            return VerifyResult(
                "file", False,
                f"File not found: {target_file}",
                {"path": target_file}
            )

        stat = os.stat(target_file)
        details = {
            "path": target_file,
            "size_bytes": stat.st_size,
            "modified": time.ctime(stat.st_mtime),
        }

        # Read content (text files only, limit size)
        content = ""
        try:
            with open(target_file, "r", encoding="utf-8") as f:
                content = f.read(10000)  # First 10KB
            details["content_preview"] = content[:300]
            details["content_length"] = len(content)
        except (UnicodeDecodeError, Exception):
            details["content_preview"] = "(binary file)"

        # Check expected content
        if expected:
            found = expected.lower() in content.lower()
            details["expected"] = expected
            details["found"] = found

            if found:
                return VerifyResult(
                    "file", True,
                    f"Content '{expected[:50]}' found in file",
                    details
                )
            else:
                return VerifyResult(
                    "file", False,
                    f"Content '{expected[:50]}' NOT found in file",
                    details
                )

        return VerifyResult(
            "file", True,
            f"File exists: {os.path.basename(target_file)} ({stat.st_size} bytes)",
            details
        )

    except Exception as e:
        return VerifyResult("file", False, f"File verify failed: {e}")


# ─── Screen Verification (multi-tier fallback chain) ────────────

def _verify_screen(expected: str | None) -> VerifyResult:
    details = {}

    # Get active window info (cheap, always try first)
    active_title = ""
    try:
        from .window_manager import get_active_window
        active = get_active_window()
        if active:
            active_title = active.get("title", "")
            details["active_window"] = active_title or "?"
            details["window_handle"] = f"0x{active.get('handle', 0):X}"
    except Exception:
        pass

    # Create ONE Desktop instance, connect ONCE, share across tiers
    desktop = None
    try:
        from proxima_agent.tools.desktop import Desktop
        desktop = Desktop()
        if active_title:
            desktop.connect(active_title)
    except Exception:
        pass

    # ── TIER 1: Accessibility text (d.text()) ──
    # Most reliable — uses OS-native accessibility API to read
    # actual text content from the focused window.
    # Windows: UIAutomation, Mac: AppleScript, Linux: AT-SPI
    tier1_text = _tier1_accessibility_text(desktop, details)
    if tier1_text and expected:
        if expected.lower() in tier1_text.lower():
            details["verification_method"] = "accessibility_text (tier 1)"
            details["found_in"] = "accessibility_text"
            return VerifyResult(
                "screen", True,
                f"Content '{expected[:50]}' found via accessibility API",
                details
            )

    # ── TIER 2: UI element scan (d.elements()) ──
    # Structured element names/types — less text but more precise.
    # Can find button labels, menu items, field values.
    tier2_text = _tier2_element_scan(desktop, details)
    if tier2_text and expected:
        if expected.lower() in tier2_text.lower():
            details["verification_method"] = "element_scan (tier 2)"
            details["found_in"] = "element_scan"
            return VerifyResult(
                "screen", True,
                f"Content '{expected[:50]}' found via UI element scan",
                details
            )

    # ── TIER 3: Screenshot + OCR ──
    # Absolute last resort. Takes a screenshot and runs OCR.
    # Unreliable — depends on font rendering, resolution, OCR accuracy.
    tier3_text = _tier3_screenshot_ocr(details)
    if tier3_text and expected:
        if expected.lower() in tier3_text.lower():
            details["verification_method"] = "screenshot_ocr (tier 3)"
            details["found_in"] = "ocr"
            return VerifyResult(
                "screen", True,
                f"Content '{expected[:50]}' found on screen (OCR — tier 3)",
                details
            )

    # ── Nothing found, or no expected text ──
    if expected:
        # Combine all text sources for the failure report
        all_text = " | ".join(filter(None, [tier1_text, tier2_text, tier3_text]))
        details["all_text_preview"] = all_text[:500] if all_text else "(no text captured)"
        details["expected"] = expected
        return VerifyResult(
            "screen", False,
            f"Content '{expected[:50]}' NOT found (tried all 3 tiers)",
            details
        )

    # No expected text — just return state
    method = "accessibility_text" if tier1_text else ("element_scan" if tier2_text else "screenshot")
    details["verification_method"] = method
    return VerifyResult(
        "screen", True,
        f"Screen state captured via {method}",
        details
    )


def _tier1_accessibility_text(desktop, details: dict) -> str:
    if desktop is None:
        return ""

    try:
        if desktop._win is not None:
            text = desktop.text() or ""
            if text:
                details["tier1_accessibility_text"] = text[:500]
                details["tier1_text_length"] = len(text)
                return text
    except Exception as e:
        details["tier1_error"] = str(e)[:100]

    return ""


def _tier2_element_scan(desktop, details: dict) -> str:
    if desktop is None:
        return ""

    try:
        if desktop._win is not None:
            elements_text = desktop.elements() or ""
            if elements_text:
                details["tier2_elements_preview"] = elements_text[:500]
                details["tier2_elements_length"] = len(elements_text)
                return elements_text
    except Exception as e:
        details["tier2_error"] = str(e)[:100]

    return ""


def _tier3_screenshot_ocr(details: dict) -> str:
    # Take screenshot
    screenshot_path = ""
    try:
        screenshot_path = os.path.join(
            os.path.expanduser("~"), ".proxima-agent", "verify_screenshot.png"
        )
        os.makedirs(os.path.dirname(screenshot_path), exist_ok=True)

        import pyautogui
        img = pyautogui.screenshot()
        img.save(screenshot_path)
        details["screenshot"] = screenshot_path
        details["resolution"] = f"{img.width}x{img.height}"
    except Exception as e:
        details["screenshot_error"] = str(e)[:100]
        return ""

    # Run OCR
    try:
        import pytesseract
        from PIL import Image
        img = Image.open(screenshot_path)
        ocr_text = pytesseract.image_to_string(img)
        if ocr_text:
            details["tier3_ocr_preview"] = ocr_text[:500]
            details["tier3_ocr_length"] = len(ocr_text)
            return ocr_text
    except ImportError:
        details["ocr"] = "pytesseract not available"
    except Exception as e:
        details["ocr_error"] = str(e)[:100]

    return ""
