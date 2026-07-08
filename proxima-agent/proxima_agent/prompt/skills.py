"""Proxima — Self-Generated Skills.
Global cross-conversation procedural memory and skill store in SQLite.
"""

import json
import logging
import math
import os
import re
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# EMA smoothing factor
EMA_ALPHA = 0.3

# Auto-demotion thresholds
DEMOTION_TO_CANDIDATE = 0.50  # EMA < 50% → proven back to candidate
DEMOTION_TO_DEPRECATED = 0.20  # EMA < 20% → deprecated

# Quality gates for promotion to proven
MIN_USES_FOR_PROVEN = 3
MIN_RATE_FOR_PROVEN = 0.80
# Drifting proven skills below this bar are treated as unproven.
MIN_CONFIDENCE_FOR_INJECTION = 0.80

# Beta-Bernoulli neutral prior mean to allow candidates a fair trial.
COLD_START_PRIOR_MEAN = 0.5
COLD_START_PRIOR_STRENGTH = 2.0

# Max unproven skills injected per turn as trial.
TRIAL_INJECTION_BUDGET = 1

# A skill must score strictly above this relevance floor to be injected at all.
MIN_RELEVANCE_SCORE = 0.01

# Injection budget (Rule 9)
MAX_SKILLS_INJECTED = 3
MAX_SKILL_TOKENS = 200  # approximate token count for all injected skills

# Purge threshold (Rule 10)
PURGE_AFTER_DAYS = 180

# Reflection cooldown (Rule 6)
REFLECTION_COOLDOWN_S = 30 * 60  # 30 minutes

# Skill generation budget
MAX_SKILLS_PER_TASK = 1

# Applicability scoring weights
DEFAULT_WEIGHTS = {
    "capability": 0.4,
    "workflow": 0.3,
    "trigger": 0.2,
    "context": 0.1,
}


def _db_path() -> Path:
    return Path.home() / ".proxima" / "skills.db"


def _get_db() -> sqlite3.Connection:
    db_file = _db_path()
    db_file.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_file), timeout=5.0, check_same_thread=False)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        # Wait up to 5s for the write lock.
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")

        conn.executescript("""
            CREATE TABLE IF NOT EXISTS skills (
                name              TEXT PRIMARY KEY,
                version           INTEGER DEFAULT 1,
                trigger_json      TEXT DEFAULT '[]',
                caps_json         TEXT DEFAULT '[]',
                workflow          TEXT DEFAULT 'general',
                guidance_json     TEXT DEFAULT '[]',
                neg_guidance_json TEXT DEFAULT '[]',
                verification_json TEXT DEFAULT '[]',
                evidence_json     TEXT DEFAULT '[]',
                failure_json      TEXT DEFAULT '[]',
                success_rate      REAL DEFAULT 0.0,
                uses              INTEGER DEFAULT 0,
                status            TEXT DEFAULT 'candidate',
                created_at        TEXT,
                updated_at        TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_skills_status
                ON skills(status);
            CREATE INDEX IF NOT EXISTS idx_skills_caps
                ON skills(caps_json);
            CREATE INDEX IF NOT EXISTS idx_skills_status_workflow
                ON skills(status, workflow);
            CREATE INDEX IF NOT EXISTS idx_skills_updated
                ON skills(updated_at);
        """)
    except Exception:
        # Don't leak the handle if schema/PRAGMA setup fails (e.g. locked DB).
        try:
            conn.close()
        except Exception:
            pass
        raise
    return conn


def _update_ema(old_rate: float, success: bool, alpha: float = EMA_ALPHA) -> float:
    """Exponential Moving Average success rate update."""
    outcome = 1.0 if success else 0.0
    return alpha * outcome + (1.0 - alpha) * old_rate


class Skill:

    def __init__(self, row: sqlite3.Row | dict):
        data = dict(row)
        self.name: str = data["name"]
        self.version: int = data.get("version", 1)
        self.triggers: list[str] = json.loads(data.get("trigger_json", "[]"))
        self.capabilities: list[str] = json.loads(data.get("caps_json", "[]"))
        self.workflow: str = data.get("workflow", "general")
        self.guidance: list[str] = json.loads(data.get("guidance_json", "[]"))
        self.negative_guidance: list[str] = json.loads(
            data.get("neg_guidance_json", "[]")
        )
        self.verification: list[str] = json.loads(
            data.get("verification_json", "[]")
        )
        self.evidence_patterns: list[str] = json.loads(
            data.get("evidence_json", "[]")
        )
        self.failure_patterns: list[str] = json.loads(
            data.get("failure_json", "[]")
        )
        self.success_rate: float = data.get("success_rate", 0.0)
        self.uses: int = data.get("uses", 0)
        self.status: str = data.get("status", "candidate")
        self.created_at: str = data.get("created_at", "")
        self.updated_at: str = data.get("updated_at", "")


class SkillStore:

    def __init__(self):
        self._conn: sqlite3.Connection | None = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = _get_db()
        return self._conn

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None

    def get(self, name: str) -> Skill | None:
        row = self.conn.execute(
            "SELECT * FROM skills WHERE name = ?", (name,)
        ).fetchone()
        return Skill(row) if row else None

    def save_candidate(self, skill_data: dict) -> Skill:
        """Saves a skill candidate."""
        name = skill_data["name"]
        now = datetime.now(timezone.utc).isoformat()

        existing = self.get(name)
        if existing:
            # Evolve: bump version, merge guidance, keep status
            merged_guidance = list(set(
                existing.guidance + skill_data.get("guidance", [])
            ))
            merged_neg = list(set(
                existing.negative_guidance +
                skill_data.get("negative_guidance", [])
            ))
            merged_failure = list(set(
                existing.failure_patterns +
                skill_data.get("failure_patterns", [])
            ))

            self.conn.execute("""
                UPDATE skills SET
                    version = version + 1,
                    trigger_json = ?,
                    caps_json = ?,
                    workflow = ?,
                    guidance_json = ?,
                    neg_guidance_json = ?,
                    failure_json = ?,
                    updated_at = ?
                WHERE name = ?
            """, (
                json.dumps(list(set(
                    existing.triggers + skill_data.get("trigger", [])
                ))),
                json.dumps(list(set(
                    existing.capabilities + skill_data.get("capabilities", [])
                ))),
                skill_data.get("workflow", existing.workflow),
                json.dumps(merged_guidance),
                json.dumps(merged_neg),
                json.dumps(merged_failure),
                now,
                name,
            ))
        else:
            self.conn.execute("""
                INSERT INTO skills (
                    name, trigger_json, caps_json, workflow,
                    guidance_json, neg_guidance_json, verification_json,
                    evidence_json, failure_json,
                    success_rate, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0, 'candidate', ?, ?)
            """, (
                name,
                json.dumps(skill_data.get("trigger", [])),
                json.dumps(skill_data.get("capabilities", [])),
                skill_data.get("workflow", "general"),
                json.dumps(skill_data.get("guidance", [])),
                json.dumps(skill_data.get("negative_guidance", [])),
                json.dumps(skill_data.get("verification", [])),
                json.dumps(skill_data.get("evidence_patterns", [])),
                json.dumps(skill_data.get("failure_patterns", [])),
                now, now,
            ))

        self.conn.commit()
        return self.get(name)

    def record_use(self, name: str, success: bool) -> None:
        """Records skill use, updates success rate EMA, and checks promotion/demotion."""
        skill = self.get(name)
        if not skill:
            return

        new_rate = _update_ema(skill.success_rate, success)
        new_uses = skill.uses + 1
        now = datetime.now(timezone.utc).isoformat()

        # Auto-demotion check
        new_status = skill.status
        if skill.status == "proven" and new_rate < DEMOTION_TO_CANDIDATE:
            new_status = "candidate"
            logger.info("Skill '%s' demoted to candidate (EMA=%.2f)", name, new_rate)
        elif skill.status == "candidate" and new_rate < DEMOTION_TO_DEPRECATED:
            new_status = "deprecated"
            logger.info("Skill '%s' deprecated (EMA=%.2f)", name, new_rate)

        # Auto-promotion check (candidate → proven)
        if (skill.status == "candidate"
                and new_uses >= MIN_USES_FOR_PROVEN
                and new_rate >= MIN_RATE_FOR_PROVEN):
            new_status = "proven"
            logger.info("Skill '%s' promoted to proven (uses=%d, EMA=%.2f)",
                        name, new_uses, new_rate)

        self.conn.execute("""
            UPDATE skills SET
                success_rate = ?,
                uses = ?,
                status = ?,
                updated_at = ?
            WHERE name = ?
        """, (new_rate, new_uses, new_status, now, name))
        self.conn.commit()

    def get_proven(self, workflow: str = None) -> list[Skill]:
        if workflow:
            rows = self.conn.execute(
                "SELECT * FROM skills WHERE status IN ('proven', 'candidate') AND workflow = ?",
                (workflow,),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM skills WHERE status IN ('proven', 'candidate')"
            ).fetchall()
        return [Skill(r) for r in rows]

    def purge_stale(self) -> int:
        cutoff = (
            datetime.now(timezone.utc) - timedelta(days=PURGE_AFTER_DAYS)
        ).isoformat()
        cursor = self.conn.execute(
            "DELETE FROM skills WHERE status = 'deprecated' AND updated_at < ?",
            (cutoff,),
        )
        self.conn.commit()
        count = cursor.rowcount
        if count:
            logger.info("Purged %d stale deprecated skills", count)
        return count

    def fuzzy_name_match(self, name: str) -> Skill | None:
        # Normalize: lowercase, strip underscores/hyphens, sort words
        def normalize(n):
            words = re.sub(r"[_\-]", " ", n.lower()).split()
            return " ".join(sorted(words))

        target = normalize(name)
        rows = self.conn.execute("SELECT name FROM skills").fetchall()
        for row in rows:
            if normalize(row["name"]) == target:
                return self.get(row["name"])
        return None


# Lightweight stopword removal and token overlap for zero-dependency lexical relevance matching.
_STOPWORDS = frozenset({
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "to", "of",
    "in", "for", "on", "with", "at", "by", "from", "and", "or", "but", "not",
    "this", "that", "it", "i", "you", "me", "my", "your", "we", "do", "does",
    "did", "can", "will", "would", "should", "could", "please", "want", "need",
    "make", "create", "help", "how", "what", "when", "where", "why", "get",
    "use", "using", "via", "into", "out", "up", "down", "then", "than",
})

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _stem(word: str) -> str:
    """Normalizes singular/plural by stripping a single trailing 's'."""
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _tokens(text: str) -> set[str]:
    out: set[str] = set()
    for w in _TOKEN_RE.findall((text or "").lower()):
        if len(w) <= 2 or w in _STOPWORDS:
            continue
        out.add(_stem(w))
    return out


class SkillRetriever:

    def __init__(self, store: SkillStore, weights: dict | None = None):
        self._store = store
        self._weights = weights or DEFAULT_WEIGHTS

    def keyword_search(
        self,
        capabilities: list[str],
        workflow: str,
        user_message: str,
        top_k: int = MAX_SKILLS_INJECTED,
    ) -> list[Skill]:
        """Performs weighted relevance search for skills matching capability, workflow, trigger, and context."""
        proven = self._store.get_proven()
        if not proven:
            return []

        msg_lower = user_message.lower()
        msg_tokens = _tokens(user_message)
        cap_set = set(capabilities)

        # Precompute tokens and document frequencies for IDF weighting.
        skill_tokens: dict[str, set[str]] = {}
        doc_freq: dict[str, int] = {}
        for skill in proven:
            toks = _tokens(skill.name.replace("_", " ").replace("-", " "))
            for t in skill.triggers:
                toks |= _tokens(t)
            for g in skill.guidance + skill.negative_guidance:
                toks |= _tokens(g)
            skill_tokens[skill.name] = toks
            for t in toks:
                doc_freq[t] = doc_freq.get(t, 0) + 1

        n_docs = len(proven)

        def _idf(token: str) -> float:
            # Smoothed IDF: common-to-all tokens → ~1.0, rare tokens → higher.
            return math.log((n_docs + 1) / (doc_freq.get(token, 0) + 1)) + 1.0

        scored: list[tuple[float, Skill]] = []

        for skill in proven:
            # Capability overlap: |intersection| / |union|
            skill_caps = set(skill.capabilities)
            union = cap_set | skill_caps
            cap_score = len(cap_set & skill_caps) / len(union) if union else 0.0

            # Workflow match: 1.0 if exact, 0.0 otherwise
            wf_score = 1.0 if skill.workflow == workflow else 0.0

            # Trigger match: stem-aware token overlap OR raw substring (the
            # latter keeps multi-word triggers like "send email" working).
            trigger_hits = 0
            for t in skill.triggers:
                if (_tokens(t) & msg_tokens) or (t.lower() in msg_lower):
                    trigger_hits += 1
            trig_score = (
                trigger_hits / len(skill.triggers) if skill.triggers else 0.0
            )

            # Context similarity: IDF-weighted overlap between the message and
            # the skill's own vocabulary (name + triggers + guidance).
            stoks = skill_tokens[skill.name]
            if stoks:
                shared = stoks & msg_tokens
                denom = sum(_idf(t) for t in stoks)
                ctx_score = (
                    sum(_idf(t) for t in shared) / denom if denom else 0.0
                )
            else:
                ctx_score = 0.0

            # Weighted applicability (Rule 4 — configurable weights)
            w = self._weights
            applicability = (
                w["capability"] * cap_score
                + w["workflow"] * wf_score
                + w["trigger"] * trig_score
                + w["context"] * ctx_score
            )

            # Final rank: applicability × effective_rate × recency. effective_rate
            # is the cold-start-aware estimate (see _effective_rate), so a new
            # candidate gets a fair trial without dominating proven skills.
            effective_rate = self._effective_rate(skill)
            recency = self._recency_factor(skill.updated_at)
            final_score = applicability * effective_rate * recency
            scored.append((final_score, skill))

        # Highest score first, then apply the injection policy (proven-first,
        # bounded experimental trial for unproven). The policy — not a raw
        # top-k slice — decides what is actually injected.
        scored.sort(key=lambda x: x[0], reverse=True)
        return self._select_for_injection(scored, top_k)

    @staticmethod
    def _effective_rate(skill: "Skill") -> float:
        """Calculates cold-start-aware success estimate (Beta-Bernoulli posterior mean)."""
        k0 = COLD_START_PRIOR_STRENGTH
        m0 = COLD_START_PRIOR_MEAN
        return (k0 * m0 + skill.uses * skill.success_rate) / (k0 + skill.uses)

    def _select_for_injection(
        self, scored: list[tuple[float, "Skill"]], top_k: int
    ) -> list["Skill"]:
        """Applies injection policy to filter scored skills."""
        results: list["Skill"] = []
        trial_used = 0
        for score, skill in scored:
            if score <= MIN_RELEVANCE_SCORE:
                continue
            trusted = (
                skill.status == "proven"
                and skill.success_rate >= MIN_CONFIDENCE_FOR_INJECTION
            )
            if not trusted:
                if trial_used >= TRIAL_INJECTION_BUDGET:
                    continue
                trial_used += 1
            results.append(skill)
            if len(results) >= top_k:
                break
        return results

    def semantic_search(
        self, message: str, top_k: int = MAX_SKILLS_INJECTED,
    ) -> list[Skill]:
        """Delegates to keyword search for zero-dependency retrieval."""
        return self.keyword_search(
            capabilities=[], workflow="general",
            user_message=message, top_k=top_k,
        )

    @staticmethod
    def _recency_factor(updated_at: str) -> float:
        """Calculates recency decay factor."""
        if not updated_at:
            return 0.5
        try:
            updated = datetime.fromisoformat(updated_at)
            if updated.tzinfo is None:
                updated = updated.replace(tzinfo=timezone.utc)
            age_days = (datetime.now(timezone.utc) - updated).days
            return max(0.5, 1.0 - (age_days / 180.0))
        except (ValueError, TypeError):
            return 0.5


def format_skill_hints(skills: list[Skill], max_tokens: int = MAX_SKILL_TOKENS) -> str:
    """Formats proven skills as compact prompt hints."""
    if not skills:
        return ""

    lines = ["PROVEN PATTERNS:"]
    total_len = len(lines[0])

    for skill in skills:
        # Proven skills show their success rate; unproven (trial) skills are
        # labelled so the model treats them as experimental, not battle-tested.
        if skill.status == "proven":
            tag = f"{skill.success_rate:.0%}"
        else:
            tag = "trial"
        guidance_text = ". ".join(skill.guidance[:2])
        neg_text = ""
        if skill.negative_guidance:
            neg_text = f"\n  ⚠ {skill.negative_guidance[0]}"

        entry = f"• {skill.name} ({tag}): {guidance_text}{neg_text}"

        # Approximate token count (~4 chars per token)
        entry_tokens = len(entry) // 4
        if total_len // 4 + entry_tokens > max_tokens:
            break

        lines.append(entry)
        total_len += len(entry)

    return "\n".join(lines) if len(lines) > 1 else ""


# Track failure patterns for the >= 2 gate
_failure_tracker: dict[str, int] = {}  # pattern_key → count
_reflection_cooldowns: dict[str, float] = {}  # pattern_key → last_reflection_ts


def _failure_key(error_msg: str) -> str:
    return re.sub(r"\s+", " ", error_msg.lower().strip())[:150]


def track_failure(error_msg: str) -> bool:
    """Tracks a failure and returns True if reflection should trigger."""
    key = _failure_key(error_msg)
    _failure_tracker[key] = _failure_tracker.get(key, 0) + 1

    if _failure_tracker[key] < 2:
        return False  # Single failure — log only, no reflection

    # Check cooldown
    last_ts = _reflection_cooldowns.get(key, 0.0)
    if time.time() - last_ts < REFLECTION_COOLDOWN_S:
        return False  # Cooldown active — skip

    _reflection_cooldowns[key] = time.time()
    return True


def clear_failure_tracker() -> None:
    _failure_tracker.clear()
    _reflection_cooldowns.clear()


_TELEMETRY_DIR = Path.home() / ".proxima" / "telemetry"

# Hard cap on telemetry records kept on disk.
_MAX_TELEMETRY_RECORDS = 5000


def log_classification(
    user_message: str,
    classification: dict,
    prompt_tier: str,
    prompt_rebuilt: bool,
    skills_injected: list[str] | None = None,
) -> None:
    """Logs a classification event to telemetry."""
    _TELEMETRY_DIR.mkdir(parents=True, exist_ok=True)
    log_file = _TELEMETRY_DIR / "classifier.jsonl"

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "user_message": user_message[:200],
        "predicted_caps": classification.get("capabilities", []),
        "predicted_workflow": classification.get("workflow", "general"),
        "confidence": classification.get("confidence", 0.0),
        "reasoning": classification.get("reasoning", ""),
        "suggested_context": classification.get("suggested_context", []),
        "prompt_tier": prompt_tier,
        "prompt_rebuilt": prompt_rebuilt,
        "skills_injected": skills_injected or [],
        "actual_tools_used": None,  # backfilled
        "success": None,  # backfilled
        "reflection_triggered": False,  # backfilled
    }

    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as e:
        logger.debug("Telemetry write failed: %s", e)


def backfill_telemetry(
    actual_tools: list[str],
    success: bool,
    reflection_triggered: bool = False,
) -> None:
    """Backfills the last telemetry entry with actual results."""
    log_file = _TELEMETRY_DIR / "classifier.jsonl"
    if not log_file.exists():
        return

    try:
        lines = log_file.read_text(encoding="utf-8").strip().split("\n")
        if not lines:
            return

        last_entry = json.loads(lines[-1])
        last_entry["actual_tools_used"] = actual_tools
        last_entry["success"] = success
        last_entry["reflection_triggered"] = reflection_triggered
        lines[-1] = json.dumps(last_entry)

        # Bound the file on this (already-required) rewrite so it can never grow
        # without limit on a long-lived install.
        if len(lines) > _MAX_TELEMETRY_RECORDS:
            lines = lines[-_MAX_TELEMETRY_RECORDS:]

        log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError) as e:
        logger.debug("Telemetry backfill failed: %s", e)


def analyze_telemetry(max_records: int = _MAX_TELEMETRY_RECORDS) -> dict:
    """Analyzes telemetry log metrics for regex and skill performance."""
    log_file = _TELEMETRY_DIR / "classifier.jsonl"
    empty = {"total": 0, "analyzed_records": 0}
    try:
        if not log_file.exists():
            return empty
        raw = log_file.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return empty
    if not raw:
        return empty

    records = []
    for ln in raw.split("\n")[-max_records:]:
        ln = ln.strip()
        if not ln:
            continue
        try:
            records.append(json.loads(ln))
        except json.JSONDecodeError:
            continue

    total = len(records)
    if total == 0:
        return empty

    rebuilds = 0
    tier_dist: dict[str, int] = {}
    wf_dist: dict[str, int] = {}
    tp = fp = fn = 0          # capability prediction confusion (backfilled only)
    analyzed = 0
    s_with = s_with_ok = 0    # success with skills injected
    s_wo = s_wo_ok = 0        # success without skills injected

    for r in records:
        if r.get("prompt_rebuilt"):
            rebuilds += 1
        tier = r.get("prompt_tier", "?")
        tier_dist[tier] = tier_dist.get(tier, 0) + 1
        wf = r.get("predicted_workflow", "general")
        wf_dist[wf] = wf_dist.get(wf, 0) + 1

        actual = r.get("actual_tools_used")
        if actual is not None:
            analyzed += 1
            pred = set(r.get("predicted_caps") or [])
            act = set(actual)
            tp += len(pred & act)
            fp += len(pred - act)
            fn += len(act - pred)

        success = r.get("success")
        if success is not None:
            if r.get("skills_injected"):
                s_with += 1
                s_with_ok += 1 if success else 0
            else:
                s_wo += 1
                s_wo_ok += 1 if success else 0

    def _ratio(num, den):
        return round(num / den, 3) if den else None

    precision = _ratio(tp, tp + fp)
    recall = _ratio(tp, tp + fn)
    with_rate = _ratio(s_with_ok, s_with)
    wo_rate = _ratio(s_wo_ok, s_wo)
    lift = (round(with_rate - wo_rate, 3)
            if (with_rate is not None and wo_rate is not None) else None)

    return {
        "total": total,
        "analyzed_records": analyzed,
        "prompt_rebuild_rate": _ratio(rebuilds, total),
        "tier_distribution": tier_dist,
        "workflow_distribution": wf_dist,
        "capability_precision": precision,
        "capability_recall": recall,
        "skill_injection": {
            "with_skills_success_rate": with_rate,
            "without_skills_success_rate": wo_rate,
            "lift": lift,
        },
    }
