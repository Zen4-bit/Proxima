"""Proxima — Dynamic Session Prompt.
Capability-driven system prompt assembly for session mode.
"""

import json
import logging
import os
import platform
import re
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_OS_LABEL = {
    "Windows": "Windows PC",
    "Darwin": "macOS",
}.get(platform.system(), "Linux")

_BLOCKS_DIR = Path(__file__).parent / "blocks"

_ALL_CAPABILITIES = frozenset({
    "browser", "desktop", "coding", "repo", "shell", "network", "ocr", "file",
})

_ALL_WORKFLOWS = frozenset({
    "bug_fix", "refactor", "browser_research", "desktop_automation", "general",
})

# Classifier timeout in seconds.
_CLASSIFIER_TIMEOUT_S = 2.0

# Min keyword hits to confidently identify a workflow.
_WORKFLOW_CONFIDENT_HITS = 2

_CORE_PROMPT = f"""\
You are Proxima Agent, running on the user's {_OS_LABEL}.
You execute Python code on this machine to complete tasks.
Environment is persistent. Variables and imports survive across turns.
Be honest. Prove success with a real check — never guess:
  from proxima_agent.tools.verification import verify
  verify(type="file_exists"|"file_contains"|"url_match"|"content_contains"|"element_exists"|"custom", ...)
Output is captured from stdout via print().

Additional capabilities can be discovered:
  list_tools()
  describe_tool("category")"""

_DISCOVERY_FOOTER = """\
TOOL DISCOVERY:
  list_tools()              → All available tool categories
  describe_tool("browser")  → Full API reference for a category
  describe_tool("desktop")  → Desktop automation API
  Always available. Use when you need tools not listed above."""


class ClassificationResult:

    __slots__ = (
        "capabilities", "workflow", "confidence",
        "suggested_context", "reasoning",
    )

    def __init__(
        self,
        capabilities: list[str] | None = None,
        workflow: str = "general",
        confidence: float = 0.5,
        suggested_context: list[str] | None = None,
        reasoning: str = "",
    ):
        raw_caps = capabilities or []
        self.capabilities = sorted(
            c for c in raw_caps if c in _ALL_CAPABILITIES
        )
        self.workflow = workflow if workflow in _ALL_WORKFLOWS else "general"
        self.confidence = max(0.0, min(1.0, confidence))
        self.suggested_context = suggested_context or []
        self.reasoning = reasoning

    @property
    def confidence_tier(self) -> str:
        if self.confidence >= 0.6:
            return "full"
        if self.confidence >= 0.3:
            return "medium"
        return "minimal"

    def __eq__(self, other):
        if not isinstance(other, ClassificationResult):
            return NotImplemented
        return (
            self.capabilities == other.capabilities
            and self.workflow == other.workflow
            and self.confidence_tier == other.confidence_tier
        )

    def to_dict(self) -> dict:
        return {
            "capabilities": self.capabilities,
            "workflow": self.workflow,
            "confidence": self.confidence,
            "suggested_context": self.suggested_context,
            "reasoning": self.reasoning,
        }


# Regex fallback (Tier 2): reuses the keyword patterns from light_prompt.py but
# maps to the capability taxonomy used by the dynamic system.
_KEYWORD_MAP: dict[str, set[str]] = {
    "browser": {
        "browser", "website", "web", "open", "go to", "goto", "url",
        "chrome", "page", "search", "login", "gmail", "youtube", "google",
        "click", "navigate", "download", "link", "tab", "scroll",
        "form", "fill", "submit", "sign in", "sign up",
        "twitter", "facebook", "reddit", "amazon", "linkedin",
    },
    "desktop": {
        "notepad", "app", "window", "desktop", "application", "click button",
        "menu", "file manager", "calculator", "word", "excel", "paint",
        "ui", "interface", "type in", "dialog", "settings",
        "sap", "outlook", "teams", "figma",
    },
    "coding": {
        "code", "function", "class", "variable", "import", "module",
        "python", "javascript", "typescript", "react", "vue", "angular",
        "syntax", "error", "exception", "debug", "test", "lint",
        "refactor", "rename", "definition", "reference",
    },
    "repo": {
        "git", "commit", "branch", "merge", "pull", "push", "diff",
        "repository", "repo", "status", "log", "stash", "rebase",
        "callers", "implementations", "symbol", "definition", "references",
    },
    "shell": {
        "command", "terminal", "run", "install", "pip", "npm",
        "subprocess", "powershell", "cmd", "script", "process",
        "compile", "build", "package", "docker", "make",
    },
    "network": {
        "http", "api", "request", "fetch", "download", "upload",
        "server", "port", "socket", "curl", "webhook",
    },
    "ocr": {
        "screenshot", "screen", "capture", "see", "look", "ocr",
        "what's on", "show me", "visual",
    },
    "file": {
        "file", "folder", "create", "write", "read", "save", "path",
        "directory", "copy", "move", "rename", "delete", "csv", "json",
        "txt", "pdf", "edit", "content",
    },
}

_WORKFLOW_KEYWORDS: dict[str, set[str]] = {
    "bug_fix": {
        "bug", "fix", "broken", "error", "crash", "fail", "issue",
        "not working", "wrong", "incorrect", "debug", "repair",
    },
    "refactor": {
        "refactor", "clean up", "reorganize", "restructure", "simplify",
        "extract", "move", "split", "consolidate", "improve",
    },
    "browser_research": {
        "search for", "find on", "look up", "research", "check website",
        "go to site", "open url", "browse",
    },
    "desktop_automation": {
        "open app", "click button", "fill form", "automate",
        "type in", "application", "ui", "notepad", "excel", "word",
    },
}


def _fallback_extract_capabilities(user_message: str) -> ClassificationResult:
    """Regex/keyword-based capability extraction fallback."""
    msg_lower = user_message.lower()

    def _matches(kw: str) -> bool:
        # Word-boundary match to prevent substring false-positives.
        return re.search(r"\b" + re.escape(kw) + r"\b", msg_lower) is not None

    detected_caps = []
    for cap, keywords in _KEYWORD_MAP.items():
        if any(_matches(kw) for kw in keywords):
            detected_caps.append(cap)

    detected_workflow = "general"
    best_wf_score = 0
    for wf, keywords in _WORKFLOW_KEYWORDS.items():
        score = sum(1 for kw in keywords if _matches(kw))
        if score > best_wf_score:
            best_wf_score = score
            detected_workflow = wf

    # Confidence score based on detection completeness to set the tier.
    if not detected_caps:
        confidence = 0.2
    elif detected_workflow != "general" and best_wf_score >= _WORKFLOW_CONFIDENT_HITS:
        confidence = 0.7
    else:
        confidence = 0.5

    return ClassificationResult(
        capabilities=detected_caps,
        workflow=detected_workflow,
        confidence=confidence,
        reasoning="fallback:regex",
    )


# Classifier cache (Tier 3): successful classifications keyed by normalized
# message, so repeated classifier failures can't block the agent.
_classification_cache: dict[str, ClassificationResult] = {}
_CACHE_MAX_SIZE = 200


def _cache_key(message: str) -> str:
    import hashlib
    norm = re.sub(r"\s+", " ", message.lower().strip())
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()


def _cache_put(message: str, result: ClassificationResult) -> None:
    if len(_classification_cache) >= _CACHE_MAX_SIZE:
        # Evict oldest entries (simple FIFO — dict preserves insertion order)
        keys = list(_classification_cache.keys())
        for k in keys[: _CACHE_MAX_SIZE // 4]:
            _classification_cache.pop(k, None)
    _classification_cache[_cache_key(message)] = result


def _cache_get(message: str) -> ClassificationResult | None:
    return _classification_cache.get(_cache_key(message))


def refine_classification_cache(message: str, actual_capabilities) -> bool:
    """Self-corrects the cache by merging actually exercised capabilities for repeat identical messages."""
    cached = _cache_get(message)
    if cached is None:
        return False
    extra = {c for c in (actual_capabilities or []) if c in _ALL_CAPABILITIES}
    merged = sorted(set(cached.capabilities) | extra)
    if merged == cached.capabilities:
        return False
    _cache_put(message, ClassificationResult(
        capabilities=merged,
        workflow=cached.workflow,
        # Real usage guarantees at least medium tier.
        confidence=max(cached.confidence, 0.5),
        suggested_context=cached.suggested_context,
        reasoning="telemetry-refined",
    ))
    return True


_CLASSIFIER_PROMPT = """\
Classify the user's request.

Available capabilities: browser, desktop, coding, repo, shell, network, ocr, file
Available workflows: bug_fix, refactor, browser_research, desktop_automation, general

Return JSON only:
{"capabilities": [...], "workflow": "...", "confidence": 0.0-1.0, "suggested_context": [...], "reasoning": "..."}"""


def classify_sync(config: dict,
                  user_message: str) -> ClassificationResult:
    """Classifies user messages (cache -> regex -> LLM fallback) to avoid per-turn LLM call latency."""
    # Tier 0: cache
    cached = _cache_get(user_message)
    if cached is not None:
        return cached

    # Tier 1: regex keywords
    regex_result = _fallback_extract_capabilities(user_message)
    if regex_result.capabilities:
        _cache_put(user_message, regex_result)
        return regex_result

    # Tier 2: LLM fallback
    if config.get("classifier_llm_fallback", False):
        llm_result = _llm_classify(config, user_message)
        if llm_result is not None:
            _cache_put(user_message, llm_result)
            return llm_result

    # Tier 3: minimal fallback
    _cache_put(user_message, regex_result)
    return regex_result


def _llm_classify(config: dict, user_message: str) -> ClassificationResult | None:
    try:
        import urllib.request
        import urllib.error

        api_url = config.get("api_url", "http://127.0.0.1:3210/v1")
        api_key = config.get("api_key", "")

        url = f"{api_url.rstrip('/')}/chat/completions"
        messages = [
            {"role": "system", "content": _CLASSIFIER_PROMPT},
            {"role": "user", "content": user_message},
        ]
        payload = json.dumps({
            "model": config.get("model", "auto"),
            "messages": messages,
            "max_tokens": 150,
            "temperature": 0.0,
        }).encode()

        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}" if api_key else "",
            },
            method="POST",
        )

        resp = urllib.request.urlopen(req, timeout=_CLASSIFIER_TIMEOUT_S)
        body = json.loads(resp.read().decode())

        content = body["choices"][0]["message"]["content"].strip()
        if content.startswith("```"):
            content = re.sub(r"^```(?:json)?\s*", "", content)
            content = re.sub(r"\s*```$", "", content)

        parsed = json.loads(content)
        return ClassificationResult(
            capabilities=parsed.get("capabilities", []),
            workflow=parsed.get("workflow", "general"),
            confidence=float(parsed.get("confidence", 0.5)),
            suggested_context=parsed.get("suggested_context", []),
            reasoning=parsed.get("reasoning", ""),
        )
    except Exception as e:
        logger.debug("LLM classification failed: %s", e)
        return None


# Prompt block loader: external .txt files with an mtime-based hot-reload cache.
_block_cache: dict[str, tuple[float, str]] = {}


def _load_block(category: str, block_type: str) -> str:
    block_path = _BLOCKS_DIR / block_type / f"{category}.txt"
    path_str = str(block_path)

    try:
        mtime = block_path.stat().st_mtime
    except OSError:
        return ""  # File missing — silent fallback

    cached = _block_cache.get(path_str)
    if cached and cached[0] == mtime:
        return cached[1]

    try:
        content = block_path.read_text(encoding="utf-8").strip()
        _block_cache[path_str] = (mtime, content)
        return content
    except OSError:
        return ""


def build_session_prompt(
    classification: ClassificationResult,
    skill_hints: str = "",
) -> str:
    parts = [_CORE_PROMPT]
    tier = classification.confidence_tier

    if tier in ("full", "medium"):
        # Inject capability API blocks.
        for cap in classification.capabilities:
            block = _load_block(cap, "capabilities")
            if block:
                parts.append(block)

    if tier == "full":
        # Full tier additionally includes the workflow guide.
        wf_block = _load_block(classification.workflow, "workflows")
        if wf_block:
            parts.append(wf_block)

    # Render skill hints if provided, independent of confidence tier.
    if skill_hints:
        parts.append(skill_hints)

    # Minimal tier (<0.3, no capability detected): core + discovery only.

    # Discovery footer is always present, regardless of tier.
    parts.append(_DISCOVERY_FOOTER)

    parts.append(
        "RULES: print() for output | NOT every message is a task — if the user is "
        "just chatting, reply in plain text, do NOT run code | continue from current "
        "state, never restart | on failure, diagnose then try DIFFERENT approach | "
        "one field = one targeted write_text (never Tab between fields)"
    )

    return "\n\n".join(parts)


# Tool discovery functions injected into the worker namespace so the agent can
# always self-discover available tools.
_TOOL_REGISTRY = {
    "browser": {
        "import": "from proxima_agent.tools.browser_cdp import ChromeBrowser",
        "description": "Web browser automation via Chrome DevTools Protocol",
        "key_methods": ["goto", "click_text", "write_text", "read_content",
                        "extract_records", "screenshot", "elements", "tabs"],
    },
    "desktop": {
        "import": "from proxima_agent.tools.desktop import Desktop",
        "description": "Desktop application automation (Windows/macOS/Linux)",
        "key_methods": ["connect", "click", "write_text", "elements",
                        "windows", "screenshot", "click_menu"],
    },
    "coding": {
        "import": "from proxima_agent.tools.code_env import *",
        "description": "File I/O, search, lint, syntax check, git operations",
        "key_methods": ["read_file", "write_file", "grep", "find_files",
                        "lint", "syntax_check", "git_status", "git_diff"],
    },
    "repo": {
        "import": "from proxima_agent.tools.coding.repo_intel import get_repo_index",
        "description": "Repository intelligence — definitions, references, callers, rename",
        "key_methods": ["find_definition", "find_references", "find_callers",
                        "find_implementations", "rename_symbol", "compress_context"],
    },
    "shell": {
        "import": "from proxima_agent.tools.code_env import shell",
        "description": "System shell commands, process management",
        "key_methods": ["shell", "subprocess.run", "subprocess.Popen"],
    },
    "network": {
        "import": "import urllib.request",
        "description": "HTTP requests, downloads, API calls",
        "key_methods": ["urlopen", "urlretrieve", "Request"],
    },
    "ocr": {
        "import": "from proxima_agent.tools.ocr import read_screen, find_text_on_screen, click_text",
        "description": "On-screen text reading via OCR (use utils.screenshot for capture)",
        "key_methods": ["read_screen", "find_text_on_screen", "click_text"],
    },
    "file": {
        "import": "from proxima_agent.tools.code_env import read_file, write_file",
        "description": "File and directory operations",
        "key_methods": ["read_file", "write_file", "grep", "find_files",
                        "os.listdir", "os.makedirs"],
    },
}


def list_tools() -> str:
    lines = ["Available tool categories:\n"]
    for name, info in sorted(_TOOL_REGISTRY.items()):
        methods = ", ".join(info["key_methods"][:4])
        lines.append(f"  {name:10s} — {info['description']}")
        lines.append(f"             import: {info['import']}")
        lines.append(f"             key: {methods}")
        lines.append("")
    lines.append("Use describe_tool('category') for full API reference.")
    return "\n".join(lines)


def describe_tool(category: str) -> str:
    cat = category.lower().strip()

    _aliases = {
        "chrome": "browser", "web": "browser", "chromebrowser": "browser",
        "app": "desktop", "window": "desktop", "ui": "desktop",
        "code": "coding", "files": "file", "terminal": "shell",
        "cmd": "shell", "screen": "ocr", "git": "repo",
        "http": "network", "api": "network",
    }
    cat = _aliases.get(cat, cat)

    minimal = _load_block(cat, "capabilities")
    detailed = _load_block(cat, "detailed")

    if minimal:
        info = _TOOL_REGISTRY.get(cat, {})
        imp = info.get("import", "")
        header = f"=== {cat.upper()} ===\nImport: {imp}\n\n" if imp else ""
        
        doc = header + minimal
        if detailed:
            doc += f"\n\n{detailed}"
        return doc

    available = ", ".join(sorted(_TOOL_REGISTRY.keys()))
    return f"Unknown category '{category}'. Available: {available}"
