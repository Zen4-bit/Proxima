"""Proxima — Full Coding Environment.
Convenience module that re-exports active tools, system, and utility functions.
"""

import sys as _sys


def _safe_star_import(_module_name):
    """Performs a star import from a module with error suppression."""
    try:
        _mod = __import__(_module_name, fromlist=["*"])
    except Exception as _e:
        print(f"⚠ code_env: skipped '{_module_name}' ({type(_e).__name__}: {_e})", file=_sys.stderr)
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

_safe_star_import("proxima_agent.tools.system.shell_ops")
_safe_star_import("proxima_agent.tools.system.network_ops")

_safe_star_import("proxima_agent.tools.utils")

_safe_star_import("proxima_agent.tools.attach")

import os as _os
if _os.environ.get("PROXIMA_BYOK_MODE") == "1":
    _safe_star_import("proxima_agent.recall.brain_ops")

_safe_star_import("proxima_agent.tools.tool_docs")

try:
    from proxima_agent.tools.computer import computer
except ImportError as _e:
    print(f"⚠ code_env: skipped 'computer' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.registry import (
        import_for, quick_ref, capabilities, cost_of, side_effects_of,
    )
    from proxima_agent.tools.registry import describe as describe_tool_meta
except ImportError as _e:
    print(f"⚠ code_env: skipped 'registry' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.prompt.dynamic_session_prompt import list_tools, describe_tool
except ImportError as _e:
    print(f"⚠ code_env: skipped 'discovery' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.health import tools_health, invalidate_cache
except ImportError as _e:
    print(f"⚠ code_env: skipped 'health' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.recall.strategies import strategies
except ImportError as _e:
    print(f"⚠ code_env: skipped 'strategies' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.parallel import parallel, ParallelBatch
except ImportError as _e:
    print(f"⚠ code_env: skipped 'parallel' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.replay import recorder
except ImportError as _e:
    print(f"⚠ code_env: skipped 'replay' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.snapshots import snapshots
except ImportError as _e:
    print(f"⚠ code_env: skipped 'snapshots' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.analytics import analytics, classify_failure
except ImportError as _e:
    print(f"⚠ code_env: skipped 'analytics' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.retry import retry_engine
except ImportError as _e:
    print(f"⚠ code_env: skipped 'retry' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.learned_fixes import learned_fixes
except ImportError as _e:
    print(f"⚠ code_env: skipped 'learned_fixes' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.trace_viewer import generate_trace
except ImportError as _e:
    print(f"⚠ code_env: skipped 'trace_viewer' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.self_heal import healer
except ImportError as _e:
    print(f"⚠ code_env: skipped 'self_heal' ({_e})", file=_sys.stderr)

try:
    from proxima_agent.tools.verification import verify
except ImportError as _e:
    print(f"⚠ code_env: skipped 'verification' ({_e})", file=_sys.stderr)


def env_state():
    """Returns status of current on-screen window environment."""
    try:
        from proxima_agent.tools.computer.window_manager import (
            enumerate_windows, get_active_window,
        )
        windows = enumerate_windows()
        active = get_active_window()
        lines = []
        if active:
            lines.append(f"Focused: {active.get('title', '(unknown)')}")
        if windows:
            lines.append(f"Open windows ({len(windows)}):")
            for w in windows[:15]:
                title = w.get("title", "")
                app = w.get("app", "") or w.get("class_name", "")
                label = f"  - {title[:80]}"
                if app and app.lower() not in title.lower():
                    label += f" ({app})"
                lines.append(label)
            if len(windows) > 15:
                lines.append(f"  ... and {len(windows) - 15} more")
        return "\n".join(lines) if lines else "No window info available."
    except Exception as e:
        return f"Environment state unavailable: {e}"
