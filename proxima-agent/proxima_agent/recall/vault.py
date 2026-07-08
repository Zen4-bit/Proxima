"""Proxima — Conversation Vault.
Provides persistent SQLite storage for conversation sessions and messages, supporting lineage tracking.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from typing import Optional

try:
    from ..config import MEMORY_DB_PATH
    _BASE_DIR = os.path.dirname(MEMORY_DB_PATH)
except Exception:
    _BASE_DIR = os.path.join(os.path.expanduser("~"), ".proxima-agent")

VAULT_DB_PATH = os.path.join(_BASE_DIR, "vault.db")

_MAX_SESSIONS = 500


def _connect() -> Optional[sqlite3.Connection]:
    """Opens vault database, initializing schema on first use."""
    conn = None
    try:
        os.makedirs(os.path.dirname(VAULT_DB_PATH), exist_ok=True)
        conn = sqlite3.connect(VAULT_DB_PATH, timeout=5.0)
        conn.row_factory = sqlite3.Row

        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=5000")
        except Exception:
            pass

        conn.executescript(_SCHEMA_SQL)
        conn.commit()
        return conn
    except Exception:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        return None


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT PRIMARY KEY,
    started_at        REAL NOT NULL,
    ended_at          REAL,
    end_reason        TEXT,
    model             TEXT,
    title             TEXT,
    message_count     INTEGER DEFAULT 0,
    parent_session_id TEXT,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id),
    role            TEXT NOT NULL,
    content         TEXT,
    tool_calls      TEXT,
    tool_call_id    TEXT,
    timestamp       REAL NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_msg_session  ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_msg_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_sess_started ON sessions(started_at);
"""


def _safe_close(conn: Optional[sqlite3.Connection]) -> None:
    """Closes database connection safely."""
    try:
        if conn:
            conn.close()
    except Exception:
        pass


def _serialize_tool_calls(tool_calls) -> Optional[str]:
    """Serializes tool calls to JSON string."""
    if not tool_calls:
        return None
    try:
        return json.dumps(tool_calls)
    except Exception:
        return None


def _deserialize_tool_calls(raw: Optional[str]) -> Optional[list]:
    """Deserializes JSON string to tool calls list."""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


class ConversationVault:
    """Persistent conversation storage backed by local SQLite."""

    def create_session(
        self, model: str = "", title: str = "", parent_id: str = ""
    ) -> Optional[str]:
        """Creates a new conversation session."""
        conn = _connect()
        if not conn:
            return None
        try:
            sid = uuid.uuid4().hex[:16]
            conn.execute(
                "INSERT INTO sessions (id, started_at, model, title, parent_session_id) "
                "VALUES (?,?,?,?,?)",
                (
                    sid,
                    time.time(),
                    model or "",
                    (title[:120] if title else ""),
                    parent_id or None,
                ),
            )
            conn.commit()
            self._auto_prune(conn)
            return sid
        except Exception:
            return None
        finally:
            _safe_close(conn)

    def end_session(self, session_id: str, reason: str = "user_exit") -> bool:
        """Ends conversation session with a reason."""
        conn = _connect()
        if not conn:
            return False
        try:
            conn.execute(
                "UPDATE sessions SET ended_at=?, end_reason=? WHERE id=?",
                (time.time(), reason, session_id),
            )
            conn.commit()
            return True
        except Exception:
            return False
        finally:
            _safe_close(conn)

    def update_title(self, session_id: str, title: str) -> bool:
        """Updates session title."""
        conn = _connect()
        if not conn:
            return False
        try:
            conn.execute(
                "UPDATE sessions SET title=? WHERE id=?",
                (title[:120], session_id),
            )
            conn.commit()
            return True
        except Exception:
            return False
        finally:
            _safe_close(conn)

    def rollover_session(
        self, old_session_id: str, model: str = ""
    ) -> Optional[str]:
        """Rollover current session to a new child session."""
        conn = _connect()
        if not conn:
            return None
        try:
            conn.execute(
                "UPDATE sessions SET ended_at=?, end_reason='compacted' WHERE id=?",
                (time.time(), old_session_id),
            )
            row = conn.execute(
                "SELECT title, model FROM sessions WHERE id=?",
                (old_session_id,),
            ).fetchone()
            inherited_title = row["title"] if row else ""
            inherited_model = model or (row["model"] if row else "")

            new_sid = uuid.uuid4().hex[:16]
            conn.execute(
                "INSERT INTO sessions "
                "(id, started_at, model, title, parent_session_id) "
                "VALUES (?,?,?,?,?)",
                (new_sid, time.time(), inherited_model, inherited_title, old_session_id),
            )
            conn.commit()
            return new_sid
        except Exception:
            return None
        finally:
            _safe_close(conn)

    def list_sessions(self, limit: int = 20) -> list[dict]:
        """Lists recent sessions sorted by starting time."""
        conn = _connect()
        if not conn:
            return []
        try:
            rows = conn.execute(
                "SELECT id, title, model, started_at, ended_at, "
                "message_count, parent_session_id "
                "FROM sessions ORDER BY started_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]
        except Exception:
            return []
        finally:
            _safe_close(conn)

    def get_session(self, session_id: str) -> Optional[dict]:
        """Gets metadata for a single session."""
        conn = _connect()
        if not conn:
            return None
        try:
            row = conn.execute(
                "SELECT * FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
            return dict(row) if row else None
        except Exception:
            return None
        finally:
            _safe_close(conn)

    def append_message(self, session_id: str, msg: dict) -> bool:
        """Appends a single message to session history."""
        conn = _connect()
        if not conn:
            return False
        try:
            conn.execute(
                "INSERT INTO messages "
                "(session_id, role, content, tool_calls, tool_call_id, timestamp) "
                "VALUES (?,?,?,?,?,?)",
                (
                    session_id,
                    msg.get("role", ""),
                    msg.get("content"),
                    _serialize_tool_calls(msg.get("tool_calls")),
                    msg.get("tool_call_id"),
                    time.time(),
                ),
            )
            conn.execute(
                "UPDATE sessions SET message_count = message_count + 1 WHERE id=?",
                (session_id,),
            )
            conn.commit()
            return True
        except Exception:
            return False
        finally:
            _safe_close(conn)

    def append_messages_batch(self, session_id: str, msgs: list[dict]) -> int:
        """Persists a batch of messages in a single transaction."""
        if not msgs:
            return 0
        conn = _connect()
        if not conn:
            return 0
        try:
            count = 0
            now = time.time()
            for msg in msgs:
                conn.execute(
                    "INSERT INTO messages "
                    "(session_id, role, content, tool_calls, tool_call_id, timestamp) "
                    "VALUES (?,?,?,?,?,?)",
                    (
                        session_id,
                        msg.get("role", ""),
                        msg.get("content"),
                        _serialize_tool_calls(msg.get("tool_calls")),
                        msg.get("tool_call_id"),
                        now,
                    ),
                )
                count += 1
            conn.execute(
                "UPDATE sessions SET message_count = message_count + ? WHERE id=?",
                (count, session_id),
            )
            conn.commit()
            return count
        except Exception:
            return 0
        finally:
            _safe_close(conn)

    def get_messages(
        self, session_id: str, include_ancestors: bool = False
    ) -> list[dict]:
        """Loads messages for a session, optionally including ancestors."""
        conn = _connect()
        if not conn:
            return []
        try:
            if include_ancestors:
                chain = self._get_lineage(conn, session_id)
            else:
                chain = [session_id]

            all_msgs: list[dict] = []
            for sid in chain:
                rows = conn.execute(
                    "SELECT role, content, tool_calls, tool_call_id "
                    "FROM messages "
                    "WHERE session_id=? AND active=1 ORDER BY id",
                    (sid,),
                ).fetchall()
                for r in rows:
                    msg: dict = {"role": r["role"]}
                    if r["content"] is not None:
                        msg["content"] = r["content"]
                    tc = _deserialize_tool_calls(r["tool_calls"])
                    if tc:
                        msg["tool_calls"] = tc
                    if r["tool_call_id"]:
                        msg["tool_call_id"] = r["tool_call_id"]
                    all_msgs.append(msg)
            return all_msgs
        except Exception:
            return []
        finally:
            _safe_close(conn)

    def search_messages(self, query: str, limit: int = 20) -> list[dict]:
        """Searches message content using a SQL LIKE query."""
        conn = _connect()
        if not conn:
            return []
        try:
            rows = conn.execute(
                "SELECT m.session_id, m.role, "
                "SUBSTR(m.content, 1, 300) AS content, "
                "s.title, m.timestamp "
                "FROM messages m JOIN sessions s ON m.session_id = s.id "
                "WHERE m.content LIKE ? AND m.active=1 "
                "ORDER BY m.timestamp DESC LIMIT ?",
                (f"%{query}%", limit),
            ).fetchall()
            return [dict(r) for r in rows]
        except Exception:
            return []
        finally:
            _safe_close(conn)

    def delete_session(self, session_id: str) -> bool:
        """Deletes a session and all its messages."""
        conn = _connect()
        if not conn:
            return False
        try:
            conn.execute("DELETE FROM messages WHERE session_id=?", (session_id,))
            conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
            conn.commit()
            return True
        except Exception:
            return False
        finally:
            _safe_close(conn)

    def _get_lineage(
        self, conn: sqlite3.Connection, session_id: str
    ) -> list[str]:
        """Retrieves the list of session IDs in lineage order."""
        chain: list[str] = []
        current: Optional[str] = session_id
        visited: set[str] = set()

        while current and current not in visited:
            visited.add(current)
            chain.append(current)
            row = conn.execute(
                "SELECT parent_session_id FROM sessions WHERE id=?",
                (current,),
            ).fetchone()
            parent = (
                row["parent_session_id"]
                if row and row["parent_session_id"]
                else None
            )
            if not parent:
                break
            prow = conn.execute(
                "SELECT end_reason FROM sessions WHERE id=?",
                (parent,),
            ).fetchone()
            if prow and prow["end_reason"] == "compacted":
                break
            current = parent

        chain.reverse()
        return chain

    def _auto_prune(self, conn: sqlite3.Connection) -> None:
        """Prunes oldest sessions when the cap is exceeded."""
        try:
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM sessions"
            ).fetchone()["c"]
            if total <= _MAX_SESSIONS:
                return
            overflow = total - _MAX_SESSIONS
            old_ids = conn.execute(
                "SELECT id FROM sessions ORDER BY started_at ASC LIMIT ?",
                (overflow,),
            ).fetchall()
            for row in old_ids:
                sid = row["id"]
                conn.execute("DELETE FROM messages WHERE session_id=?", (sid,))
                conn.execute("DELETE FROM sessions WHERE id=?", (sid,))
            conn.commit()
        except Exception:
            pass
