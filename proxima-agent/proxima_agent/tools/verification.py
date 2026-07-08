"""Proxima — Verification Engine.
Executes structured, proof-based verification checks against system state.
"""
from __future__ import annotations

import os
import time
import threading
from typing import Optional

VERIFY_PASS = "VERIFY:PASS"
VERIFY_FAIL = "VERIFY:FAIL"
VERIFY_UNKNOWN = "VERIFY:UNKNOWN"


class VerifyResult:
    """Outcome of a single verification check."""
    __slots__ = ("status", "check_type", "reason", "timestamp")

    PASS = "PASS"
    FAIL = "FAIL"
    UNKNOWN = "UNKNOWN"

    def __init__(self, status: str, check_type: str = "",
                 reason: str = ""):
        self.status = status
        self.check_type = check_type
        self.reason = reason
        self.timestamp = time.time()

    @property
    def passed(self) -> bool:
        return self.status == self.PASS

    def __repr__(self) -> str:
        tag = f":{self.reason}" if self.reason else ""
        return f"VerifyResult({self.status}{tag})"


_session_results: list[VerifyResult] = []
_MAX_SESSION_RESULTS = 500
_session_lock = threading.Lock()


def get_session_results() -> list[VerifyResult]:
    """Returns verification results from current session."""
    with _session_lock:
        return list(_session_results)


def clear_session() -> None:
    """Clears verification results in current session."""
    with _session_lock:
        _session_results.clear()


def session_summary() -> dict:
    """Aggregates session verification stats."""
    with _session_lock:
        snapshot = list(_session_results)
    if not snapshot:
        return {"total": 0, "passed": 0, "failed": 0, "unknown": 0,
                "overall": "UNKNOWN"}
    passed = sum(1 for r in snapshot if r.status == VerifyResult.PASS)
    failed = sum(1 for r in snapshot if r.status == VerifyResult.FAIL)
    unknown = sum(1 for r in snapshot if r.status == VerifyResult.UNKNOWN)
    total = len(snapshot)

    if failed > 0:
        overall = "FAIL"
    elif passed > 0 and unknown == 0:
        overall = "PASS"
    else:
        overall = "UNKNOWN"

    return {
        "total": total, "passed": passed,
        "failed": failed, "unknown": unknown,
        "overall": overall,
    }


def verify(type: str = "custom", **kwargs) -> VerifyResult:
    """Executes a structured verification check against system state."""
    try:
        result = _execute_check(type, kwargs)
    except Exception as e:
        result = VerifyResult(
            VerifyResult.UNKNOWN, type,
            f"Verify check error: {str(e)[:100]}"
        )

    with _session_lock:
        _session_results.append(result)
        if len(_session_results) > _MAX_SESSION_RESULTS:
            del _session_results[:-_MAX_SESSION_RESULTS]

    if result.status == VerifyResult.PASS:
        print(f"{VERIFY_PASS}")
    elif result.status == VerifyResult.FAIL:
        print(f"{VERIFY_FAIL}:{result.reason}")
    else:
        print(f"{VERIFY_UNKNOWN}:{result.reason}")

    return result


def _execute_check(check_type: str, params: dict) -> VerifyResult:
    """Routes check to its implementation."""
    if check_type == "url_match":
        return _check_url_match(params)
    elif check_type == "content_contains":
        return _check_content_contains(params)
    elif check_type == "file_exists":
        return _check_file_exists(params)
    elif check_type == "file_contains":
        return _check_file_contains(params)
    elif check_type == "element_exists":
        return _check_element_exists(params)
    elif check_type == "custom":
        return _check_custom(params)
    else:
        return VerifyResult(
            VerifyResult.UNKNOWN, check_type,
            f"Unknown check type: {check_type}"
        )


def _check_url_match(params: dict) -> VerifyResult:
    """Checks if current browser URL matches expected string."""
    expected = params.get("expected", "")
    if not expected:
        return VerifyResult(VerifyResult.UNKNOWN, "url_match",
                            "No expected URL provided")

    url = _get_browser_url()
    if url is None:
        return VerifyResult(VerifyResult.UNKNOWN, "url_match",
                            "Browser not accessible")

    if expected in url:
        return VerifyResult(VerifyResult.PASS, "url_match")

    return VerifyResult(VerifyResult.FAIL, "url_match",
                        f"Expected '{expected}' in URL, got '{url[:100]}'")


def _check_content_contains(params: dict) -> VerifyResult:
    """Checks if browser page content contains text."""
    text = params.get("text", "")
    if not text:
        return VerifyResult(VerifyResult.UNKNOWN, "content_contains",
                            "No expected text provided")

    content = _get_browser_content()
    if content is None:
        return VerifyResult(VerifyResult.UNKNOWN, "content_contains",
                            "Browser not accessible")

    case_sensitive = params.get("case_sensitive", False)
    if case_sensitive:
        found = text in content
    else:
        found = text.lower() in content.lower()

    if found:
        return VerifyResult(VerifyResult.PASS, "content_contains")

    return VerifyResult(VerifyResult.FAIL, "content_contains",
                        f"Text '{text[:60]}' not found in page content")


def _check_file_exists(params: dict) -> VerifyResult:
    """Checks if regular file exists at path."""
    path = params.get("path", "")
    if not path:
        return VerifyResult(VerifyResult.UNKNOWN, "file_exists",
                            "No path provided")

    if os.path.isfile(path):
        return VerifyResult(VerifyResult.PASS, "file_exists")

    if os.path.isdir(path):
        return VerifyResult(VerifyResult.FAIL, "file_exists",
                            f"Path exists but is a directory, not a file: {path}")

    return VerifyResult(VerifyResult.FAIL, "file_exists",
                        f"File not found: {path}")


def _check_file_contains(params: dict) -> VerifyResult:
    """Checks if file content contains target text."""
    path = params.get("path", "")
    text = params.get("text", "")
    if not path or not text:
        return VerifyResult(VerifyResult.UNKNOWN, "file_contains",
                            "Missing path or text")

    if not os.path.exists(path):
        return VerifyResult(VerifyResult.FAIL, "file_contains",
                            f"File not found: {path}")

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception as e:
        return VerifyResult(VerifyResult.UNKNOWN, "file_contains",
                            f"Cannot read file: {e}")

    if text in content:
        return VerifyResult(VerifyResult.PASS, "file_contains")

    return VerifyResult(VerifyResult.FAIL, "file_contains",
                        f"Text '{text[:60]}' not found in {os.path.basename(path)}")


def _check_element_exists(params: dict) -> VerifyResult:
    """Checks for DOM element existence in the browser."""
    selector = params.get("selector", "")
    text = params.get("text", "")
    if not selector and not text:
        return VerifyResult(VerifyResult.UNKNOWN, "element_exists",
                            "No selector or text provided")

    if selector:
        present = _selector_exists(selector)
        if present is None:
            return VerifyResult(VerifyResult.UNKNOWN, "element_exists",
                                "Browser not accessible (or invalid selector)")
        if present:
            return VerifyResult(VerifyResult.PASS, "element_exists")
        return VerifyResult(VerifyResult.FAIL, "element_exists",
                            f"No element matched selector '{selector[:60]}'")

    content = _get_browser_content()
    if content is None:
        return VerifyResult(VerifyResult.UNKNOWN, "element_exists",
                            "Browser not accessible")

    if text.lower() in content.lower():
        return VerifyResult(VerifyResult.PASS, "element_exists")

    return VerifyResult(VerifyResult.FAIL, "element_exists",
                        f"Element text '{text[:60]}' not found")


def _check_custom(params: dict) -> VerifyResult:
    """Manual pass/fail assertion checker."""
    passed = params.get("passed")
    reason = params.get("reason", "").strip()

    if passed is None:
        return VerifyResult(VerifyResult.UNKNOWN, "custom",
                            reason or "No assertion provided")
    elif passed:
        if not reason:
            return VerifyResult(VerifyResult.UNKNOWN, "custom",
                                "Custom PASS requires a reason describing "
                                "observable evidence (what did you see?)")
        return VerifyResult(VerifyResult.PASS, "custom", reason)
    else:
        return VerifyResult(VerifyResult.FAIL, "custom",
                            reason or "Custom check failed")


def _passive_browser():
    """Returns a ChromeBrowser instance if browser is currently active."""
    try:
        from proxima_agent.tools.browser_cdp import ChromeBrowser, _is_cdp_alive
        if not _is_cdp_alive():
            return None
        return ChromeBrowser(connect_only=True)
    except Exception:
        return None


def _get_browser_url() -> Optional[str]:
    """Returns url of the active browser tab."""
    b = _passive_browser()
    if b is None:
        return None
    try:
        url = b.url()
        if url and not url.startswith("chrome://") and not url.startswith("about:"):
            return url
    except Exception:
        pass
    return None


def _get_browser_content() -> Optional[str]:
    """Returns markdown text content of current browser tab."""
    b = _passive_browser()
    if b is None:
        return None
    try:
        return b.read_content()
    except Exception:
        return None


def _selector_exists(selector: str) -> Optional[bool]:
    """Checks if a DOM selector exists in active browser."""
    b = _passive_browser()
    if b is None:
        return None
    try:
        import json as _json
        sel_literal = _json.dumps(selector)
        res = b._js(f"document.querySelector({sel_literal}) ? '1' : '0'")
        if res == "1":
            return True
        if res == "0":
            return False
        return None
    except Exception:
        return None


def parse_verify_output(execution_result: str) -> dict:
    """Parses VERIFY outputs from execution result string."""
    if not execution_result:
        return {"status": "NONE", "reason": "", "verified": False}

    lines = execution_result.split("\n")
    last_status = None
    last_reason = ""

    for line in lines:
        stripped = line.strip()
        if stripped.startswith(VERIFY_PASS):
            last_status = "PASS"
            last_reason = ""
        elif stripped.startswith(VERIFY_FAIL):
            last_status = "FAIL"
            parts = stripped.split(":", 2)
            last_reason = parts[2] if len(parts) > 2 else ""
        elif stripped.startswith(VERIFY_UNKNOWN):
            last_status = "UNKNOWN"
            parts = stripped.split(":", 2)
            last_reason = parts[2] if len(parts) > 2 else ""

    if last_status is None:
        return {"status": "NONE", "reason": "", "verified": False}

    return {
        "status": last_status,
        "reason": last_reason,
        "verified": last_status == "PASS",
    }
