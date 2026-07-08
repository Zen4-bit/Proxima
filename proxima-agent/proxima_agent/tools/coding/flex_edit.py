"""Proxima — Flexible Edit.
Provides fuzzy matching capabilities to resolve edits with loose whitespace and unicode matching.
"""
import re
from difflib import SequenceMatcher
from typing import Callable, List, Optional, Tuple

_UNICODE_FOLD = {
    "\u201c": '"', "\u201d": '"',
    "\u2018": "'", "\u2019": "'",
    "\u2014": "--", "\u2013": "-",
    "\u2026": "...", "\u00a0": " ",
}

Span = Tuple[int, int]


def find_and_replace_flexible(
    text: str,
    old: str,
    new: str,
    all_occurrences: bool = False,
) -> Tuple[str, int, Optional[str], Optional[str]]:
    """Performs resilient text replacement on code snippets."""
    if not old:
        return text, 0, None, "search text is empty"
    if old == new:
        return text, 0, None, "search and replacement text are identical"

    ladder: List[Tuple[str, Callable[[str, str], List[Span]]]] = [
        ("exact", _match_exact),
        ("line_trim", _match_line_trim),
        ("space_collapse", _match_space_collapse),
        ("indent_free", _match_indent_free),
        ("escape_decode", _match_escape_decode),
        ("edge_trim", _match_edge_trim),
        ("unicode_fold", _match_unicode_fold),
        ("block_anchor", _match_block_anchor),
        ("line_similar", _match_line_similar),
    ]

    for method, matcher in ladder:
        spans = matcher(text, old)
        if not spans:
            continue

        if len(spans) > 1 and not all_occurrences:
            return text, 0, None, (
                f"{len(spans)} regions match the search text. Add surrounding "
                f"context to make it unique, or set all_occurrences=True."
            )

        loose = method != "exact"

        if loose:
            drift = _escape_drift_error(text, spans, old, new)
            if drift:
                return text, 0, None, drift

        effective = _decode_transport_escapes(new, text, spans)
        out = _splice(text, spans, effective, old if loose else None)
        return out, len(spans), method, None

    return text, 0, None, "search text not found in file"


def _match_exact(text: str, needle: str) -> List[Span]:
    """Plain substring exact search returning character spans."""
    spans: List[Span] = []
    cursor = 0
    while True:
        hit = text.find(needle, cursor)
        if hit == -1:
            break
        spans.append((hit, hit + len(needle)))
        cursor = hit + 1
    return spans


def _match_by_line_transform(
    text: str, pattern: str, line_fn: Callable[[str], str]
) -> List[Span]:
    """Generic line-block matcher using a transform function."""
    text_lines = text.split("\n")
    target = "\n".join(line_fn(ln) for ln in pattern.split("\n"))
    window_size = pattern.count("\n") + 1

    spans: List[Span] = []
    for i in range(len(text_lines) - window_size + 1):
        window = "\n".join(line_fn(ln) for ln in text_lines[i:i + window_size])
        if window == target:
            spans.append(_line_block_span(text_lines, i, i + window_size, len(text)))
    return spans


def _match_line_trim(text: str, pattern: str) -> List[Span]:
    """Fuzzy matcher ignoring line-level leading/trailing whitespace."""
    return _match_by_line_transform(text, pattern, str.strip)


def _match_space_collapse(text: str, pattern: str) -> List[Span]:
    """Fuzzy matcher collapsing runs of spaces and tabs to single spaces."""
    collapse = lambda ln: re.sub(r"[ \t]+", " ", ln)
    return _match_by_line_transform(text, pattern, collapse)


def _match_indent_free(text: str, pattern: str) -> List[Span]:
    """Fuzzy matcher dropping leading line indentation entirely."""
    return _match_by_line_transform(text, pattern, str.lstrip)


def _match_escape_decode(text: str, pattern: str) -> List[Span]:
    """Fuzzy matcher decoding literal tab, newline, and return sequences."""
    decoded = pattern.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
    if decoded == pattern:
        return []
    return _match_exact(text, decoded)


def _match_edge_trim(text: str, pattern: str) -> List[Span]:
    """Fuzzy matcher trimming whitespace from first and last block lines only."""
    pat_lines = pattern.split("\n")
    if not pat_lines:
        return []
    target = _trim_edges(pat_lines)
    window_size = len(pat_lines)

    text_lines = text.split("\n")
    spans: List[Span] = []
    for i in range(len(text_lines) - window_size + 1):
        if _trim_edges(text_lines[i:i + window_size]) == target:
            spans.append(_line_block_span(text_lines, i, i + window_size, len(text)))
    return spans


def _match_unicode_fold(text: str, pattern: str) -> List[Span]:
    """Folds typographic symbols into ASCII equivalents before matching."""
    folded_pat = _fold_unicode(pattern)
    folded_text = _fold_unicode(text)
    if folded_pat == pattern and folded_text == text:
        return []

    folded_spans = _match_exact(folded_text, folded_pat)
    if not folded_spans:
        folded_spans = _match_by_line_transform(folded_text, folded_pat, str.strip)
    if not folded_spans:
        return []
    return _remap_folded_spans(text, folded_spans)


def _match_block_anchor(text: str, pattern: str) -> List[Span]:
    """Anchor-based middle similarity matcher."""
    folded_pat = _fold_unicode(pattern)
    pat_lines = folded_pat.split("\n")
    if len(pat_lines) < 2:
        return []

    head, tail = pat_lines[0].strip(), pat_lines[-1].strip()
    folded_lines = _fold_unicode(text).split("\n")
    orig_lines = text.split("\n")
    window_size = len(pat_lines)

    candidates = [
        i for i in range(len(folded_lines) - window_size + 1)
        if folded_lines[i].strip() == head
        and folded_lines[i + window_size - 1].strip() == tail
    ]
    if not candidates:
        return []

    cutoff = 0.80 if len(candidates) == 1 else 0.90
    spans: List[Span] = []
    for i in candidates:
        if window_size <= 2:
            score = 1.0
        else:
            mid_text = "\n".join(folded_lines[i + 1:i + window_size - 1])
            mid_pat = "\n".join(pat_lines[1:-1])
            score = SequenceMatcher(None, mid_text, mid_pat).ratio()
        if score >= cutoff:
            spans.append(_line_block_span(orig_lines, i, i + window_size, len(text)))
    return spans


def _match_line_similar(text: str, pattern: str) -> List[Span]:
    """Line-by-line fuzzy similarity matcher."""
    pat_lines = pattern.split("\n")
    if not pat_lines:
        return []
    text_lines = text.split("\n")
    window_size = len(pat_lines)

    spans: List[Span] = []
    for i in range(len(text_lines) - window_size + 1):
        window = text_lines[i:i + window_size]
        close = sum(
            1 for p, c in zip(pat_lines, window)
            if SequenceMatcher(None, p.strip(), c.strip()).ratio() >= 0.85
        )
        if close >= window_size * 0.75:
            spans.append(_line_block_span(text_lines, i, i + window_size, len(text)))
    return spans


def _splice(text: str, spans: List[Span], replacement: str,
            old: Optional[str]) -> str:
    """Splices replacement content into character spans back-to-front."""
    out = text
    for start, end in sorted(spans, key=lambda s: s[0], reverse=True):
        piece = replacement if old is None else _realign_indent(text[start:end], old, replacement)
        out = out[:start] + piece + out[end:]
    return out


def _realign_indent(file_region: str, old: str, new: str) -> str:
    """Aligns indentation of new block with the matched file region."""
    if not new:
        return new

    old_anchor = _first_content_line(old)
    file_anchor = _first_content_line(file_region)
    if old_anchor is None or file_anchor is None:
        return new

    old_indent = _indent_of(old_anchor)
    file_indent = _indent_of(file_anchor)
    if old_indent == file_indent:
        return new

    rebuilt: List[str] = []
    for line in new.split("\n"):
        if not line.strip():
            rebuilt.append(line)
        elif _indent_of(line).startswith(old_indent):
            rebuilt.append(file_indent + line[len(old_indent):])
        else:
            rebuilt.append(file_indent + line.lstrip(" \t"))
    return "\n".join(rebuilt)


def _decode_transport_escapes(new: str, text: str, spans: List[Span]) -> str:
    """Decodes transport character escapes for tab and return characters."""
    if "\\t" not in new and "\\r" not in new:
        return new
    region = "".join(text[s:e] for s, e in spans)
    out = new
    if "\\t" in out and "\t" in region:
        out = out.replace("\\t", "\t")
    if "\\r" in out and "\r" in region:
        out = out.replace("\\r", "\r")
    return out


def _escape_drift_error(text: str, spans: List[Span], old: str,
                        new: str) -> Optional[str]:
    """Flags escaped apostrophe and quote backslash drift errors."""
    if "\\'" not in new and '\\"' not in new:
        return None
    region = "".join(text[s:e] for s, e in spans)
    for token in ("\\'", '\\"'):
        if token in new and token in old and token not in region:
            bare = token[1]
            return (
                f"Escape-drift detected: old and new contain {token!r} but the "
                f"matched file region does not. This is usually a tool-call "
                f"artifact where {bare!r} got a stray backslash. Re-read the "
                f"file and pass old/new without backslash-escaping {bare!r}."
            )
    return None


def suggest_similar_regions(error: Optional[str], hit_count: int,
                            old: str, text: str) -> str:
    """Returns "did you mean" hints for similar looking sections."""
    if hit_count != 0:
        return ""
    if not error or not error.startswith("search text not found"):
        return ""
    snippet = _closest_lines(old, text)
    if not snippet:
        return ""
    return "\n\nClosest matching sections:\n" + snippet


def _closest_lines(old: str, text: str, context: int = 2, limit: int = 3) -> str:
    """Finds lines most similar to searching snippet's first line."""
    if not old or not text:
        return ""
    old_lines = old.splitlines()
    text_lines = text.splitlines()
    if not old_lines or not text_lines:
        return ""

    anchor = next((ln.strip() for ln in old_lines if ln.strip()), "")
    if not anchor:
        return ""

    scored = [
        (SequenceMatcher(None, anchor, ln.strip()).ratio(), i)
        for i, ln in enumerate(text_lines) if ln.strip()
    ]
    scored = [s for s in scored if s[0] > 0.3]
    if not scored:
        return ""
    scored.sort(key=lambda s: -s[0])

    blocks: List[str] = []
    seen = set()
    for _, idx in scored[:limit]:
        start = max(0, idx - context)
        end = min(len(text_lines), idx + len(old_lines) + context)
        if (start, end) in seen:
            continue
        seen.add((start, end))
        blocks.append("\n".join(
            f"{start + j + 1:4d}| {text_lines[start + j]}" for j in range(end - start)
        ))
    return "\n---\n".join(blocks)


def _indent_of(line: str) -> str:
    """Returns leading whitespace sequence of a line."""
    i = 0
    while i < len(line) and line[i] in (" ", "\t"):
        i += 1
    return line[:i]


def _first_content_line(text: str) -> Optional[str]:
    """Returns first line containing non-whitespace content."""
    for line in text.split("\n"):
        if line.strip():
            return line
    return None


def _trim_edges(lines: List[str]) -> str:
    """Trims whitespace from first and last lines."""
    trimmed = list(lines)
    trimmed[0] = trimmed[0].strip()
    if len(trimmed) > 1:
        trimmed[-1] = trimmed[-1].strip()
    return "\n".join(trimmed)


def _line_block_span(lines: List[str], start: int, end: int, total: int) -> Span:
    """Converts line index range to absolute character span."""
    begin = sum(len(ln) + 1 for ln in lines[:start])
    finish = sum(len(ln) + 1 for ln in lines[:end]) - 1
    return begin, min(total, finish)


def _fold_unicode(text: str) -> str:
    """Converts typographic characters to ASCII."""
    for ch, repl in _UNICODE_FOLD.items():
        text = text.replace(ch, repl)
    return text


def _remap_folded_spans(original: str, folded_spans: List[Span]) -> List[Span]:
    """Maps spans from folded copy back to original character indices."""
    offsets: List[int] = []
    pos = 0
    for ch in original:
        offsets.append(pos)
        repl = _UNICODE_FOLD.get(ch)
        pos += len(repl) if repl is not None else 1
    offsets.append(pos)

    start_for: dict = {}
    for orig_i, folded_pos in enumerate(offsets[:-1]):
        start_for.setdefault(folded_pos, orig_i)

    orig_len = len(offsets) - 1
    result: List[Span] = []
    for f_start, f_end in folded_spans:
        if f_start not in start_for:
            continue
        o_start = start_for[f_start]
        o_end = o_start
        while o_end < orig_len and offsets[o_end] < f_end:
            o_end += 1
        result.append((o_start, o_end))
    return result
