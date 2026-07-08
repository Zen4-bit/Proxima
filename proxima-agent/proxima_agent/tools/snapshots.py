"""Proxima — Execution Snapshots.
Captures and restores local execution state checkpoints.
"""
from __future__ import annotations

import os
import copy
import time
from typing import Any, Optional


class Snapshot:
    """Represents a captured execution state."""
    __slots__ = ("name", "namespace", "cwd", "env_vars", "created_at", "turn_index")

    def __init__(self, name: str, namespace: dict, cwd: str,
                 env_vars: dict, turn_index: int = 0):
        self.name = name
        self.namespace = namespace
        self.cwd = cwd
        self.env_vars = env_vars
        self.created_at = time.time()
        self.turn_index = turn_index

    def __repr__(self) -> str:
        age = time.time() - self.created_at
        ns_count = len(self.namespace)
        return (
            f"Snapshot('{self.name}', {ns_count} vars, "
            f"turn={self.turn_index}, {age:.0f}s ago)"
        )


class SnapshotStore:
    """Manages execution state snapshots."""

    def __init__(self, max_snapshots: int = 10):
        self._snapshots: dict[str, Snapshot] = {}
        self._max = max(1, max_snapshots)
        self._creation_order: list[str] = []

    def save(self, name: str, namespace: dict,
             turn_index: int = 0) -> Snapshot:
        """Captures and saves a snapshot of the current execution state."""
        is_update = name in self._snapshots
        if not is_update:
            while len(self._snapshots) >= self._max and self._creation_order:
                oldest = self._creation_order.pop(0)
                self._snapshots.pop(oldest, None)

        ns_copy = {}
        for key, val in namespace.items():
            if key.startswith("__") and key.endswith("__"):
                continue
            try:
                ns_copy[key] = copy.copy(val)
            except Exception:
                ns_copy[key] = val

        snapshot = Snapshot(
            name=name,
            namespace=ns_copy,
            cwd=os.getcwd(),
            env_vars=dict(os.environ),
            turn_index=turn_index,
        )

        if is_update:
            self._creation_order.remove(name)

        self._snapshots[name] = snapshot
        self._creation_order.append(name)
        return snapshot

    def restore(self, name: str, namespace: dict) -> dict:
        """Restores namespace to a previous snapshot."""
        if name not in self._snapshots:
            available = ", ".join(self._snapshots.keys()) or "(none)"
            raise KeyError(
                f"Snapshot '{name}' not found. Available: {available}"
            )

        snapshot = self._snapshots[name]

        try:
            os.chdir(snapshot.cwd)
        except Exception:
            pass

        try:
            snap_env = snapshot.env_vars
            for key in [k for k in os.environ if k not in snap_env]:
                del os.environ[key]
            for key, value in snap_env.items():
                if os.environ.get(key) != value:
                    os.environ[key] = value
        except Exception:
            pass

        dunders = {k: v for k, v in namespace.items()
                   if k.startswith("__") and k.endswith("__")}

        namespace.clear()
        namespace.update(dunders)
        namespace.update(snapshot.namespace)

        return namespace

    def delete(self, name: str) -> bool:
        """Deletes a snapshot."""
        if name in self._snapshots:
            del self._snapshots[name]
            self._creation_order.remove(name)
            return True
        return False

    def list(self) -> list[Snapshot]:
        """Lists all available snapshots oldest first."""
        return [self._snapshots[name] for name in self._creation_order
                if name in self._snapshots]

    def exists(self, name: str) -> bool:
        """Checks if a snapshot exists."""
        return name in self._snapshots

    def clear(self):
        """Deletes all snapshots."""
        self._snapshots.clear()
        self._creation_order.clear()

    def __len__(self) -> int:
        return len(self._snapshots)

    def __repr__(self) -> str:
        return f"SnapshotStore({len(self._snapshots)} snapshots)"


snapshots = SnapshotStore()
