"""Drift-protection tests for the agent's tool registries.

There are two intentional registry views:
  - tools/registry.py::TOOL_REGISTRY        — granular tool catalog (prompts,
    health, parallel-safety). Internal/metadata.
  - prompt/dynamic_session_prompt._TOOL_REGISTRY — the agent-facing 8-capability
    discovery view (list_tools/describe_tool injected into the worker).

These tests guarantee that everything either registry PROMISES actually exists
and is importable — so the agent never gets an ImportError/AttributeError when
it follows the tool docs — and that the agent-facing discovery functions are a
single source of truth (same callables in code_env and the worker namespace).

Run:  python -m unittest tests.test_tool_registry_consistency  (from proxima-agent/)
"""
import importlib
import inspect
import os
import unittest


class TestRegistryCatalog(unittest.TestCase):
    """Every module/class/function/method in TOOL_REGISTRY must exist."""

    def test_every_registered_symbol_exists(self):
        from proxima_agent.tools import registry as R
        problems = []
        for cat, info in R.TOOL_REGISTRY.items():
            try:
                mod = importlib.import_module(info["module"])
            except Exception as e:  # pragma: no cover - reported as failure
                problems.append(f"{cat}: module {info['module']} import fail: {e}")
                continue
            cls = info.get("class")
            inst = info.get("instance")
            if cls and not hasattr(mod, cls):
                problems.append(f"{cat}: class {cls} missing in {info['module']}")
            if inst and not hasattr(mod, inst):
                problems.append(f"{cat}: instance {inst} missing in {info['module']}")
            for fn in info.get("functions", []):
                if not hasattr(mod, fn):
                    problems.append(f"{cat}: function {fn}() missing in {info['module']}")
            if cls and hasattr(mod, cls):
                klass = getattr(mod, cls)
                # Some "class" entries are actually FACTORY FUNCTIONS (e.g.
                # Desktop() returns a per-OS backend instance). Their methods
                # live on the returned object, not the factory symbol — so only
                # assert method existence for genuine classes; for a factory we
                # just confirm it's callable.
                if inspect.isclass(klass):
                    for m in info.get("key_methods", []):
                        if not hasattr(klass, m):
                            problems.append(f"{cat}: {cls}.{m}() missing")
                elif not callable(klass):
                    problems.append(f"{cat}: {cls} is neither a class nor callable")
        self.assertEqual(problems, [], "registry catalog drift:\n" + "\n".join(problems))


class TestDynamicDiscovery(unittest.TestCase):
    """The agent-facing discovery view must be importable and consistent."""

    def test_dynamic_registry_imports_resolve(self):
        from proxima_agent.prompt import dynamic_session_prompt as D
        problems = []
        for cat, info in D._TOOL_REGISTRY.items():
            try:
                exec(info["import"], {})
            except Exception as e:
                problems.append(f"{cat}: import fails -> {info['import']!r}: {e}")
        self.assertEqual(problems, [], "dynamic registry import drift:\n" + "\n".join(problems))

    def test_capability_blocks_exist(self):
        from proxima_agent.prompt import dynamic_session_prompt as D
        blocks_dir = os.path.join(os.path.dirname(D.__file__), "blocks", "capabilities")
        missing = [c for c in sorted(D._ALL_CAPABILITIES)
                   if not os.path.exists(os.path.join(blocks_dir, f"{c}.txt"))]
        self.assertEqual(missing, [], f"missing capability blocks: {missing}")

    def test_discovery_is_single_source_of_truth(self):
        # code_env must expose the SAME friendly, string-returning discovery
        # callables that the worker namespace injects — not the dict-returning
        # registry variants (which would crash on an unknown category).
        from proxima_agent.prompt import dynamic_session_prompt as D
        import proxima_agent.tools.code_env as CE
        self.assertIs(CE.list_tools, D.list_tools)
        self.assertIs(CE.describe_tool, D.describe_tool)
        # Unknown category returns a helpful string, never raises.
        out = CE.describe_tool("definitely_not_a_real_category")
        self.assertIsInstance(out, str)
        self.assertIn("Unknown category", out)


class TestDesktopBackends(unittest.TestCase):
    """Desktop() is a factory; verify each OS backend class actually implements
    the methods the registry advertises, and that all three backends agree."""

    def test_backends_implement_registry_methods(self):
        from proxima_agent.tools import registry as R
        from proxima_agent.tools.desktop._windows import WindowsDesktop
        from proxima_agent.tools.desktop._mac import MacDesktop
        from proxima_agent.tools.desktop._linux import LinuxDesktop

        key_methods = R.TOOL_REGISTRY["desktop"]["key_methods"]
        problems = []
        for backend in (WindowsDesktop, MacDesktop, LinuxDesktop):
            for m in key_methods:
                if not hasattr(backend, m):
                    problems.append(f"{backend.__name__}.{m}() missing")
        self.assertEqual(problems, [], "desktop backend drift:\n" + "\n".join(problems))

    def test_backends_implement_documented_core_api(self):
        # Every OS backend must implement the DOCUMENTED core API (the methods
        # the factory docstring + tool_docs advertise to the agent), so the same
        # agent code works on Windows, macOS and Linux. Backends MAY add extra
        # forgiving aliases beyond this set; we only enforce the documented core.
        from proxima_agent.tools.desktop._windows import WindowsDesktop
        from proxima_agent.tools.desktop._mac import MacDesktop
        from proxima_agent.tools.desktop._linux import LinuxDesktop

        documented_core = {
            "windows", "connect", "is_connected", "elements", "ui_tree",
            "read_text", "click", "write_text", "select", "toggle_check",
            "click_menu", "type_keys", "focus", "screenshot", "close",
        }
        problems = []
        for backend in (WindowsDesktop, MacDesktop, LinuxDesktop):
            missing = {m for m in documented_core if not hasattr(backend, m)}
            if missing:
                problems.append(f"{backend.__name__} missing: {sorted(missing)}")
        self.assertEqual(problems, [], "desktop core-API drift:\n" + "\n".join(problems))

    def test_backends_have_identical_public_api(self):
        # All three OS backends MUST expose the exact same public method set
        # (core + forgiving aliases), so identical agent code runs on every OS.
        # If a method/alias is added to one backend, it must be added to all.
        from proxima_agent.tools.desktop._windows import WindowsDesktop
        from proxima_agent.tools.desktop._mac import MacDesktop
        from proxima_agent.tools.desktop._linux import LinuxDesktop

        def public(cls):
            return {n for n in dir(cls)
                    if not n.startswith("_") and callable(getattr(cls, n))}

        win, mac, lin = public(WindowsDesktop), public(MacDesktop), public(LinuxDesktop)
        self.assertEqual(win, mac, f"Windows/macOS public API differ: {sorted(win ^ mac)}")
        self.assertEqual(win, lin, f"Windows/Linux public API differ: {sorted(win ^ lin)}")


if __name__ == "__main__":
    unittest.main()
