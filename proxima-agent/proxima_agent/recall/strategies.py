"""Proxima — Strategy Store.
Manages local task execution strategies and records performance history.
"""
from __future__ import annotations

import json
import os
import time
import hashlib
import contextlib
from abc import ABC, abstractmethod
from typing import Optional


@contextlib.contextmanager
def _file_lock(target_path: str, timeout: float = 5.0):
    """Provides cross-process advisory file locking."""
    lock_path = target_path + ".lock"
    f = None
    acquired = False
    try:
        f = open(lock_path, "a+")
        f.seek(0)
        deadline = time.time() + timeout
        if os.name == "nt":
            import msvcrt
            while time.time() < deadline:
                try:
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                    acquired = True
                    break
                except OSError:
                    time.sleep(0.05)
        else:
            import fcntl
            while time.time() < deadline:
                try:
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                    break
                except OSError:
                    time.sleep(0.05)
    except Exception:
        pass
    try:
        yield
    finally:
        if f is not None:
            try:
                if acquired:
                    if os.name == "nt":
                        import msvcrt
                        f.seek(0)
                        try:
                            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
                        except OSError:
                            pass
                    else:
                        import fcntl
                        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            finally:
                try:
                    f.close()
                except Exception:
                    pass


def _resolve_data_dir() -> str:
    """Resolves writable data directory path."""
    base = os.environ.get("PROXIMA_DATA_DIR") or os.path.join(
        os.path.expanduser("~"), ".proxima-agent"
    )
    os.makedirs(base, exist_ok=True)
    return base


def _make_id(trigger: str, strategy: str) -> str:
    """Generates deterministic ID from trigger and strategy content."""
    content = f"{trigger}|{strategy}"
    return hashlib.sha256(content.encode()).hexdigest()[:12]


class StrategyRetriever(ABC):
    """Base class for task strategy retrievers."""

    @abstractmethod
    def find(self, query: str, strategies: list[dict], top_k: int = 3) -> list[dict]:
        """Finds strategies matching a query."""
        ...


class KeywordRetriever(StrategyRetriever):
    """Keyword-based task strategy retriever."""

    def find(self, query: str, strategies: list[dict], top_k: int = 3) -> list[dict]:
        query_words = set(query.lower().split())
        scored = []
        for strategy in strategies:
            trigger_words = set(strategy.get("trigger", "").lower().split())
            tag_words = set(
                word.lower()
                for tag in strategy.get("tags", [])
                for word in tag.split()
            )
            all_words = trigger_words | tag_words
            overlap = len(query_words & all_words)
            if overlap > 0:
                success_rate = strategy.get("success_rate", 0.5)
                recency_bonus = min(
                    0.2,
                    0.2 * (1 - (time.time() - strategy.get("last_used", 0)) / (86400 * 30))
                )
                score = overlap + success_rate + max(0, recency_bonus)
                scored.append((score, strategy))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [s for _, s in scored[:top_k]]


class StrategyStore:
    """Saves and updates task execution strategies on disk."""

    def __init__(self, retriever: Optional[StrategyRetriever] = None):
        self._data_dir = _resolve_data_dir()
        self._file = os.path.join(self._data_dir, "strategies.json")
        self._retriever = retriever or KeywordRetriever()
        self._strategies: Optional[list[dict]] = None

    def _load(self) -> list[dict]:
        """Loads strategies from disk cache."""
        if self._strategies is not None:
            return self._strategies
        try:
            with open(self._file, "r", encoding="utf-8") as f:
                self._strategies = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            self._strategies = []
        return self._strategies

    def _load_fresh(self) -> list[dict]:
        """Reads strategies directly from file bypassing cache."""
        try:
            with open(self._file, "r", encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return []

    def _save(self):
        """Persists strategies to file atomically."""
        data = self._strategies or []
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

    def save(
        self,
        trigger: str,
        strategy: str,
        success_rate: float = 1.0,
        tags: Optional[list[str]] = None,
    ) -> str:
        """Saves a new strategy or updates stats for an existing one."""
        with _file_lock(self._file):
            strategies = self._load_fresh()
            strategy_id = _make_id(trigger, strategy)

            for existing in strategies:
                if existing.get("id") == strategy_id:
                    existing["success_rate"] = success_rate
                    existing["last_used"] = time.time()
                    existing["use_count"] = existing.get("use_count", 0) + 1
                    if tags:
                        existing["tags"] = list(set(existing.get("tags", []) + tags))
                    self._strategies = strategies
                    self._save()
                    return strategy_id

            entry = {
                "id": strategy_id,
                "trigger": trigger,
                "strategy": strategy,
                "success_rate": success_rate,
                "tags": tags or [],
                "created": time.time(),
                "last_used": time.time(),
                "use_count": 1,
            }
            strategies.append(entry)
            self._strategies = strategies
            self._save()
            return strategy_id

    def find(self, query: str, top_k: int = 3) -> list[dict]:
        """Finds matching strategies using the configured retriever."""
        strategies = self._load()
        if not strategies:
            return []
        return self._retriever.find(query, strategies, top_k)

    def update_score(self, strategy_id: str, success: bool):
        """Updates strategy success rate statistics."""
        with _file_lock(self._file):
            strategies = self._load_fresh()
            for entry in strategies:
                if entry.get("id") == strategy_id:
                    old_rate = entry.get("success_rate", 0.5)
                    outcome = 1.0 if success else 0.0
                    entry["success_rate"] = round(0.7 * old_rate + 0.3 * outcome, 3)
                    entry["last_used"] = time.time()
                    entry["use_count"] = entry.get("use_count", 0) + 1
                    self._strategies = strategies
                    self._save()
                    return

    def all(self) -> list[dict]:
        """Returns list copy of all saved strategies."""
        return self._load().copy()

    def delete(self, strategy_id: str) -> bool:
        """Deletes a strategy by ID."""
        with _file_lock(self._file):
            strategies = self._load_fresh()
            before = len(strategies)
            self._strategies = [s for s in strategies if s.get("id") != strategy_id]
            if len(self._strategies) < before:
                self._save()
                return True
            return False

    def stats(self) -> dict:
        """Returns strategy store summary statistics."""
        strategies = self._load()
        if not strategies:
            return {"total": 0}
        rates = [s.get("success_rate", 0) for s in strategies]
        return {
            "total": len(strategies),
            "avg_success_rate": round(sum(rates) / len(rates), 3),
            "most_used": max(strategies, key=lambda s: s.get("use_count", 0))["trigger"],
        }


strategies = StrategyStore()
