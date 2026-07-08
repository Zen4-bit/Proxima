"""Proxima — Recall Subsystem.
Orchestrates conversation session vaulting, context compaction, and insight retrieval.
"""
from __future__ import annotations

from typing import Optional


class RecallEngine:
    """Unified interface to all recall subsystems."""

    def __init__(self):
        self._vault = None
        self._insights = None
        self._session_id: Optional[str] = None
        self._flush_idx: int = 0

    @property
    def vault(self):
        """Lazy-loads ConversationVault on first access."""
        if self._vault is None:
            from .vault import ConversationVault
            self._vault = ConversationVault()
        return self._vault

    @property
    def insights(self):
        """Lazy-loads InsightStore on first access."""
        if self._insights is None:
            from .insights import InsightStore
            self._insights = InsightStore()
        return self._insights

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    def start_session(self, model: str = "", title: str = "") -> Optional[str]:
        """Creates a new vault session."""
        sid = self.vault.create_session(model=model, title=title)
        self._session_id = sid
        self._flush_idx = 0
        return sid

    def end_session(self, reason: str = "user_exit") -> None:
        """Marks current session as ended in the vault."""
        if self._session_id:
            self.vault.end_session(self._session_id, reason)
        self._session_id = None
        self._flush_idx = 0

    def load_session(self, session_id: str) -> list[dict]:
        """Loads messages from a past session including ancestors."""
        self._session_id = session_id
        msgs = self.vault.get_messages(session_id, include_ancestors=True)
        self._flush_idx = len(msgs)
        return msgs

    def flush_new_messages(self, messages: list[dict]) -> int:
        """Flushes newly added messages to the vault."""
        if not self._session_id:
            return 0
        new = messages[self._flush_idx:]
        if not new:
            return 0
        count = self.vault.append_messages_batch(self._session_id, new)
        self._flush_idx += count
        return count

    def compact_if_needed(self, messages: list[dict], client, config: dict) -> None:
        """Runs context compaction if context gets large."""
        from .compactor import maybe_compact
        new_sid = maybe_compact(
            messages, self.vault, self._session_id, client, config
        )
        if new_sid:
            self._session_id = new_sid
            self._flush_idx = len(messages)

    def get_insights_for_prompt(self, user_message: str = "") -> str:
        """Returns relevant cross-session insights formatted for system prompt."""
        try:
            return self.insights.get_relevant(user_message)
        except Exception:
            return ""

    def extract_insights_from_conversation(
        self, messages: list[dict], client, config: dict
    ) -> int:
        """Extracts and persists insights from conversation history."""
        try:
            return self.insights.extract_and_save(
                messages, self._session_id, client, config
            )
        except Exception:
            return 0

    def reset(self) -> None:
        """Resets RecallEngine session state."""
        self.end_session(reason="user_reset")
        self._vault = None
        self._insights = None
