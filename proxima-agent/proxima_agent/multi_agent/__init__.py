"""Proxima — Multi-Agent Orchestration."""

from .peers import peers, configure as configure_peers, disable as disable_peers, drain_responses, has_pending
from .prompt_full import build_multi_full_prompt
from .prompt_light import build_multi_light_prompt

__all__ = [
    "peers",
    "configure_peers",
    "disable_peers",
    "drain_responses",
    "has_pending",
    "build_multi_full_prompt",
    "build_multi_light_prompt",
]
