"""Proxima — Web UI Database.
"""
import sqlite3
import json
import uuid
import os
from contextlib import contextmanager
from datetime import datetime, timezone


def _resolve_db_path() -> str:
    base = os.environ.get("PROXIMA_DATA_DIR") or os.path.join(
        os.path.expanduser("~"), ".proxima-agent"
    )
    db_dir = os.path.join(base, "web")
    try:
        os.makedirs(db_dir, exist_ok=True)
        return os.path.join(db_dir, "proxima_web.db")
    except Exception:
        import tempfile
        return os.path.join(tempfile.gettempdir(), "proxima_web.db")


_DB_PATH = _resolve_db_path()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def _conn():
    conn = get_connection()
    try:
        yield conn
    finally:
        try:
            conn.close()
        except Exception:
            pass


def init_db():
    conn = get_connection()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS conversations (
            id                   TEXT PRIMARY KEY,
            title                TEXT,
            created_at           TEXT NOT NULL,
            updated_at           TEXT NOT NULL,
            model                TEXT,
            mode                 TEXT,
            custom_instructions  TEXT,
            is_active            INTEGER DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role            TEXT NOT NULL,
            content         TEXT,
            tool_call_id    TEXT,
            timestamp       TEXT NOT NULL,
            metadata        TEXT
        );

        CREATE TABLE IF NOT EXISTS executions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            code            TEXT NOT NULL,
            description     TEXT,
            result          TEXT,
            success         INTEGER,
            duration_ms     INTEGER,
            source          TEXT,
            tool_name       TEXT,
            timestamp       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key     TEXT PRIMARY KEY,
            value   TEXT
        );

        CREATE TABLE IF NOT EXISTS brain_snapshots (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            plan_json       TEXT,
            progress        TEXT,
            verified        INTEGER DEFAULT 0,
            timestamp       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS screenshots (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            file_path       TEXT NOT NULL,
            description     TEXT,
            timestamp       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS templates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            type        TEXT NOT NULL,
            category    TEXT,
            title       TEXT NOT NULL,
            content     TEXT NOT NULL,
            is_builtin  INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profiles (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT UNIQUE NOT NULL,
            config_json TEXT NOT NULL,
            is_active   INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tool_usage (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
            tool_name       TEXT NOT NULL,
            method_name     TEXT,
            success         INTEGER,
            timestamp       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS token_usage (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
            model           TEXT,
            input_tokens    INTEGER,
            output_tokens   INTEGER,
            estimated_cost  REAL,
            timestamp       TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_executions_conv ON executions(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_tool_usage_conv ON tool_usage(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_token_usage_conv ON token_usage(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
    """)
    conn.commit()

    _run_migrations(conn)
    conn.close()

    try:
        prune_volatile_data()
    except Exception:
        pass




_MIGRATIONS: list[list[str]] = [
    [
        "ALTER TABLE conversations ADD COLUMN is_pinned INTEGER DEFAULT 0",
        "ALTER TABLE conversations ADD COLUMN folder_name TEXT",
    ],
]


def _run_migrations(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    for i in range(version, len(_MIGRATIONS)):
        for stmt in _MIGRATIONS[i]:
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError as e:
                if "duplicate column" not in str(e).lower():
                    raise
        conn.execute(f"PRAGMA user_version = {i + 1}")
        conn.commit()


def prune_volatile_data(max_age_days: int | None = None) -> dict:
    if max_age_days is None:
        try:
            max_age_days = int(os.environ.get("PROXIMA_DATA_RETENTION_DAYS", "30"))
        except ValueError:
            max_age_days = 30
    if max_age_days <= 0:
        return {}  # retention disabled

    from datetime import timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_age_days)).isoformat()
    removed: dict[str, int] = {}
    conn = get_connection()
    try:
        for table in ("executions", "tool_usage", "token_usage"):
            cur = conn.execute(
                f"DELETE FROM {table} WHERE timestamp < ?", (cutoff,)
            )
            removed[table] = cur.rowcount
        conn.commit()
    finally:
        conn.close()
    return removed




def create_conversation(model: str = "", mode: str = "smart") -> str:
    conv_id = str(uuid.uuid4())
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at, model, mode, is_pinned, folder_name) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)",
            (conv_id, "New Conversation", now, now, model, mode),
        )
        conn.commit()
    return conv_id


def update_conversation_title(conv_id: str, title: str):
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (title[:100], _now(), conv_id),
        )
        conn.commit()


def set_pinned(conv_id: str, is_pinned: bool):
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET is_pinned = ?, updated_at = ? WHERE id = ?",
            (1 if is_pinned else 0, _now(), conv_id),
        )
        conn.commit()


def set_folder(conv_id: str, folder_name: str | None):
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET folder_name = ?, updated_at = ? WHERE id = ?",
            (folder_name, _now(), conv_id),
        )
        conn.commit()


def list_conversations(limit: int = 50) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_conversation(conv_id: str):
    with _conn() as conn:
        conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
        conn.commit()




def save_message(conv_id: str, role: str, content: str = None,
                 tool_call_id: str = None, metadata: dict = None):
    with _conn() as conn:
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, tool_call_id, timestamp, metadata) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (conv_id, role, content, tool_call_id, _now(),
             json.dumps(metadata) if metadata else None),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (_now(), conv_id),
        )
        conn.commit()


def get_messages(conv_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC",
            (conv_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def count_messages(conv_id: str) -> int:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?",
            (conv_id,),
        ).fetchone()
        return int(row["n"]) if row else 0
    finally:
        conn.close()




def save_execution(conv_id: str, code: str, description: str,
                   result: str, success: bool, duration_ms: int,
                   source: str = "", tool_name: str = ""):
    with _conn() as conn:
        conn.execute(
            "INSERT INTO executions (conversation_id, code, description, result, success, "
            "duration_ms, source, tool_name, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (conv_id, code, description, result, int(success),
             duration_ms, source, tool_name, _now()),
        )
        conn.commit()


def get_executions(conv_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM executions WHERE conversation_id = ? ORDER BY id ASC",
            (conv_id,),
        ).fetchall()
    return [dict(r) for r in rows]




def get_setting(key: str, default=None):
    with _conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (json.JSONDecodeError, TypeError):
        return row["value"]


def set_setting(key: str, value):
    with _conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, json.dumps(value)),
        )
        conn.commit()


def get_all_settings() -> dict:
    with _conn() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    result = {}
    for r in rows:
        try:
            result[r["key"]] = json.loads(r["value"])
        except (json.JSONDecodeError, TypeError):
            result[r["key"]] = r["value"]
    return result
