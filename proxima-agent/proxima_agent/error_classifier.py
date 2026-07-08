"""Proxima — API Error Classifier.
Classifies API errors and network exceptions into structured retry/fallback recovery decisions.
"""

from __future__ import annotations

import enum
import re
from dataclasses import dataclass


class ErrorKind(enum.Enum):
    RETRY = "retry"
    RATE_LIMIT = "rate_limit"
    AUTH = "auth"
    CONTEXT_OVERFLOW = "context_overflow"
    BAD_REQUEST = "bad_request"
    EMPTY_RESPONSE = "empty_response"
    UNKNOWN = "unknown"


@dataclass
class Decision:
    """What the retry loop should do about an error."""
    kind: ErrorKind
    retryable: bool
    should_trim: bool
    status_code: int | None
    message: str
    hint: str = ""

    @property
    def is_terminal(self) -> bool:
        return not self.retryable


_RATE_LIMIT = (
    "rate limit", "rate_limit", "too many requests", "throttl",
    "quota", "resource_exhausted", "try again in", "retry after",
)
_AUTH = (
    "unauthorized", "invalid api key", "invalid_api_key", "authentication",
    "forbidden", "permission denied", "token expired", "token revoked",
    "not logged in",
)
_CONTEXT = (
    "context length", "context window", "maximum context", "too many tokens",
    "token limit", "prompt is too long", "reduce the length", "max_tokens",
    "input is too long",
)
_BAD_REQUEST = (
    "invalid_request", "unknown parameter", "unsupported parameter",
    "unrecognized request", "model not found", "invalid model",
    "does not exist", "unsupported model",
)
_EMPTY = (
    "empty response", "no response", "returned empty", "empty completion",
)
_TRANSPORT = (
    "timed out", "timeout", "connection", "connection reset", "broken pipe",
    "server disconnected", "temporarily unavailable", "overloaded",
    "service unavailable", "bad gateway", "eof occurred", "reset by peer",
)


def _extract_status(error: Exception) -> int | None:
    """Pulls an HTTP status code from an exception."""
    for attr in ("status_code", "status", "http_status", "code"):
        v = getattr(error, attr, None)
        if isinstance(v, int) and 100 <= v <= 599:
            return v
    m = re.search(r"\b(?:error code:?|status:?|http)\s*(\d{3})\b", str(error), re.IGNORECASE)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    return None


def _any(text: str, patterns) -> bool:
    return any(p in text for p in patterns)


def classify_api_error(error: Exception) -> Decision:
    """Classifies an exception into a Decision."""
    status = _extract_status(error)
    text = f"{type(error).__name__}: {error}".lower()

    def d(kind, *, retryable, trim=False, hint=""):
        return Decision(
            kind=kind, retryable=retryable, should_trim=trim,
            status_code=status, message=f"{kind.value} ({status})" if status else kind.value,
            hint=hint,
        )

    if status == 413 or _any(text, _CONTEXT):
        return d(ErrorKind.CONTEXT_OVERFLOW, retryable=True, trim=True,
                 hint="Context too large — trimming history and retrying.")

    if status in (401, 403) or _any(text, _AUTH):
        return d(ErrorKind.AUTH, retryable=False,
                 hint="Authentication failed — check the API key / login.")

    if status == 429 or _any(text, _RATE_LIMIT):
        return d(ErrorKind.RATE_LIMIT, retryable=True,
                 hint="Rate limited — backing off before retry.")

    if status in (400, 404, 422) or _any(text, _BAD_REQUEST):
        return d(ErrorKind.BAD_REQUEST, retryable=False,
                 hint="Request was rejected as invalid — not retrying unchanged.")

    if _any(text, _EMPTY):
        return d(ErrorKind.EMPTY_RESPONSE, retryable=True,
                 hint="Model returned an empty response — retrying.")

    if (status is not None and 500 <= status <= 599) or _any(text, _TRANSPORT):
        return d(ErrorKind.RETRY, retryable=True,
                 hint="Transient server/network error — retrying.")

    return d(ErrorKind.UNKNOWN, retryable=True,
             hint="Unclassified error — retrying with backoff.")
