"""Proxima — Coding Tools.
Re-exports file operations, search operations, code intelligence, git operations, and repo intelligence.
"""
import sys as _sys


def _safe_star_import(_module_name):
    """Safe star import from module with error handling."""
    try:
        _mod = __import__(_module_name, fromlist=["*"])
    except ImportError as _e:
        print(f"⚠ coding: skipped '{_module_name}' ({_e})", file=_sys.stderr)
        return
    _names = getattr(_mod, "__all__", None)
    if _names is None:
        _names = [_n for _n in dir(_mod) if not _n.startswith("_")]
    _g = globals()
    for _n in _names:
        _g[_n] = getattr(_mod, _n)


_safe_star_import("proxima_agent.tools.coding.file_ops")
_safe_star_import("proxima_agent.tools.coding.search_ops")
_safe_star_import("proxima_agent.tools.coding.code_intel")
_safe_star_import("proxima_agent.tools.coding.git_ops")
_safe_star_import("proxima_agent.tools.coding.repo_intel")
