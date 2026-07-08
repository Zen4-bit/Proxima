"""Proxima — Attach System.
Manages file and screenshot attachment queuing for downstream model consumption.
"""

import os
import json
import time
import tempfile

__all__ = ["attach"]

_MAX_FILE_SIZE = 25 * 1024 * 1024
_MAX_AGE_SECS = 15 * 60


def _state_dir() -> str:
    """Returns writable state directory path."""
    d = os.path.join(os.path.expanduser("~"), ".proxima-agent")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


def _slot_path() -> str:
    return os.path.join(_state_dir(), "pending_attachment.json")


def _resolve(path: str) -> str | None:
    """Resolves a file path to an absolute path if it exists."""
    if not path or not isinstance(path, str):
        return None
    try:
        ap = os.path.abspath(os.path.expanduser(path.strip().strip('"').strip("'")))
    except Exception:
        return None
    return ap if os.path.isfile(ap) else None


def _validate(path: str) -> tuple[bool, str, str | None]:
    """Validates that a file exists and is within size limits."""
    ap = _resolve(path)
    if not ap:
        return False, f"file not found: {path}", None
    try:
        size = os.path.getsize(ap)
    except Exception as e:
        return False, f"cannot read file: {e}", None
    if size > _MAX_FILE_SIZE:
        mb = size / 1024 / 1024
        return False, f"file too large ({mb:.1f} MB). Max is 25 MB", None
    if size == 0:
        return False, "file is empty", None
    return True, "ok", ap


def _write_slot(abs_path: str, note: str = "") -> None:
    """Saves the pending attachment path to temporary slot file."""
    payload = {"path": abs_path, "note": note or "", "ts": time.time()}
    d = _state_dir()
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".pending_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, _slot_path())
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def attach(path: str, note: str = "") -> str:
    """Queues a local file for attachment to the next outgoing message."""
    ok, msg, ap = _validate(path)
    if not ok:
        out = f"[attach] NOT attached — {msg}"
        print(out)
        return out
    _write_slot(ap, note)
    focus = f" Focus: {note}." if note else ""
    out = f"[attach] Queued '{os.path.basename(ap)}' — the model will read it with your next message.{focus}"
    print(out)
    return out


def note_screenshot(path: str) -> str:
    """Queues a screenshot file path for auto-attachment."""
    try:
        ok, _msg, ap = _validate(path)
        if not ok:
            return ""
        _write_slot(ap, note="")
        return " — auto-attached; the model will see this image next message."
    except Exception:
        return ""


def consume_pending() -> str | None:
    """Consumes and deletes the queued pending attachment path."""
    sp = _slot_path()
    if not os.path.exists(sp):
        return None
    path = None
    try:
        with open(sp, "r", encoding="utf-8") as f:
            data = json.load(f)
        ts = float(data.get("ts", 0))
        cand = data.get("path")
        if cand and os.path.isfile(cand) and (time.time() - ts) <= _MAX_AGE_SECS:
            path = cand
    except Exception:
        path = None
    finally:
        try:
            os.unlink(sp)
        except Exception:
            pass
    return path


def clear_pending() -> None:
    """Deletes the pending attachment slot file."""
    try:
        sp = _slot_path()
        if os.path.exists(sp):
            os.unlink(sp)
    except Exception:
        pass


_HOOK_INSTALLED = False


def install_screenshot_hook() -> None:
    """Patches pyautogui to auto-queue screenshot saves."""
    global _HOOK_INSTALLED
    if _HOOK_INSTALLED:
        return
    try:
        import pyautogui
    except Exception:
        return

    if getattr(pyautogui.screenshot, "_proxima_wrapped", False):
        _HOOK_INSTALLED = True
        return

    _orig_screenshot = pyautogui.screenshot

    def _wrapped_screenshot(imageFilename=None, region=None, allScreens=False):
        _kwargs = {"imageFilename": imageFilename, "region": region}
        if allScreens:
            _kwargs["allScreens"] = True
        try:
            img = _orig_screenshot(**_kwargs)
        except TypeError:
            _kwargs.pop("allScreens", None)
            img = _orig_screenshot(**_kwargs)
        if imageFilename:
            try:
                note_screenshot(imageFilename)
            except Exception:
                pass
        else:
            try:
                _wrap_pil_save(img)
            except Exception:
                pass
        return img

    _wrapped_screenshot._proxima_wrapped = True
    pyautogui.screenshot = _wrapped_screenshot
    _HOOK_INSTALLED = True


def _wrap_pil_save(img) -> None:
    """Patches PIL Image.save to auto-queue saved files."""
    if img is None or getattr(img, "_proxima_save_wrapped", False):
        return
    _orig_save = img.save

    def _wrapped_save(fp, *args, **kwargs):
        result = _orig_save(fp, *args, **kwargs)
        try:
            if isinstance(fp, (str, os.PathLike)):
                note_screenshot(os.fspath(fp))
        except Exception:
            pass
        return result

    try:
        img.save = _wrapped_save
        img._proxima_save_wrapped = True
    except Exception:
        pass
