"""Proxima — Tool Registry.
Central metadata catalog and discovery engine for all agent tools.
"""
from __future__ import annotations

from typing import Optional

TOOL_REGISTRY: dict[str, dict] = {
    "browser": {
        "module": "proxima_agent.tools.browser_cdp",
        "class": "ChromeBrowser",
        "functions": [],
        "key_methods": [
            "goto", "click_text", "write_text", "click", "elements",
            "screenshot", "read_content", "extract_records",
            "dump_interactive_elements", "run_js", "wait_for",
            "press", "hotkey", "scroll_down", "tabs",
        ],
        "description": "CDP browser control with persistent logins",
        "works_in": ["session", "byok"],
        "cost": "medium",
        "side_effects": "network",
        "parallel_safe": [],
    },
    "desktop": {
        "module": "proxima_agent.tools.desktop",
        "class": "Desktop",
        "functions": [],
        "key_methods": [
            "windows", "connect", "click", "write_text",
            "elements", "screenshot", "click_menu",
        ],
        "description": "Desktop app control via accessibility APIs (pywinauto/Atspi/AppleScript)",
        "works_in": ["session", "byok"],
        "cost": "cheap",
        "side_effects": "none",
        "parallel_safe": [],
    },
    "computer": {
        "module": "proxima_agent.tools.computer",
        "instance": "computer",
        "class": None,
        "functions": [],
        "key_methods": [
            "smart_click", "smart_write", "find_element",
            "windows", "context", "active_window",
        ],
        "description": "Unified window-aware control with smart fallback chain (Direct → Parent → Coord → OCR)",
        "works_in": ["session", "byok"],
        "cost": "medium",
        "side_effects": "none",
        "parallel_safe": [],
    },
    "files": {
        "module": "proxima_agent.tools.coding.file_ops",
        "class": None,
        "functions": [
            "read_file", "read_file_raw", "write_file", "edit_file",
            "patch_file", "copy_file", "move_file", "append_file",
            "insert_lines", "delete_lines",
        ],
        "key_methods": [],
        "description": "File read/write/edit/copy/move operations",
        "works_in": ["session", "byok"],
        "cost": "cheap",
        "side_effects": "modifies_files",
        "parallel_safe": ["read_file", "read_file_raw"],
    },
    "search": {
        "module": "proxima_agent.tools.coding.search_ops",
        "class": None,
        "functions": [
            "search_text", "grep", "dir_tree", "tree",
            "find_replace", "glob_files", "find_files",
            "file_stats", "list_dir",
        ],
        "key_methods": [],
        "description": "Text search, file discovery, directory traversal",
        "works_in": ["session", "byok"],
        "cost": "cheap",
        "side_effects": "none",
        "parallel_safe": ["search_text", "grep", "dir_tree", "tree", "glob_files", "find_files", "file_stats", "list_dir"],
    },
    "code": {
        "module": "proxima_agent.tools.coding.code_intel",
        "class": None,
        "functions": [
            "lint", "syntax_check", "find_functions",
            "validate_project", "diff_files", "get_imports",
        ],
        "key_methods": [],
        "description": "Static analysis, linting, code inspection",
        "works_in": ["session", "byok"],
        "cost": "medium",
        "side_effects": "none",
        "parallel_safe": ["lint", "syntax_check", "find_functions", "validate_project", "diff_files", "get_imports"],
    },
    "repo_intel": {
        "module": "proxima_agent.tools.coding.repo_intel",
        "class": None,
        "functions": [
            "repo_status", "repo_health", "analyze_project",
            "find_definition", "find_references", "get_impacted_files",
            "get_impacted_tests", "find_callers", "find_implementations",
            "rename_symbol", "compress_context", "autonomous_repair_loop"
        ],
        "key_methods": [],
        "description": "Repository intelligence and semantic code navigation",
        "works_in": ["session", "byok"],
        "cost": "medium",
        "side_effects": "modifies_files",
        "parallel_safe": ["repo_status", "repo_health", "analyze_project", "find_definition", "find_references", "get_impacted_files", "get_impacted_tests", "find_callers", "find_implementations", "compress_context"],
    },
    "git": {
        "module": "proxima_agent.tools.coding.git_ops",
        "class": None,
        "functions": [
            "git_status", "git_diff", "git_log",
            "git_commit", "git_branch", "git_stash", "git_blame",
        ],
        "key_methods": [],
        "description": "Git version control operations",
        "works_in": ["session", "byok"],
        "cost": "cheap",
        "side_effects": "modifies_files",
        "parallel_safe": ["git_status", "git_diff", "git_log", "git_blame", "git_branch"],
    },
    "shell": {
        "module": "proxima_agent.tools.system.shell_ops",
        "class": None,
        "functions": [
            "run_shell", "powershell", "run_shell_bg", "native_shell",
        ],
        "key_methods": [],
        "description": "Shell command execution (sync, async, PowerShell)",
        "works_in": ["session", "byok"],
        "cost": "expensive",
        "side_effects": "destructive",
        "parallel_safe": [],
    },
    "network": {
        "module": "proxima_agent.tools.system.network_ops",
        "class": None,
        "functions": [
            "http_get", "http_post", "download",
        ],
        "key_methods": [],
        "description": "HTTP requests and file downloads",
        "works_in": ["session", "byok"],
        "cost": "medium",
        "side_effects": "network",
        "parallel_safe": ["http_get", "download"],
    },
    "ocr": {
        "module": "proxima_agent.tools.ocr",
        "class": None,
        "functions": [
            "read_screen", "read_region", "read_image",
            "find_text_on_screen",
        ],
        "key_methods": [],
        "description": "Screen/image text extraction (Windows OCR → Tesseract fallback)",
        "works_in": ["session", "byok"],
        "cost": "expensive",
        "side_effects": "none",
        "parallel_safe": ["read_screen", "read_region", "read_image", "find_text_on_screen"],
    },
    "utils": {
        "module": "proxima_agent.tools.utils",
        "class": None,
        "functions": [
            "screenshot", "workspace", "json_read", "json_write",
            "system_info", "env_get", "env_set",
        ],
        "key_methods": [],
        "description": "Screenshots, workspace paths, JSON I/O, environment vars",
        "works_in": ["session", "byok"],
        "cost": "cheap",
        "side_effects": "none",
        "parallel_safe": ["screenshot", "workspace", "json_read", "system_info", "env_get"],
    },
    "attach": {
        "module": "proxima_agent.tools.attach",
        "class": None,
        "functions": ["attach"],
        "key_methods": [],
        "description": "Queue files/images for model to read natively on next message",
        "works_in": ["session", "byok"],
        "cost": "cheap",
        "side_effects": "none",
        "parallel_safe": ["attach"],
    },
    "brain": {
        "module": "proxima_agent.recall.brain_ops",
        "class": None,
        "functions": [
            "remember", "forget", "memories",
            "learn_fix", "save_skill", "list_skills", "brain_stats",
        ],
        "key_methods": [],
        "description": "Persistent cross-session memory and experience learning",
        "works_in": ["byok"],
        "cost": "cheap",
        "side_effects": "modifies_files",
        "parallel_safe": ["memories", "list_skills", "brain_stats"],
    },
    "tool_docs": {
        "module": "proxima_agent.prompt.tool_docs",
        "class": None,
        "functions": ["fetch_help"],
        "key_methods": [],
        "description": "On-demand detailed API reference for any tool category",
        "works_in": ["session", "byok"],
        "cost": "cheap",
        "side_effects": "none",
        "parallel_safe": ["fetch_help"],
    },
    "verification": {
        "module": "proxima_agent.tools.verification",
        "class": None,
        "functions": ["verify"],
        "key_methods": [],
        "description": "Proof-based task verification: url_match, content_contains, file_exists, file_contains, element_exists, custom",
        "works_in": ["session", "byok"],
        "cost": "cheap",
        "side_effects": "none",
        "parallel_safe": ["verify"],
    },
}


def list_tools(mode: Optional[str] = None) -> list[str]:
    """Lists available tool categories, optionally filtered by mode."""
    if mode is None:
        return sorted(TOOL_REGISTRY.keys())
    return sorted(
        name for name, info in TOOL_REGISTRY.items()
        if mode in info["works_in"]
    )


def describe(category: str) -> dict:
    """Returns metadata for a specific tool category."""
    if category not in TOOL_REGISTRY:
        available = ", ".join(sorted(TOOL_REGISTRY.keys()))
        raise KeyError(
            f"Unknown tool category: '{category}'. "
            f"Available: {available}"
        )
    return TOOL_REGISTRY[category].copy()


def import_for(category: str) -> str:
    """Generates the python import statement for a tool category."""
    info = describe(category)
    module = info["module"]
    cls = info.get("class")
    instance = info.get("instance")
    functions = info.get("functions", [])

    parts = []
    if cls:
        parts.append(f"from {module} import {cls}")
    elif instance:
        parts.append(f"from {module} import {instance}")
    if functions:
        parts.append(f"from {module} import {', '.join(functions)}")
    return "\n".join(parts) if parts else f"import {module}"


def quick_ref(mode: Optional[str] = None) -> str:
    """Generates a compact quick-reference of tools for prompt injection."""
    lines = []
    for name in list_tools(mode):
        info = TOOL_REGISTRY[name]
        callables = []
        if info.get("class"):
            callables.append(info["class"])
        if info.get("instance"):
            callables.append(info["instance"])
        callables.extend(info.get("functions", []))
        display = callables[:6]
        suffix = f" +{len(callables) - 6} more" if len(callables) > 6 else ""
        lines.append(f"  {name:12s} {', '.join(display)}{suffix}")
    return "\n".join(lines)


def capabilities(mode: str) -> dict[str, dict]:
    """Returns all tools available for a specific mode."""
    return {
        name: info.copy()
        for name, info in TOOL_REGISTRY.items()
        if mode in info["works_in"]
    }


def cost_of(category: str) -> str:
    """Returns the cost classification of a tool category."""
    return describe(category)["cost"]


def side_effects_of(category: str) -> str:
    """Returns the side effects classification of a tool category."""
    return describe(category)["side_effects"]


def parallel_safe_set() -> frozenset[str]:
    """Returns the complete set of functions safe for parallel execution."""
    safe = set()
    for info in TOOL_REGISTRY.values():
        safe.update(info.get("parallel_safe", []))
    return frozenset(safe)
