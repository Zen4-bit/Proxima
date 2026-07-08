"""Proxima — Learning Memory.
Provides a SQLite-backed store for automatic cross-session experience learning.
"""
from __future__ import annotations

import os
import re
import sqlite3
import time
from typing import Optional

try:
    from ..config import MEMORY_DB_PATH
except Exception:
    MEMORY_DB_PATH = os.path.join(os.path.expanduser("~"), ".proxima-agent", "memory.db")

_MAX_ENTRIES = 300
_MAX_CODE_CHARS = 600
_RETRIEVE_LIMIT = 3


def _now() -> float:
    return time.time()


def _connect() -> Optional[sqlite3.Connection]:
    """Opens the SQLite memory database, initializing schema on first use."""
    conn = None
    try:
        os.makedirs(os.path.dirname(MEMORY_DB_PATH), exist_ok=True)
        conn = sqlite3.connect(MEMORY_DB_PATH, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lessons (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ctx_key     TEXT NOT NULL,
                goal        TEXT NOT NULL,
                worked      TEXT NOT NULL,
                failed      TEXT,
                hits        INTEGER DEFAULT 1,
                created_at  REAL NOT NULL,
                updated_at  REAL NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_lessons_key ON lessons(ctx_key)"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_keygoal "
            "ON lessons(ctx_key, goal)"
        )
        conn.commit()
        return conn
    except Exception:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        return None


def _clip(text: str, limit: int = _MAX_CODE_CHARS) -> str:
    if not text:
        return ""
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + " …[truncated]"


def normalize_key(raw: str) -> str:
    """Normalizes a context string to a stable key."""
    if not raw:
        return "general"
    raw = raw.strip()
    m = re.match(r'^[a-zA-Z][a-zA-Z0-9+.\-]*://([^/\s:]+)', raw)
    if m:
        host = m.group(1).lower()
        return host[4:] if host.startswith("www.") else host
    if "." in raw and "/" in raw and " " not in raw.split("/")[0]:
        host = raw.split("/")[0].lower()
        return host[4:] if host.startswith("www.") else host
    return raw.lower()[:80]


def record_lesson(ctx_key: str, goal: str, worked_code: str,
                  failed_code: str = "") -> bool:
    """Stores or updates a learned lesson in memory."""
    if not goal or not worked_code:
        return False
    conn = _connect()
    if conn is None:
        return False
    try:
        key = normalize_key(ctx_key)
        goal = goal.strip()[:120]
        worked = _clip(worked_code)
        failed = _clip(failed_code)
        now = _now()
        cur = conn.execute(
            "SELECT id, hits FROM lessons WHERE ctx_key=? AND goal=?",
            (key, goal),
        )
        row = cur.fetchone()
        if row:
            conn.execute(
                "UPDATE lessons SET worked=?, failed=?, hits=hits+1, updated_at=? WHERE id=?",
                (worked, failed, now, row[0]),
            )
        else:
            conn.execute(
                "INSERT INTO lessons (ctx_key, goal, worked, failed, hits, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (key, goal, worked, failed, 1, now, now),
            )
        conn.commit()
        _prune(conn)
        return True
    except Exception:
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass


def recall(ctx_key: str, limit: int = _RETRIEVE_LIMIT) -> list[dict]:
    """Recalls matching lessons for a context key."""
    conn = _connect()
    if conn is None:
        return []
    try:
        key = normalize_key(ctx_key)
        cur = conn.execute(
            "SELECT goal, worked, failed, hits FROM lessons WHERE ctx_key=? "
            "ORDER BY hits DESC, updated_at DESC LIMIT ?",
            (key, max(1, limit)),
        )
        return [
            {"goal": r[0], "worked": r[1], "failed": r[2], "hits": r[3]}
            for r in cur.fetchall()
        ]
    except Exception:
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass


def format_for_prompt(lessons: list[dict]) -> str:
    """Formats recalled lessons for prompt injection."""
    if not lessons:
        return ""
    lines = ["[LEARNED FROM PAST RUNS — proven on this site/app]"]
    for l in lessons:
        lines.append(f"- {l['goal']}: this WORKED → {l['worked']}")
        if l.get("failed"):
            lines.append(f"    (avoid — failed before: {l['failed']})")
    return "\n".join(lines)


def _prune(conn: sqlite3.Connection) -> None:
    """Prunes memory store keeping it within limits."""
    try:
        cur = conn.execute("SELECT COUNT(*) FROM lessons")
        total = cur.fetchone()[0]
        if total <= _MAX_ENTRIES:
            return
        overflow = total - _MAX_ENTRIES
        conn.execute(
            "DELETE FROM lessons WHERE id IN ("
            "  SELECT id FROM lessons ORDER BY hits ASC, updated_at ASC LIMIT ?"
            ")",
            (overflow,),
        )
        conn.commit()
    except Exception:
        pass
