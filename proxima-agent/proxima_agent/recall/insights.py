"""Proxima — Insight Store.
Extracts, updates, and retrieves cross-session user preferences and workspace facts.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from typing import Optional

try:
    from ..config import MEMORY_DB_PATH
    _BASE_DIR = os.path.dirname(MEMORY_DB_PATH)
except Exception:
    _BASE_DIR = os.path.join(os.path.expanduser("~"), ".proxima-agent")

INSIGHTS_DB_PATH = os.path.join(_BASE_DIR, "insights.db")

_MAX_INSIGHTS = 200
_RETRIEVE_LIMIT = 8
_TRANSCRIPT_CAP = 3000


def _connect() -> Optional[sqlite3.Connection]:
    """Opens insights database and initializes schema."""
    conn = None
    try:
        os.makedirs(os.path.dirname(INSIGHTS_DB_PATH), exist_ok=True)
        conn = sqlite3.connect(INSIGHTS_DB_PATH, timeout=5.0)
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
CREATE TABLE IF NOT EXISTS insights (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category        TEXT NOT NULL,
    key             TEXT NOT NULL,
    value           TEXT NOT NULL,
    confidence      REAL DEFAULT 0.8,
    hits            INTEGER DEFAULT 1,
    source_session  TEXT,
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_insight_catkey
    ON insights(category, key);
"""


def _safe_close(conn: Optional[sqlite3.Connection]) -> None:
    try:
        if conn:
            conn.close()
    except Exception:
        pass


class InsightStore:
    """Cross-session fact memory backed by local SQLite."""

    def extract_and_save(
        self,
        messages: list[dict],
        session_id: Optional[str],
        client,
        config: dict,
    ) -> int:
        """Extracts and saves facts from a conversation."""
        if not config.get("insights_enabled", True):
            return 0

        transcript = self._build_transcript(messages)
        if not transcript or len(transcript) < 50:
            return 0

        facts = self._llm_extract(transcript, client, config)
        if not facts:
            return 0

        return self._save_facts(facts, session_id)

    def get_relevant(
        self, query: str = "", limit: int = _RETRIEVE_LIMIT
    ) -> str:
        """Retrieves stored insights relevant to the query."""
        conn = _connect()
        if not conn:
            return ""
        try:
            rows = conn.execute(
                "SELECT category, key, value, hits FROM insights "
                "ORDER BY hits DESC, updated_at DESC"
            ).fetchall()

            if not rows:
                return ""

            query_words = {
                w for w in re.findall(r"\w+", (query or "").lower()) if len(w) > 2
            }

            if query_words:
                def _relevance(row) -> int:
                    haystack = (
                        f"{row['key']} {row['value']} {row['category']}".lower()
                    )
                    return sum(1 for w in query_words if w in haystack)

                selected = sorted(
                    rows, key=lambda r: (_relevance(r), r["hits"]), reverse=True
                )[:limit]
            else:
                selected = rows[:limit]

            return self._format_for_prompt(
                [{"category": r["category"], "key": r["key"], "value": r["value"]}
                 for r in selected]
            )
        except Exception:
            return ""
        finally:
            _safe_close(conn)

    def list_all(self) -> list[dict]:
        """Lists all stored insights."""
        conn = _connect()
        if not conn:
            return []
        try:
            rows = conn.execute(
                "SELECT category, key, value, hits, confidence "
                "FROM insights ORDER BY category, hits DESC"
            ).fetchall()
            return [dict(r) for r in rows]
        except Exception:
            return []
        finally:
            _safe_close(conn)

    def clear(self) -> bool:
        """Deletes all insights from database."""
        conn = _connect()
        if not conn:
            return False
        try:
            conn.execute("DELETE FROM insights")
            conn.commit()
            return True
        except Exception:
            return False
        finally:
            _safe_close(conn)

    def _build_transcript(self, messages: list[dict]) -> str:
        """Constructs a compact transcript of user-assistant turns."""
        parts: list[str] = []
        char_count = 0
        for msg in messages:
            role = msg.get("role", "")
            if role not in ("user", "assistant"):
                continue
            content = msg.get("content", "")
            if not content:
                continue
            snippet = content[:400]
            part = f"{role}: {snippet}"
            if char_count + len(part) > _TRANSCRIPT_CAP:
                break
            parts.append(part)
            char_count += len(part)
        return "\n".join(parts)

    def _llm_extract(
        self, transcript: str, client, config: dict
    ) -> list[dict]:
        """Extracts lasting facts from conversation transcript via LLM."""
        try:
            response = client.chat.completions.create(
                model=config.get("model", "auto"),
                messages=[
                    {
                        "role": "user",
                        "content": (
                            "From this conversation, extract lasting facts about the user "
                            "and their environment that would be useful in FUTURE conversations.\n\n"
                            "Categories:\n"
                            "- user_pref: language preference, communication style, habits\n"
                            "- workspace: tech stack, project type, tools used\n"
                            "- pattern: recurring approaches that work for this user\n\n"
                            "Return ONLY a JSON array. Each item: "
                            '{"category": "...", "key": "...", "value": "..."}\n'
                            "Only include STABLE facts (won't change next conversation).\n"
                            "Return [] if no lasting facts found.\n\n"
                            f"{transcript}"
                        ),
                    }
                ],
                temperature=0.1,
                max_tokens=400,
            )
            raw = (response.choices[0].message.content or "").strip()

            if "```" in raw:
                m = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?\s*```", raw)
                if m:
                    raw = m.group(1).strip()

            facts = json.loads(raw)
            if not isinstance(facts, list):
                return []

            valid: list[dict] = []
            for f in facts:
                if (
                    isinstance(f, dict)
                    and f.get("category")
                    and f.get("key")
                    and f.get("value")
                ):
                    valid.append(f)
            return valid[:20]

        except Exception:
            return []

    def _save_facts(
        self, facts: list[dict], session_id: Optional[str]
    ) -> int:
        """Upserts extracted facts to insights database."""
        conn = _connect()
        if not conn:
            return 0
        try:
            count = 0
            now = time.time()
            for fact in facts:
                cat = str(fact["category"])[:30]
                key = str(fact["key"])[:80]
                value = str(fact["value"])[:500]

                existing = conn.execute(
                    "SELECT id FROM insights WHERE category=? AND key=?",
                    (cat, key),
                ).fetchone()

                if existing:
                    conn.execute(
                        "UPDATE insights SET value=?, hits=hits+1, "
                        "updated_at=?, source_session=? WHERE id=?",
                        (value, now, session_id, existing["id"]),
                    )
                else:
                    conn.execute(
                        "INSERT INTO insights "
                        "(category, key, value, confidence, hits, "
                        "source_session, created_at, updated_at) "
                        "VALUES (?,?,?,?,?,?,?,?)",
                        (cat, key, value, 0.8, 1, session_id, now, now),
                    )
                count += 1

            conn.commit()
            self._prune(conn)
            return count
        except Exception:
            return 0
        finally:
            _safe_close(conn)

    def _prune(self, conn: sqlite3.Connection) -> None:
        """Prunes oldest, least-hit insights when capacity is exceeded."""
        try:
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM insights"
            ).fetchone()["c"]
            if total <= _MAX_INSIGHTS:
                return
            overflow = total - _MAX_INSIGHTS
            conn.execute(
                "DELETE FROM insights WHERE id IN ("
                "  SELECT id FROM insights "
                "  ORDER BY hits ASC, updated_at ASC LIMIT ?"
                ")",
                (overflow,),
            )
            conn.commit()
        except Exception:
            pass

    def _format_for_prompt(self, insights: list[dict]) -> str:
        """Formats insights into a injectable prompt block."""
        if not insights:
            return ""

        _cat_labels = {
            "user_pref": "Preferences",
            "workspace": "Workspace",
            "pattern": "Patterns",
        }

        by_cat: dict[str, list[dict]] = {}
        for ins in insights:
            cat = ins.get("category", "other")
            by_cat.setdefault(cat, []).append(ins)

        lines = ["[USER CONTEXT — from past interactions]"]
        for cat, items in by_cat.items():
            label = _cat_labels.get(cat, cat.replace("_", " ").title())
            lines.append(f"  {label}:")
            for item in items:
                lines.append(f"    • {item['key']}: {item['value']}")

        return "\n".join(lines)
