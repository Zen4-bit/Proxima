"""Proxima — Prompt Manager.
Manages system prompts depending on BYOK solo/multi-agent and Session modes.
"""

import logging

from .full_prompt import build_full_prompt
from .light_prompt import build_light_prompt

logger = logging.getLogger(__name__)


class PromptManager:
    """Routes system prompt retrieval based on conversation turn and mode."""

    def __init__(self, multi_agent: bool = False,
                 provider_info: dict = None,
                 byok_mode: bool = False):
        self._first_turn_sent = False
        self._multi_agent = multi_agent
        self._provider_info = provider_info or {}
        self._byok_mode = byok_mode

        self._prev_classification = None
        self._cached_prompt: str | None = None
        self._skill_store = None
        self._skill_retriever = None
        self._prev_skill_names: list[str] = []
        self._prev_skill_hints: str | None = None

    def get_prompt(self, bucket_context: str = "",
                   user_message: str = "",
                   config: dict | None = None) -> str:
        """Gets appropriate system prompt for the turn."""
        if not self._byok_mode:
            return self._get_session_prompt(user_message, config or {})

        if self._multi_agent and self._provider_info.get("peers"):
            return self._get_multi_prompt(bucket_context, user_message)
        return self._get_solo_prompt(bucket_context, user_message)

    def _get_solo_prompt(self, bucket_context: str,
                         user_message: str) -> str:
        """BYOK solo mode."""
        if not self._first_turn_sent:
            self._first_turn_sent = True
            return build_full_prompt(byok_mode=self._byok_mode)
        return build_light_prompt(bucket_context, user_message=user_message)

    def _get_multi_prompt(self, bucket_context: str,
                          user_message: str) -> str:
        """Gets prompts for BYOK multi-agent mode."""
        from ..multi_agent.prompt_full import build_multi_full_prompt
        from ..multi_agent.prompt_light import build_multi_light_prompt

        if not self._first_turn_sent:
            self._first_turn_sent = True
            return build_multi_full_prompt(self._provider_info)
        return build_multi_light_prompt(
            bucket_context,
            user_message=user_message,
            provider_info=self._provider_info,
        )

    def _get_session_prompt(self, user_message: str,
                             config: dict) -> str:
        """Processes and returns session mode system prompt."""
        from .dynamic_session_prompt import (
            classify_sync,
            build_session_prompt,
        )
        from .skills import (
            SkillStore, SkillRetriever, format_skill_hints,
            log_classification,
        )

        if self._skill_store is None:
            self._skill_store = SkillStore()
            self._skill_retriever = SkillRetriever(self._skill_store)

        classification = classify_sync(config, user_message)

        # Retrieve skills only for task-bearing turns.
        if classification.confidence_tier in ("full", "medium"):
            matched_skills = self._skill_retriever.keyword_search(
                capabilities=classification.capabilities,
                workflow=classification.workflow,
                user_message=user_message,
            )
        else:
            matched_skills = []
        skill_hints = format_skill_hints(matched_skills)
        skill_names = [s.name for s in matched_skills]

        needs_rebuild = self._needs_rebuild(classification, skill_hints)

        if needs_rebuild or self._cached_prompt is None:
            prompt = build_session_prompt(classification, skill_hints)
            self._cached_prompt = prompt
            self._prev_classification = classification
            self._prev_skill_names = skill_names
            self._prev_skill_hints = skill_hints
        else:
            prompt = self._cached_prompt

        try:
            log_classification(
                user_message=user_message,
                classification=classification.to_dict(),
                prompt_tier=classification.confidence_tier,
                prompt_rebuilt=needs_rebuild,
                skills_injected=skill_names,
            )
        except Exception:
            pass

        self._first_turn_sent = True
        return prompt

    def _needs_rebuild(self, classification, skill_hints: str) -> bool:
        """Checks if prompt cached version needs rebuilding."""
        if self._prev_classification is None:
            return True

        prev = self._prev_classification
        prev_hints = getattr(self, "_prev_skill_hints", None)

        return (
            classification.capabilities != prev.capabilities
            or classification.workflow != prev.workflow
            or skill_hints != prev_hints
            or classification.confidence_tier != prev.confidence_tier
        )

    def update_provider_info(self, provider_info: dict):
        """Updates available providers."""
        self._provider_info = provider_info

    @property
    def is_first_turn(self) -> bool:
        """True if next prompt will be the first-turn prompt."""
        return not self._first_turn_sent

    @property
    def is_multi_agent(self) -> bool:
        """True if operating in multi-agent mode."""
        return self._multi_agent

    def reset(self):
        """Resets PromptManager state for a new conversation."""
        self._first_turn_sent = False
        self._prev_classification = None
        self._cached_prompt = None
        self._prev_skill_names = []
        self._prev_skill_hints = None
        try:
            from .skills import clear_failure_tracker
            clear_failure_tracker()
        except ImportError:
            pass
