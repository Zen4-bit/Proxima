"""Proxima — File Operations.
Provides file read, write, edit, insert, delete, append, patch, copy, and move operations.
"""
import os
import shutil
from pathlib import Path

from .flex_edit import find_and_replace_flexible, suggest_similar_regions


def _detect_ending(raw: str) -> str:
    crlf = raw.count("\r\n")
    lf = raw.count("\n") - crlf
    return "\r\n" if crlf > lf else "\n"


def _read_for_edit(path: str):
    """Returns content normalized to LF and original line ending style."""
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        raw = f.read()
    ending = _detect_ending(raw)
    normalized = raw.replace("\r\n", "\n").replace("\r", "\n")
    return normalized, ending


def _atomic_write(path, content: str, encoding: str = "utf-8") -> None:
    """Writes content atomically using a temporary file in the same directory."""
    import tempfile as _tf
    target = str(path)
    directory = os.path.dirname(target) or "."
    fd, tmp = _tf.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline="") as f:
            f.write(content)
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _write_preserving(path: str, content: str, ending: str):
    """Writes content preserving line endings atomically."""
    if ending == "\r\n":
        content = content.replace("\n", "\r\n")
    _atomic_write(path, content)


def read_file(path, start=None, end=None, encoding="utf-8", raw=False):
    """Reads file contents, optionally returning a specific line range."""
    path = str(Path(path).resolve())
    try:
        with open(path, "r", encoding=encoding, errors="replace") as f:
            text = f.read()
    except OSError as e:
        return f"✗ Cannot read {path}: {e}"
    lines = text.splitlines(keepends=True)

    total = len(lines)
    if start is not None or end is not None:
        s = max(1, start or 1) - 1
        e = min(total, end or total)
        selected = lines[s:e]
        if raw:
            return "".join(selected)
        result = ""
        for i, line in enumerate(selected, s + 1):
            result += f"{i:4d} | {line}"
        return result

    if raw:
        return text

    result = ""
    for i, line in enumerate(lines, 1):
        result += f"{i:4d} | {line}"
    return result


def read_file_raw(path, encoding="utf-8"):
    """Reads raw file content without line numbers."""
    return read_file(path, encoding=encoding, raw=True)


def write_file(path, content, encoding="utf-8"):
    """Creates or overwrites a file with target content."""
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    ending = "\n"
    if path.exists():
        try:
            with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
                ending = _detect_ending(f.read())
        except Exception:
            ending = "\n"
    out = normalized.replace("\n", "\r\n") if ending == "\r\n" else normalized
    _atomic_write(path, out, encoding)
    return f"✓ Written: {path} ({len(content)} chars)"


def edit_file(path, old, new, count=1):
    """Replaces target text in a file using exact or flexible matching."""
    path = str(Path(path).resolve())
    content, ending = _read_for_edit(path)
    old = old.replace("\r\n", "\n").replace("\r", "\n")
    new = new.replace("\r\n", "\n").replace("\r", "\n")

    occurrences = content.count(old)

    if occurrences > 0:
        if count == 0:
            new_content = content.replace(old, new)
            replaced = occurrences
        else:
            new_content = content.replace(old, new, count)
            replaced = min(count, occurrences)

        _write_preserving(path, new_content, ending)
        return f"✓ Replaced {replaced} occurrence(s) in {path}"

    new_content, match_count, method, error = find_and_replace_flexible(
        content, old, new, all_occurrences=(count == 0)
    )

    if match_count == 0:
        hint = suggest_similar_regions(error, match_count, old, content)
        reason = error or "no match"
        return f"✗ Not found: '{old[:80]}' in {path} ({reason}){hint}"

    _write_preserving(path, new_content, ending)
    return (
        f"✓ Replaced {match_count} occurrence(s) in {path} "
        f"(flexible match: {method})"
    )


def insert_lines(path, line_num, content):
    """Inserts content at a specific line number."""
    path = str(Path(path).resolve())
    text, ending = _read_for_edit(path)
    lines = text.splitlines(keepends=True)
    
    idx = max(0, min(line_num - 1, len(lines)))
    new_lines = content.replace("\r\n", "\n").splitlines() if isinstance(content, str) else list(content)
    for i, line in enumerate(new_lines):
        if not line.endswith("\n"):
            line += "\n"
        lines.insert(idx + i, line)
    
    _write_preserving(path, "".join(lines), ending)
    return f"✓ Inserted {len(new_lines)} lines at line {line_num} in {path}"


def delete_lines(path, start, end):
    """Deletes a line range from a file."""
    path = str(Path(path).resolve())
    text, ending = _read_for_edit(path)
    lines = text.splitlines(keepends=True)
    
    s = max(0, start - 1)
    e = min(len(lines), end)
    deleted = lines[s:e]
    del lines[s:e]
    
    _write_preserving(path, "".join(lines), ending)
    return f"✓ Deleted lines {start}-{end} ({len(deleted)} lines) from {path}"


def append_file(path, content):
    """Appends content to the end of a file."""
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    ending = "\n"
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
                ending = _detect_ending(f.read())
        except Exception:
            ending = "\n"
    out = normalized.replace("\n", "\r\n") if ending == "\r\n" else normalized
    with open(path, "a", encoding="utf-8", newline="") as f:
        f.write(out)
    return f"✓ Appended to {path}"


def patch_file(path, edits):
    """Applies multiple edits to a file in a single pass."""
    path = str(Path(path).resolve())
    content, ending = _read_for_edit(path)

    results = []
    for edit in edits:
        old = edit["old"].replace("\r\n", "\n").replace("\r", "\n")
        new = edit["new"].replace("\r\n", "\n").replace("\r", "\n")

        if old in content:
            content = content.replace(old, new, 1)
            results.append(f"✓ '{old[:40]}' → '{new[:40]}'")
            continue

        new_content, match_count, method, error = find_and_replace_flexible(
            content, old, new, all_occurrences=False
        )
        if match_count > 0:
            content = new_content
            results.append(f"✓ '{old[:40]}' → '{new[:40]}' (flexible: {method})")
        else:
            reason = error or "no match"
            results.append(f"✗ Not found: '{old[:40]}' ({reason})")

    _write_preserving(path, content, ending)
    return "\n".join(results)


def copy_file(src, dst):
    """Copies a file or directory."""
    src, dst = str(Path(src).resolve()), str(Path(dst).resolve())
    try:
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            Path(dst).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    except (OSError, shutil.Error) as e:
        return f"✗ Copy failed: {src} → {dst}: {e}"
    return f"✓ Copied: {src} → {dst}"


def move_file(src, dst):
    """Moves or renames a file or directory."""
    src, dst = str(Path(src).resolve()), str(Path(dst).resolve())
    try:
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        shutil.move(src, dst)
    except (OSError, shutil.Error) as e:
        return f"✗ Move failed: {src} → {dst}: {e}"
    return f"✓ Moved: {src} → {dst}"
