"""Proxima — Learned Fixes.
Records and retrieves successful recovery actions mapped to specific failure classes.
"""
from __future__ import annotations

import json
import os
import time
from typing import Optional


def _data_dir() -> str:
    base = os.environ.get("PROXIMA_DATA_DIR") or os.path.join(
        os.path.expanduser("~"), ".proxima-agent"
    )
    os.makedirs(base, exist_ok=True)
    return base


class LearnedFix:
    """Represents a recovery pattern that worked before."""
    __slots__ = (
        "failure_class", "tool", "recovery_action",
        "success_rate", "use_count", "last_used", "created",
    )

    def __init__(self, failure_class: str, tool: str,
                 recovery_action: str, success_rate: float = 1.0,
                 use_count: int = 1, last_used: float = 0,
                 created: float = 0):
        self.failure_class = failure_class
        self.tool = tool
        self.recovery_action = recovery_action
        self.success_rate = success_rate
        self.use_count = use_count
        self.last_used = last_used or time.time()
        self.created = created or time.time()

    def to_dict(self) -> dict:
        return {
            "failure_class": self.failure_class,
            "tool": self.tool,
            "recovery_action": self.recovery_action,
            "success_rate": self.success_rate,
            "use_count": self.use_count,
            "last_used": self.last_used,
            "created": self.created,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "LearnedFix":
        return cls(
            failure_class=d["failure_class"],
            tool=d["tool"],
            recovery_action=d["recovery_action"],
            success_rate=d.get("success_rate", 1.0),
            use_count=d.get("use_count", 1),
            last_used=d.get("last_used", 0),
            created=d.get("created", 0),
        )

    @property
    def key(self) -> str:
        """Returns unique key for the fix."""
        return f"{self.failure_class}:{self.tool}"

    def __repr__(self) -> str:
        return (
            f"LearnedFix({self.tool}:{self.failure_class}, "
            f"'{self.recovery_action}', {self.success_rate:.0%}, "
            f"used {self.use_count}x)"
        )


class LearnedFixStore:
    """Saves and updates recovery fixes on disk."""

    def __init__(self):
        self._file = os.path.join(_data_dir(), "learned_fixes.json")
        self._fixes: Optional[dict[str, LearnedFix]] = None

    def _load(self) -> dict[str, LearnedFix]:
        if self._fixes is not None:
            return self._fixes
        try:
            with open(self._file, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._fixes = {
                d["failure_class"] + ":" + d["tool"]: LearnedFix.from_dict(d)
                for d in data
            }
        except (FileNotFoundError, json.JSONDecodeError, KeyError):
            self._fixes = {}
        return self._fixes

    def _save(self):
        fixes = self._fixes or {}
        data = [fix.to_dict() for fix in fixes.values()]
        import os, tempfile
        _dir = os.path.dirname(self._file) or "."
        _fd, _tmp = tempfile.mkstemp(dir=_dir, suffix=".tmp")
        try:
            with os.fdopen(_fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(_tmp, self._file)
        except Exception:
            try:
                os.remove(_tmp)
            except OSError:
                pass
            raise

    def record_success(self, failure_class: str, tool: str,
                       recovery_action: str) -> LearnedFix:
        """Records a successful recovery pattern."""
        fixes = self._load()
        key = f"{failure_class}:{tool}"

        if key in fixes:
            existing = fixes[key]
            existing.use_count += 1
            existing.last_used = time.time()
            existing.success_rate = round(
                0.7 * existing.success_rate + 0.3 * 1.0, 3
            )
            if recovery_action != existing.recovery_action:
                existing.recovery_action = recovery_action
            self._save()
            return existing

        fix = LearnedFix(
            failure_class=failure_class,
            tool=tool,
            recovery_action=recovery_action,
        )
        fixes[key] = fix
        self._save()
        return fix

    def lookup(self, failure_class: str,
               tool: Optional[str] = None) -> Optional[LearnedFix]:
        """Finds a known fix for a failure class."""
        fixes = self._load()

        if tool:
            key = f"{failure_class}:{tool}"
            fix = fixes.get(key)
            if fix and fix.success_rate >= 0.3:
                return fix

        candidates = [
            f for f in fixes.values()
            if f.failure_class == failure_class and f.success_rate >= 0.3
        ]
        if candidates:
            return max(candidates, key=lambda f: f.success_rate)
        return None

    def update_outcome(self, failure_class: str, tool: str,
                       success: bool):
        """Updates success rate statistics for a fix."""
        fixes = self._load()
        key = f"{failure_class}:{tool}"
        if key not in fixes:
            return

        fix = fixes[key]
        outcome = 1.0 if success else 0.0
        fix.success_rate = round(0.7 * fix.success_rate + 0.3 * outcome, 3)
        fix.use_count += 1
        fix.last_used = time.time()
        self._save()

    def all(self) -> list[LearnedFix]:
        """Gets all learned fixes sorted by success rate."""
        fixes = self._load()
        return sorted(fixes.values(), key=lambda f: f.success_rate, reverse=True)

    def stats(self) -> dict:
        """Returns learned fixes stats."""
        fixes = self._load()
        if not fixes:
            return {"total": 0}
        rates = [f.success_rate for f in fixes.values()]
        total_uses = sum(f.use_count for f in fixes.values())
        return {
            "total_fixes": len(fixes),
            "total_applications": total_uses,
            "avg_success_rate": round(sum(rates) / len(rates), 3),
            "top_fix": max(fixes.values(), key=lambda f: f.use_count).key,
        }

    def clear(self):
        """Deletes all learned fixes."""
        self._fixes = {}
        self._save()


learned_fixes = LearnedFixStore()
