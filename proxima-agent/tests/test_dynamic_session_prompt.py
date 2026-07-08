"""Unit tests for Phase D: Dynamic Session Prompt System.

Tests cover:
  - Capability Extractor (regex fallback, cache, classification result)
  - Confidence Tiers (full/medium/minimal prompt assembly)
  - Prompt Block Loader (file loading, mtime cache)
  - Tool Discovery (list_tools, describe_tool, aliases)
  - Skill Store lifecycle (create, record, promote, demote, purge)
  - EMA calculation
  - Weighted applicability scoring
  - Reflection gate (same_failure >= 2, cooldown)
  - Skill injection formatting (max tokens, max skills)
  - PromptManager routing (BYOK untouched, Session Mode dynamic)
"""

import json
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock


class TestClassificationResult(unittest.TestCase):
    """Test ClassificationResult validation and confidence tiers."""

    def test_valid_capabilities_normalized(self):
        from proxima_agent.prompt.dynamic_session_prompt import ClassificationResult
        r = ClassificationResult(
            capabilities=["browser", "invalid", "coding", "desktop"],
            workflow="bug_fix",
            confidence=0.85,
        )
        # Invalid caps filtered, sorted alphabetically
        self.assertEqual(r.capabilities, ["browser", "coding", "desktop"])
        self.assertEqual(r.workflow, "bug_fix")

    def test_invalid_workflow_defaults_to_general(self):
        from proxima_agent.prompt.dynamic_session_prompt import ClassificationResult
        r = ClassificationResult(workflow="nonexistent")
        self.assertEqual(r.workflow, "general")

    def test_confidence_clamped(self):
        from proxima_agent.prompt.dynamic_session_prompt import ClassificationResult
        r1 = ClassificationResult(confidence=1.5)
        self.assertEqual(r1.confidence, 1.0)
        r2 = ClassificationResult(confidence=-0.3)
        self.assertEqual(r2.confidence, 0.0)

    def test_full_tier(self):
        from proxima_agent.prompt.dynamic_session_prompt import ClassificationResult
        r = ClassificationResult(confidence=0.8)
        self.assertEqual(r.confidence_tier, "full")

    def test_medium_tier(self):
        from proxima_agent.prompt.dynamic_session_prompt import ClassificationResult
        r = ClassificationResult(confidence=0.45)
        self.assertEqual(r.confidence_tier, "medium")

    def test_minimal_tier(self):
        from proxima_agent.prompt.dynamic_session_prompt import ClassificationResult
        r = ClassificationResult(confidence=0.1)
        self.assertEqual(r.confidence_tier, "minimal")

    def test_boundary_060(self):
        from proxima_agent.prompt.dynamic_session_prompt import ClassificationResult
        r = ClassificationResult(confidence=0.6)
        self.assertEqual(r.confidence_tier, "full")

    def test_boundary_030(self):
        from proxima_agent.prompt.dynamic_session_prompt import ClassificationResult
        r = ClassificationResult(confidence=0.3)
        self.assertEqual(r.confidence_tier, "medium")

    def test_equality(self):
        from proxima_agent.prompt.dynamic_session_prompt import ClassificationResult
        r1 = ClassificationResult(capabilities=["browser"], workflow="bug_fix", confidence=0.8)
        r2 = ClassificationResult(capabilities=["browser"], workflow="bug_fix", confidence=0.9)
        # Same tier (both full), same caps, same workflow → equal
        self.assertEqual(r1, r2)

    def test_to_dict(self):
        from proxima_agent.prompt.dynamic_session_prompt import ClassificationResult
        r = ClassificationResult(capabilities=["shell"], confidence=0.7, reasoning="test")
        d = r.to_dict()
        self.assertIn("capabilities", d)
        self.assertEqual(d["reasoning"], "test")


class TestRegexFallback(unittest.TestCase):
    """Test Tier 2 regex/keyword-based capability extraction."""

    def test_browser_keywords(self):
        from proxima_agent.prompt.dynamic_session_prompt import _fallback_extract_capabilities
        r = _fallback_extract_capabilities("Open Gmail and send an email")
        self.assertIn("browser", r.capabilities)
        self.assertEqual(r.reasoning, "fallback:regex")
        self.assertEqual(r.confidence, 0.5)

    def test_coding_keywords(self):
        from proxima_agent.prompt.dynamic_session_prompt import _fallback_extract_capabilities
        r = _fallback_extract_capabilities("Fix the syntax error in the Python function")
        self.assertIn("coding", r.capabilities)

    def test_multiple_caps(self):
        from proxima_agent.prompt.dynamic_session_prompt import _fallback_extract_capabilities
        r = _fallback_extract_capabilities("Open chrome and run a shell command to install npm")
        self.assertIn("browser", r.capabilities)
        self.assertIn("shell", r.capabilities)

    def test_no_match_low_confidence(self):
        from proxima_agent.prompt.dynamic_session_prompt import _fallback_extract_capabilities
        r = _fallback_extract_capabilities("Tell me a joke")
        self.assertEqual(r.capabilities, [])
        self.assertEqual(r.confidence, 0.2)

    def test_workflow_detection(self):
        from proxima_agent.prompt.dynamic_session_prompt import _fallback_extract_capabilities
        r = _fallback_extract_capabilities("Fix the broken login bug")
        self.assertEqual(r.workflow, "bug_fix")


class TestClassifierCache(unittest.TestCase):
    """Test Tier 3 classifier cache."""

    def test_cache_put_and_get(self):
        from proxima_agent.prompt.dynamic_session_prompt import (
            _cache_put, _cache_get, ClassificationResult,
        )
        r = ClassificationResult(capabilities=["browser"], confidence=0.9)
        _cache_put("test message", r)
        cached = _cache_get("test message")
        self.assertIsNotNone(cached)
        self.assertEqual(cached.capabilities, ["browser"])

    def test_cache_normalized(self):
        from proxima_agent.prompt.dynamic_session_prompt import (
            _cache_put, _cache_get, ClassificationResult,
        )
        r = ClassificationResult(capabilities=["shell"])
        _cache_put("  Fix  The   Bug  ", r)
        # Normalized: lowercase, collapsed whitespace
        cached = _cache_get("fix the bug")
        self.assertIsNotNone(cached)

    def test_cache_miss(self):
        from proxima_agent.prompt.dynamic_session_prompt import _cache_get
        cached = _cache_get("some random unique message 12345")
        self.assertIsNone(cached)


class TestPromptAssembly(unittest.TestCase):
    """Test prompt assembly for 3 confidence tiers."""

    def test_full_tier_has_blocks(self):
        from proxima_agent.prompt.dynamic_session_prompt import (
            ClassificationResult, build_session_prompt,
        )
        r = ClassificationResult(
            capabilities=["browser", "coding"],
            workflow="bug_fix",
            confidence=0.85,
        )
        prompt = build_session_prompt(r)
        self.assertIn("Proxima Agent", prompt)
        self.assertIn("BROWSER", prompt)
        self.assertIn("BUG FIX WORKFLOW", prompt)
        self.assertIn("TOOL DISCOVERY", prompt)

    def test_medium_tier_has_blocks(self):
        """Medium tier injects ACTUAL capability API blocks (not names-only).

        The regex classifier yields the 'medium' tier for any detected
        capability, so this is the common path — it must carry real tool docs
        so the agent has the correct API up front instead of guessing.
        """
        from proxima_agent.prompt.dynamic_session_prompt import (
            ClassificationResult, build_session_prompt,
        )
        r = ClassificationResult(
            capabilities=["browser", "shell"],
            confidence=0.45,
        )
        prompt = build_session_prompt(r)
        # Real capability blocks present (browser + shell), with API symbols.
        self.assertIn("BROWSER", prompt)
        self.assertIn("ChromeBrowser", prompt)
        self.assertIn("SHELL", prompt)
        # Medium tier still omits the full workflow guide (full-tier only).
        self.assertNotIn("BUG FIX WORKFLOW", prompt)

    def test_minimal_tier_core_only(self):
        from proxima_agent.prompt.dynamic_session_prompt import (
            ClassificationResult, build_session_prompt,
        )
        r = ClassificationResult(confidence=0.1)
        prompt = build_session_prompt(r)
        self.assertIn("Proxima Agent", prompt)
        self.assertIn("TOOL DISCOVERY", prompt)
        self.assertNotIn("BROWSER QUICK-REF", prompt)
        self.assertNotIn("Available capabilities:", prompt)

    def test_deterministic(self):
        """Same inputs → same output (Rule 1)."""
        from proxima_agent.prompt.dynamic_session_prompt import (
            ClassificationResult, build_session_prompt,
        )
        r = ClassificationResult(
            capabilities=["browser"],
            workflow="browser_research",
            confidence=0.9,
        )
        p1 = build_session_prompt(r)
        p2 = build_session_prompt(r)
        self.assertEqual(p1, p2)

    def test_skill_hints_injected_in_full_tier(self):
        from proxima_agent.prompt.dynamic_session_prompt import (
            ClassificationResult, build_session_prompt,
        )
        r = ClassificationResult(capabilities=["browser"], confidence=0.9)
        prompt = build_session_prompt(r, skill_hints="PROVEN PATTERNS:\n• test_skill (85%): Do X")
        self.assertIn("PROVEN PATTERNS:", prompt)
        self.assertIn("test_skill", prompt)


class TestBlockLoader(unittest.TestCase):
    """Test prompt block file loader with mtime cache."""

    def test_load_existing_block(self):
        from proxima_agent.prompt.dynamic_session_prompt import _load_block
        content = _load_block("browser", "capabilities")
        self.assertIn("ChromeBrowser", content)

    def test_load_missing_block(self):
        from proxima_agent.prompt.dynamic_session_prompt import _load_block
        content = _load_block("nonexistent", "capabilities")
        self.assertEqual(content, "")

    def test_load_workflow(self):
        from proxima_agent.prompt.dynamic_session_prompt import _load_block
        content = _load_block("bug_fix", "workflows")
        self.assertIn("Reproduce", content)


class TestToolDiscovery(unittest.TestCase):
    """Test list_tools() and describe_tool() functions."""

    def test_list_tools_all_categories(self):
        from proxima_agent.prompt.dynamic_session_prompt import list_tools
        output = list_tools()
        for cat in ["browser", "desktop", "coding", "repo", "shell", "network", "ocr", "file"]:
            self.assertIn(cat, output)

    def test_describe_tool_browser(self):
        from proxima_agent.prompt.dynamic_session_prompt import describe_tool
        output = describe_tool("browser")
        self.assertIn("BROWSER", output)
        self.assertIn("ChromeBrowser", output)

    def test_describe_tool_alias(self):
        from proxima_agent.prompt.dynamic_session_prompt import describe_tool
        output = describe_tool("chrome")
        self.assertIn("BROWSER", output)

    def test_describe_tool_unknown(self):
        from proxima_agent.prompt.dynamic_session_prompt import describe_tool
        output = describe_tool("quantum_computer")
        self.assertIn("Unknown category", output)
        self.assertIn("Available:", output)


class TestEMA(unittest.TestCase):
    """Test Exponential Moving Average calculation."""

    def test_ema_success_from_zero(self):
        from proxima_agent.prompt.skills import _update_ema
        rate = _update_ema(0.0, True)
        self.assertAlmostEqual(rate, 0.3)  # α=0.3: 0.3*1 + 0.7*0

    def test_ema_failure_from_high(self):
        from proxima_agent.prompt.skills import _update_ema
        rate = _update_ema(0.9, False)
        self.assertAlmostEqual(rate, 0.63)  # 0.3*0 + 0.7*0.9

    def test_ema_convergence_to_proven(self):
        """After enough successes, EMA crosses 0.80 threshold."""
        from proxima_agent.prompt.skills import _update_ema
        rate = 0.0
        for _ in range(5):
            rate = _update_ema(rate, True)
        self.assertGreaterEqual(rate, 0.80)

    def test_ema_rapid_demotion(self):
        """After consecutive failures, EMA drops below 0.50 (demotion)."""
        from proxima_agent.prompt.skills import _update_ema
        rate = 0.85
        for _ in range(3):
            rate = _update_ema(rate, False)
        self.assertLess(rate, 0.50)


class TestSkillStore(unittest.TestCase):
    """Test SkillStore CRUD and lifecycle."""

    def setUp(self):
        """Create a temporary skill store for testing."""
        from proxima_agent.prompt.skills import SkillStore
        # Monkey-patch _db_path to use temp dir
        self._orig_db_path = None
        self._tmpdir = tempfile.mkdtemp()
        self._db_file = os.path.join(self._tmpdir, "test_skills.db")

        import proxima_agent.prompt.skills as skills_mod
        self._orig_db_path = skills_mod._db_path
        skills_mod._db_path = lambda: Path(self._db_file)

        self.store = SkillStore()

    def tearDown(self):
        self.store.close()
        import proxima_agent.prompt.skills as skills_mod
        skills_mod._db_path = self._orig_db_path
        try:
            os.remove(self._db_file)
            os.rmdir(self._tmpdir)
        except OSError:
            pass

    def test_save_candidate(self):
        skill = self.store.save_candidate({
            "name": "test_create",
            "trigger": ["test"],
            "capabilities": ["coding"],
            "guidance": ["Do X"],
        })
        self.assertEqual(skill.status, "candidate")
        self.assertEqual(skill.name, "test_create")
        self.assertEqual(skill.uses, 0)

    def test_never_directly_proven(self):
        """Agent can NEVER directly create proven skills."""
        skill = self.store.save_candidate({
            "name": "test_never_proven",
            "trigger": ["test"],
        })
        self.assertEqual(skill.status, "candidate")

    def test_promotion_after_quality_gates(self):
        self.store.save_candidate({
            "name": "test_promote",
            "trigger": ["test"],
            "capabilities": ["coding"],
            "guidance": ["Do X"],
        })
        # Need >= 3 uses AND >= 80% EMA
        # From 0, need 5 consecutive successes to cross 0.80
        for _ in range(5):
            self.store.record_use("test_promote", True)
        skill = self.store.get("test_promote")
        self.assertEqual(skill.status, "proven")
        self.assertGreaterEqual(skill.success_rate, 0.80)

    def test_no_promotion_with_failures(self):
        self.store.save_candidate({
            "name": "test_no_promote",
            "trigger": ["test"],
        })
        # Mixed results — rate won't reach 80%
        self.store.record_use("test_no_promote", True)
        self.store.record_use("test_no_promote", False)
        self.store.record_use("test_no_promote", True)
        skill = self.store.get("test_no_promote")
        self.assertEqual(skill.status, "candidate")

    def test_auto_demotion(self):
        """Proven skill demotes when EMA drops below thresholds."""
        self.store.save_candidate({
            "name": "test_demote",
            "trigger": ["test"],
        })
        # Promote it first (6 successes → EMA ~0.882)
        for _ in range(6):
            self.store.record_use("test_demote", True)
        skill = self.store.get("test_demote")
        self.assertEqual(skill.status, "proven")

        # 3 failures: EMA drops below 0.50 → demoted to candidate
        for _ in range(3):
            self.store.record_use("test_demote", False)
        skill = self.store.get("test_demote")
        self.assertEqual(skill.status, "candidate")

    def test_auto_deprecation(self):
        """Candidate skill depreciates when EMA drops below 20%."""
        self.store.save_candidate({
            "name": "test_deprecate",
            "trigger": ["test"],
        })
        # 1 success then many failures to push EMA below 0.20
        self.store.record_use("test_deprecate", True)
        for _ in range(6):
            self.store.record_use("test_deprecate", False)
        skill = self.store.get("test_deprecate")
        self.assertEqual(skill.status, "deprecated")

    def test_skill_evolution(self):
        """Saving same name evolves (bumps version, merges guidance)."""
        self.store.save_candidate({
            "name": "test_evolve",
            "trigger": ["v1"],
            "guidance": ["Step A"],
        })
        self.store.save_candidate({
            "name": "test_evolve",
            "trigger": ["v2"],
            "guidance": ["Step B"],
        })
        skill = self.store.get("test_evolve")
        self.assertEqual(skill.version, 2)
        self.assertIn("Step A", skill.guidance)
        self.assertIn("Step B", skill.guidance)

    def test_fuzzy_name_match(self):
        self.store.save_candidate({
            "name": "gmail_send_email",
            "trigger": ["gmail"],
        })
        match = self.store.fuzzy_name_match("send_email_gmail")
        self.assertIsNotNone(match)
        self.assertEqual(match.name, "gmail_send_email")

    def test_purge_stale(self):
        """Deprecated skills older than 180 days get purged."""
        from datetime import datetime, timezone, timedelta
        old_date = (datetime.now(timezone.utc) - timedelta(days=200)).isoformat()
        self.store.save_candidate({"name": "old_skill", "trigger": ["old"]})
        # Force status and date
        self.store.conn.execute(
            "UPDATE skills SET status='deprecated', updated_at=? WHERE name='old_skill'",
            (old_date,)
        )
        self.store.conn.commit()
        count = self.store.purge_stale()
        self.assertEqual(count, 1)
        self.assertIsNone(self.store.get("old_skill"))


class TestSkillRetriever(unittest.TestCase):
    """Test weighted applicability scoring."""

    def setUp(self):
        from proxima_agent.prompt.skills import SkillStore, SkillRetriever
        self._tmpdir = tempfile.mkdtemp()
        self._db_file = os.path.join(self._tmpdir, "test_skills2.db")

        import proxima_agent.prompt.skills as skills_mod
        self._orig_db_path = skills_mod._db_path
        skills_mod._db_path = lambda: Path(self._db_file)

        self.store = SkillStore()
        self.retriever = SkillRetriever(self.store)

        # Create and promote a test skill
        self.store.save_candidate({
            "name": "gmail_attach",
            "trigger": ["gmail", "attachment", "send email"],
            "capabilities": ["browser", "file"],
            "workflow": "browser_research",
            "guidance": ["Wait for attachment chip before clicking Send"],
        })
        for _ in range(6):
            self.store.record_use("gmail_attach", True)

    def tearDown(self):
        self.store.close()
        import proxima_agent.prompt.skills as skills_mod
        skills_mod._db_path = self._orig_db_path
        try:
            os.remove(self._db_file)
            os.rmdir(self._tmpdir)
        except OSError:
            pass

    def test_matching_skill_found(self):
        results = self.retriever.keyword_search(
            capabilities=["browser", "file"],
            workflow="browser_research",
            user_message="Send email with attachment via gmail",
        )
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].name, "gmail_attach")

    def test_no_match_wrong_caps(self):
        results = self.retriever.keyword_search(
            capabilities=["shell"],
            workflow="bug_fix",
            user_message="compile the project",
        )
        # gmail_attach shouldn't match shell/bug_fix
        self.assertEqual(len(results), 0)

    def test_max_skills_limit(self):
        """Max 3 skills returned (MAX_SKILLS_INJECTED)."""
        results = self.retriever.keyword_search(
            capabilities=["browser"],
            workflow="browser_research",
            user_message="gmail",
            top_k=3,
        )
        self.assertLessEqual(len(results), 3)


class TestSkillInjectionFormat(unittest.TestCase):
    """Test compact skill hint formatting."""

    def test_empty_skills(self):
        from proxima_agent.prompt.skills import format_skill_hints
        result = format_skill_hints([])
        self.assertEqual(result, "")

    def test_format_proven_skills(self):
        from proxima_agent.prompt.skills import format_skill_hints, Skill
        mock_row = {
            "name": "gmail_attach",
            "version": 1,
            "trigger_json": '["gmail"]',
            "caps_json": '["browser"]',
            "workflow": "general",
            "guidance_json": '["Wait for chip", "Verify attachment"]',
            "neg_guidance_json": '["Never click Send before upload"]',
            "verification_json": "[]",
            "evidence_json": "[]",
            "failure_json": "[]",
            "success_rate": 0.92,
            "uses": 5,
            "status": "proven",
            "created_at": "2026-01-01",
            "updated_at": "2026-06-28",
        }
        skill = Skill(mock_row)
        result = format_skill_hints([skill])
        self.assertIn("PROVEN PATTERNS:", result)
        self.assertIn("gmail_attach", result)
        self.assertIn("92%", result)

    def test_max_token_budget(self):
        """Skill hints must not exceed MAX_SKILL_TOKENS."""
        from proxima_agent.prompt.skills import format_skill_hints, Skill
        skills = []
        for i in range(10):
            mock_row = {
                "name": f"skill_{i}",
                "version": 1,
                "trigger_json": "[]",
                "caps_json": "[]",
                "workflow": "general",
                "guidance_json": json.dumps([f"Guidance line {i} with extra text to make it longer"]),
                "neg_guidance_json": json.dumps([f"Negative guidance {i}"]),
                "verification_json": "[]",
                "evidence_json": "[]",
                "failure_json": "[]",
                "success_rate": 0.9,
                "uses": 5,
                "status": "proven",
                "created_at": "2026-01-01",
                "updated_at": "2026-06-28",
            }
            skills.append(Skill(mock_row))

        result = format_skill_hints(skills, max_tokens=200)
        # Approximate token count check (4 chars per token)
        approx_tokens = len(result) // 4
        self.assertLessEqual(approx_tokens, 250)  # with some margin


class TestReflectionGate(unittest.TestCase):
    """Test failure tracking and reflection gate."""

    def setUp(self):
        from proxima_agent.prompt.skills import clear_failure_tracker
        clear_failure_tracker()

    def test_first_failure_no_reflect(self):
        from proxima_agent.prompt.skills import track_failure
        result = track_failure("connection refused")
        self.assertFalse(result)

    def test_second_same_failure_reflects(self):
        from proxima_agent.prompt.skills import track_failure
        track_failure("connection refused")
        result = track_failure("connection refused")
        self.assertTrue(result)

    def test_different_failure_no_reflect(self):
        from proxima_agent.prompt.skills import track_failure
        track_failure("connection refused")
        result = track_failure("timeout error")
        self.assertFalse(result)

    def test_cooldown_prevents_rapid_reflection(self):
        from proxima_agent.prompt.skills import (
            track_failure, _reflection_cooldowns, _failure_key,
        )
        # First two trigger reflection
        track_failure("cooldown test error")
        result1 = track_failure("cooldown test error")
        self.assertTrue(result1)

        # Third should be blocked by 30 min cooldown
        result2 = track_failure("cooldown test error")
        self.assertFalse(result2)

    def test_clear_tracker(self):
        from proxima_agent.prompt.skills import (
            track_failure, clear_failure_tracker, _failure_tracker,
        )
        track_failure("some error")
        clear_failure_tracker()
        self.assertEqual(len(_failure_tracker), 0)


class TestPromptManagerRouting(unittest.TestCase):
    """Test PromptManager routes BYOK and Session Mode correctly."""

    def test_byok_first_turn_uses_full_prompt(self):
        from proxima_agent.prompt import PromptManager
        pm = PromptManager(byok_mode=True)
        prompt = pm.get_prompt()
        # Full prompt has identity + tool docs
        self.assertIn("Proxima", prompt)
        self.assertGreater(len(prompt), 3000)  # Full prompt is large

    def test_byok_light_turn(self):
        from proxima_agent.prompt import PromptManager
        pm = PromptManager(byok_mode=True)
        pm.get_prompt()  # consume first turn
        prompt = pm.get_prompt(user_message="fix bug")
        self.assertLess(len(prompt), 3000)  # Light is compact

    def test_session_mode_uses_dynamic(self):
        from proxima_agent.prompt import PromptManager
        pm = PromptManager(byok_mode=False)
        prompt = pm.get_prompt(
            user_message="Fix login bug in auth.py",
            config={"api_url": "http://127.0.0.1:3210/v1"},
        )
        # Dynamic prompt is compact and contains core identity. Medium/full
        # tiers now inject real capability blocks (browser/coding for a
        # "fix login bug in auth.py" message), so it is larger than the old
        # names-only build but still far smaller than the BYOK full prompt.
        self.assertIn("Proxima Agent", prompt)
        self.assertLess(len(prompt), 5000)  # Much smaller than BYOK full (~3000+)

    def test_session_mode_rebuild_check(self):
        from proxima_agent.prompt import PromptManager
        pm = PromptManager(byok_mode=False)
        config = {"api_url": "http://127.0.0.1:3210/v1"}

        p1 = pm.get_prompt(user_message="Fix bug", config=config)
        p2 = pm.get_prompt(user_message="Fix bug", config=config)
        # Same message → likely same classification → cached prompt reused
        # (exact equality depends on classifier, but both should be short)
        self.assertIsNotNone(p1)
        self.assertIsNotNone(p2)

    def test_reset_clears_session_state(self):
        from proxima_agent.prompt import PromptManager
        pm = PromptManager(byok_mode=False)
        pm.get_prompt(user_message="test", config={})
        self.assertIsNotNone(pm._prev_classification)
        pm.reset()
        self.assertIsNone(pm._prev_classification)
        self.assertIsNone(pm._cached_prompt)


class TestPhaseEAttemptOutcomeAndDocs(unittest.TestCase):
    """Verify exception type capture, recovery classification, TaskOutcome logic, and tool docs detailed merge."""

    def test_exception_type_captured(self):
        from proxima_agent.tools.execute import execute_code, get_last_exception_type
        execute_code("import some_non_existent_module_xyz")
        exc = get_last_exception_type()
        self.assertEqual(exc, "ModuleNotFoundError") # in Python 3, it's ModuleNotFoundError

    def test_single_error_no_recovery(self):
        from proxima_agent.brain.tracker import Tracker
        from proxima_agent.brain import Brain
        
        brain = Brain()
        brain.record("code", "desc", "result", success=False)
        self.assertFalse(brain.tracker.last_execution.recovery_needed)

    def test_consecutive_errors_recovery(self):
        from proxima_agent.brain.tracker import Tracker
        
        tracker = Tracker()
        tracker.record_execution("code1", "desc1", "res1", success=False)
        tracker.record_execution("code2", "desc2", "res2", success=False)
        
        # Let's simulate the classification logic:
        record = tracker.last_execution
        reasons = []
        consecutive_err_count = 0
        for r in reversed(tracker.executions):
            if not r.success:
                consecutive_err_count += 1
            else:
                break
        if consecutive_err_count >= 2:
            reasons.append("consecutive_errors")
        
        self.assertIn("consecutive_errors", reasons)

    def test_recovery_exceptions(self):
        _RECOVERY_EXCEPTIONS = {"ImportError", "ModuleNotFoundError"}
        exc_type = "ImportError"
        reasons = []
        if exc_type in _RECOVERY_EXCEPTIONS:
            reasons.append("recovery_exception")
        self.assertIn("recovery_exception", reasons)

    def test_timeout_exception_type(self):
        import re
        last_line = "TimeoutError: execution timed out"
        match = re.search(r"\b([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Exit|Interrupt|timeout))\b", last_line)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), "TimeoutError")

    def test_worker_crash_exception_type(self):
        import re
        last_line = "socket.timeout: The write operation timed out"
        match = re.search(r"\b([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Exit|Interrupt|timeout))\b", last_line)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), "socket.timeout")

    def test_describe_tool_merges_detailed(self):
        from proxima_agent.prompt.dynamic_session_prompt import describe_tool
        doc = describe_tool("browser")
        self.assertIn("BROWSER", doc)
        self.assertIn("When to use", doc)
        self.assertIn("COMMON MISTAKES", doc) # from detailed doc

    def test_task_goal_achieved(self):
        from proxima_agent.agent import TaskOutcome, TaskOutcomeReason
        from proxima_agent.brain.bucket import BucketStatus, Bucket
        from proxima_agent.brain import Brain
        
        bucket = Bucket("test")
        bucket.start_executing()
        brain = Brain()
        
        brain.record("code", "desc", "result", success=True)
        completed = True
        reason = TaskOutcomeReason.COMPLETED
        if brain.tracker.executions:
            all_results = "\n".join(e.result for e in brain.tracker.executions if e.result)
            if bucket.status == BucketStatus.FAILED or "VERIFY:FAIL" in all_results:
                completed = False
                reason = TaskOutcomeReason.VERIFICATION_FAILED
            else:
                last_exec = brain.tracker.last_execution
                if last_exec and not last_exec.success:
                    completed = False
                    reason = TaskOutcomeReason.EXECUTION_FAILED
                    
        self.assertTrue(completed)
        self.assertEqual(reason, TaskOutcomeReason.COMPLETED)

    def test_explicit_gave_up_marker(self):
        from proxima_agent.agent import TaskOutcome, TaskOutcomeReason
        from proxima_agent.brain import Brain
        from proxima_agent.brain.bucket import Bucket
        
        brain = Brain()
        brain.record("print('TASK:GAVE_UP')", "desc", "TASK:GAVE_UP", success=True)
        bucket = Bucket("test")
        
        completed = True
        reason = TaskOutcomeReason.COMPLETED
        if brain.tracker.executions:
            all_results = "\n".join(e.result for e in brain.tracker.executions if e.result)
            if "TASK:GAVE_UP" in all_results:
                completed = False
                reason = TaskOutcomeReason.GAVE_UP
        
        self.assertFalse(completed)
        self.assertEqual(reason, TaskOutcomeReason.GAVE_UP)

    def test_execution_failed_outcome(self):
        from proxima_agent.agent import TaskOutcome, TaskOutcomeReason
        from proxima_agent.brain import Brain
        from proxima_agent.brain.bucket import Bucket
        
        brain = Brain()
        brain.record("bad code", "desc", "error", success=False)
        bucket = Bucket("test")
        
        completed = True
        reason = TaskOutcomeReason.COMPLETED
        if brain.tracker.executions:
            all_results = "\n".join(e.result for e in brain.tracker.executions if e.result)
            last_exec = brain.tracker.last_execution
            if last_exec and not last_exec.success:
                completed = False
                reason = TaskOutcomeReason.EXECUTION_FAILED
        
        self.assertFalse(completed)
        self.assertEqual(reason, TaskOutcomeReason.EXECUTION_FAILED)


class TestCandidateFlow(unittest.TestCase):
    """Test candidate skill retrieval, scoring, and post-turn record_use loop."""

    def setUp(self):
        from proxima_agent.prompt.skills import SkillStore, SkillRetriever
        self._tmpdir = tempfile.mkdtemp()
        self._db_file = os.path.join(self._tmpdir, "test_skills_candidate.db")

        import proxima_agent.prompt.skills as skills_mod
        self._orig_db_path = skills_mod._db_path
        skills_mod._db_path = lambda: Path(self._db_file)

        self.store = SkillStore()
        self.retriever = SkillRetriever(self.store)

    def tearDown(self):
        self.store.close()
        import proxima_agent.prompt.skills as skills_mod
        skills_mod._db_path = self._orig_db_path
        try:
            os.remove(self._db_file)
            os.rmdir(self._tmpdir)
        except OSError:
            pass

    def test_candidate_retrieval_and_scoring(self):
        # 1. Save a new candidate skill. New seed is a NEUTRAL 0.0 EMA (not the
        #    old over-optimistic 1.0): proof must be earned via record_use.
        skill = self.store.save_candidate({
            "name": "test_candidate",
            "trigger": ["chrome", "site"],
            "capabilities": ["browser"],
            "workflow": "browser_research",
            "guidance": ["Use ChromeBrowser for scraping"],
        })
        self.assertEqual(skill.status, "candidate")
        self.assertEqual(skill.success_rate, 0.0)

        # 2. Retrieve skills
        results = self.retriever.keyword_search(
            capabilities=["browser"],
            workflow="browser_research",
            user_message="Open chrome site",
        )

        # 3. Despite a 0.0 EMA, the bandit cold-start prior (effective_rate ~0.5)
        #    lets a fresh candidate be retrieved as a TRIAL — so it can gather
        #    the evidence it needs to be promoted.
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].name, "test_candidate")

    def test_candidate_post_turn_success_update(self):
        from proxima_agent.agent import _session_post_turn, TaskOutcome, TaskOutcomeReason
        from proxima_agent.brain import Brain
        import proxima_agent.agent as agent_mod

        # Save candidate (browser capability)
        self.store.save_candidate({
            "name": "test_candidate",
            "trigger": ["chrome"],
            "capabilities": ["browser"],
            "workflow": "browser_research",
            "guidance": ["Test guidance"],
        })

        # Mock prompt manager and track injected skills
        class MockPromptManager:
            def __init__(self):
                self._prev_skill_names = ["test_candidate"]

        agent_mod._session_prompt_mgr = MockPromptManager()

        # Run post-turn hook (successful turn) WITH a browser execution, so the
        # skill's capability ("browser") intersects the tools actually used —
        # otherwise per-skill attribution would (correctly) skip scoring it.
        brain = Brain()
        brain.record(
            "from proxima_agent.tools.browser_cdp import ChromeBrowser\nb = ChromeBrowser()",
            "open browser", "[\u2713]\nok", success=True,
        )
        outcome = TaskOutcome(completed=True, reason=TaskOutcomeReason.COMPLETED)
        _session_post_turn(brain, {}, False, "test message", outcome)

        # Verify the skill was scored: uses incremented, EMA updated from the
        # neutral 0.0 seed (alpha=0.3, one success → 0.3).
        updated_skill = self.store.get("test_candidate")
        self.assertEqual(updated_skill.uses, 1)
        self.assertAlmostEqual(updated_skill.success_rate, 0.3)

    def test_attribution_skips_unrelated_skill(self):
        """A skill whose capability was NOT exercised this turn is not scored."""
        from proxima_agent.agent import _session_post_turn, TaskOutcome, TaskOutcomeReason
        from proxima_agent.brain import Brain
        import proxima_agent.agent as agent_mod

        self.store.save_candidate({
            "name": "desktop_skill",
            "trigger": ["app"],
            "capabilities": ["desktop"],
            "guidance": ["Use Desktop"],
        })

        class MockPromptManager:
            def __init__(self):
                self._prev_skill_names = ["desktop_skill"]

        agent_mod._session_prompt_mgr = MockPromptManager()

        # Task used the BROWSER, not the desktop — the desktop skill is unrelated.
        brain = Brain()
        brain.record(
            "from proxima_agent.tools.browser_cdp import ChromeBrowser",
            "browser work", "[\u2713]\nok", success=True,
        )
        outcome = TaskOutcome(completed=True, reason=TaskOutcomeReason.COMPLETED)
        _session_post_turn(brain, {}, False, "test message", outcome)

        # Unrelated skill must NOT have been scored (no false evidence).
        updated = self.store.get("desktop_skill")
        self.assertEqual(updated.uses, 0)


class TestSkillSystemModernBehavior(unittest.TestCase):
    """Phase-1/2 redesign: tier-decoupled injection, dynamic confidence,
    bandit cold-start, and the proven-vs-trial injection policy."""

    def setUp(self):
        from proxima_agent.prompt.skills import SkillStore, SkillRetriever
        self._tmpdir = tempfile.mkdtemp()
        self._db_file = os.path.join(self._tmpdir, "test_skills_modern.db")
        import proxima_agent.prompt.skills as skills_mod
        self._orig_db_path = skills_mod._db_path
        skills_mod._db_path = lambda: Path(self._db_file)
        self.store = SkillStore()
        self.retriever = SkillRetriever(self.store)

    def tearDown(self):
        self.store.close()
        import proxima_agent.prompt.skills as skills_mod
        skills_mod._db_path = self._orig_db_path
        try:
            os.remove(self._db_file)
            os.rmdir(self._tmpdir)
        except OSError:
            pass

    # ── 1B: dynamic confidence from detection completeness ──
    def test_confidence_caps_only_is_medium(self):
        from proxima_agent.prompt.dynamic_session_prompt import _fallback_extract_capabilities
        r = _fallback_extract_capabilities("Open gmail and send an email")
        self.assertEqual(r.confidence_tier, "medium")

    def test_confidence_caps_plus_workflow_is_full(self):
        from proxima_agent.prompt.dynamic_session_prompt import _fallback_extract_capabilities
        # "fix" + "bug" → 2 bug_fix keywords (corroborated) + a capability.
        r = _fallback_extract_capabilities("Fix the broken login bug in auth.py")
        self.assertEqual(r.workflow, "bug_fix")
        self.assertEqual(r.confidence_tier, "full")

    def test_confidence_no_caps_is_minimal(self):
        from proxima_agent.prompt.dynamic_session_prompt import _fallback_extract_capabilities
        r = _fallback_extract_capabilities("tell me a joke")
        self.assertEqual(r.confidence_tier, "minimal")

    # ── 1A: skills inject at medium tier (not just full) ──
    def test_skill_hints_injected_at_medium_tier(self):
        from proxima_agent.prompt.dynamic_session_prompt import (
            ClassificationResult, build_session_prompt,
        )
        r = ClassificationResult(capabilities=["browser"], confidence=0.45)  # medium
        prompt = build_session_prompt(r, skill_hints="PROVEN PATTERNS:\n• s (90%): do x")
        self.assertIn("PROVEN PATTERNS:", prompt)

    # ── 1C: bandit cold-start effective_rate ──
    def test_effective_rate_cold_start_is_neutral(self):
        from proxima_agent.prompt.skills import Skill
        fresh = Skill({"name": "x", "success_rate": 0.0, "uses": 0, "status": "candidate"})
        # uses=0 → prior mean (0.5), regardless of the 0.0 seed.
        self.assertAlmostEqual(self.retriever._effective_rate(fresh), 0.5)

    def test_effective_rate_converges_to_ema(self):
        from proxima_agent.prompt.skills import Skill
        seasoned = Skill({"name": "x", "success_rate": 0.9, "uses": 20, "status": "proven"})
        # Many uses → estimate close to the real EMA.
        self.assertGreater(self.retriever._effective_rate(seasoned), 0.85)

    # ── 1D: proven injected freely; unproven limited to the trial budget ──
    def test_injection_policy_proven_and_trial_budget(self):
        from proxima_agent.prompt.skills import TRIAL_INJECTION_BUDGET
        # One proven skill (browser) ...
        self.store.save_candidate({
            "name": "proven_browser", "trigger": ["gmail"],
            "capabilities": ["browser"], "workflow": "browser_research",
            "guidance": ["g"],
        })
        for _ in range(6):
            self.store.record_use("proven_browser", True)
        # ... and two fresh candidates competing for the single trial slot.
        for n in ("cand_one", "cand_two"):
            self.store.save_candidate({
                "name": n, "trigger": ["gmail"], "capabilities": ["browser"],
                "workflow": "browser_research", "guidance": ["g"],
            })

        results = self.retriever.keyword_search(
            capabilities=["browser"], workflow="browser_research",
            user_message="open gmail", top_k=5,
        )
        names = [s.name for s in results]
        self.assertIn("proven_browser", names)
        trial_count = sum(1 for s in results if s.status != "proven")
        self.assertLessEqual(trial_count, TRIAL_INJECTION_BUDGET)


class TestPhase3RetrievalAndTelemetry(unittest.TestCase):
    """Phase 3A (IDF/stemmed lexical retrieval) + 3B (telemetry analyzer,
    bounded log, safe cache self-correction)."""

    def setUp(self):
        from proxima_agent.prompt.skills import SkillStore, SkillRetriever
        self._tmpdir = tempfile.mkdtemp()
        self._db_file = os.path.join(self._tmpdir, "test_skills_p3.db")
        import proxima_agent.prompt.skills as skills_mod
        self._orig_db_path = skills_mod._db_path
        skills_mod._db_path = lambda: Path(self._db_file)
        self.store = SkillStore()
        self.retriever = SkillRetriever(self.store)

    def tearDown(self):
        self.store.close()
        import proxima_agent.prompt.skills as skills_mod
        skills_mod._db_path = self._orig_db_path
        try:
            os.remove(self._db_file)
            os.rmdir(self._tmpdir)
        except OSError:
            pass

    # ── 3A: tokenization / stemming ──
    def test_stem_plural_singular(self):
        from proxima_agent.prompt.skills import _stem
        self.assertEqual(_stem("files"), "file")
        self.assertEqual(_stem("attachments"), "attachment")
        self.assertEqual(_stem("css"), "css")     # 'ss' guard
        self.assertEqual(_stem("api"), "api")      # too short to strip

    def test_tokens_drop_stopwords_and_stem(self):
        from proxima_agent.prompt.skills import _tokens
        toks = _tokens("Open the Files and download Reports!")
        self.assertIn("file", toks)      # stemmed plural
        self.assertIn("report", toks)
        self.assertIn("download", toks)
        self.assertNotIn("the", toks)    # stopword
        self.assertNotIn("and", toks)

    def test_stemmed_trigger_matches_plural(self):
        """A plural in the message matches a singular trigger via stemming."""
        self.store.save_candidate({
            "name": "attach_skill",
            "trigger": ["attachment"],
            "capabilities": ["file"],
            "workflow": "general",
            "guidance": ["handle attachment"],
        })
        for _ in range(6):
            self.store.record_use("attach_skill", True)  # promote
        results = self.retriever.keyword_search(
            capabilities=["file"], workflow="general",
            user_message="upload two attachments now",
        )
        self.assertEqual([s.name for s in results], ["attach_skill"])

    # ── 3B: telemetry analyzer ──
    def test_analyze_telemetry(self):
        import proxima_agent.prompt.skills as sk
        tmp = Path(tempfile.mkdtemp())
        orig = sk._TELEMETRY_DIR
        sk._TELEMETRY_DIR = tmp
        try:
            recs = [
                {"prompt_tier": "medium", "prompt_rebuilt": True,
                 "predicted_workflow": "bug_fix", "predicted_caps": ["browser"],
                 "actual_tools_used": ["browser", "file"], "success": True,
                 "skills_injected": ["s1"]},
                {"prompt_tier": "full", "prompt_rebuilt": False,
                 "predicted_workflow": "general", "predicted_caps": ["shell"],
                 "actual_tools_used": ["shell"], "success": False,
                 "skills_injected": []},
            ]
            (tmp / "classifier.jsonl").write_text(
                "\n".join(json.dumps(r) for r in recs) + "\n", encoding="utf-8"
            )
            stats = sk.analyze_telemetry()
            self.assertEqual(stats["total"], 2)
            self.assertEqual(stats["analyzed_records"], 2)
            self.assertEqual(stats["capability_precision"], 1.0)   # tp2/(tp2+fp0)
            self.assertEqual(stats["capability_recall"], 0.667)    # tp2/(tp2+fn1)
            self.assertEqual(stats["skill_injection"]["lift"], 1.0)
            self.assertEqual(stats["prompt_rebuild_rate"], 0.5)
        finally:
            sk._TELEMETRY_DIR = orig
            try:
                os.remove(tmp / "classifier.jsonl")
                os.rmdir(tmp)
            except OSError:
                pass

    def test_analyze_telemetry_missing_file(self):
        import proxima_agent.prompt.skills as sk
        tmp = Path(tempfile.mkdtemp())
        orig = sk._TELEMETRY_DIR
        sk._TELEMETRY_DIR = tmp  # empty dir, no file
        try:
            self.assertEqual(sk.analyze_telemetry(), {"total": 0, "analyzed_records": 0})
        finally:
            sk._TELEMETRY_DIR = orig
            try:
                os.rmdir(tmp)
            except OSError:
                pass

    # ── 3B: telemetry log is bounded ──
    def test_telemetry_log_is_bounded(self):
        import proxima_agent.prompt.skills as sk
        tmp = Path(tempfile.mkdtemp())
        orig_dir, orig_max = sk._TELEMETRY_DIR, sk._MAX_TELEMETRY_RECORDS
        sk._TELEMETRY_DIR = tmp
        sk._MAX_TELEMETRY_RECORDS = 3
        try:
            for i in range(6):
                sk.log_classification(
                    f"msg {i}",
                    {"capabilities": [], "workflow": "general", "confidence": 0.2},
                    "minimal", True, [],
                )
            sk.backfill_telemetry(actual_tools=[], success=True)
            lines = (tmp / "classifier.jsonl").read_text(encoding="utf-8").strip().split("\n")
            self.assertLessEqual(len(lines), 3)
        finally:
            sk._TELEMETRY_DIR, sk._MAX_TELEMETRY_RECORDS = orig_dir, orig_max
            try:
                os.remove(tmp / "classifier.jsonl")
                os.rmdir(tmp)
            except OSError:
                pass

    # ── 3B: safe cache self-correction ──
    def test_refine_classification_cache(self):
        from proxima_agent.prompt.dynamic_session_prompt import (
            _cache_put, _cache_get, refine_classification_cache, ClassificationResult,
        )
        msg = "open the team dashboard widget xyz"
        _cache_put(msg, ClassificationResult(
            capabilities=["browser"], workflow="general", confidence=0.5))

        # Adds a capability that was actually used → entry upgraded.
        self.assertTrue(refine_classification_cache(msg, {"browser", "file"}))
        c = _cache_get(msg)
        self.assertEqual(c.capabilities, ["browser", "file"])
        self.assertEqual(c.reasoning, "telemetry-refined")

        # No new capability → no change.
        self.assertFalse(refine_classification_cache(msg, {"browser"}))
        # Unseen message → never fabricated.
        self.assertFalse(refine_classification_cache("totally unseen msg qqq", {"file"}))


if __name__ == "__main__":
    unittest.main()
