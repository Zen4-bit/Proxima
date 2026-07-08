"""Tests for proxima_agent.tools.snapshots — recoverable local-state checkpoints.

In-memory store (namespace shallow-copy + cwd/env capture). os.chdir/os.environ
side effects during restore are benign here because we snapshot and restore in
the same working state. Covers save/restore round-trip, dunder skipping,
capacity eviction, update-in-place, delete/list/exists/clear.
"""
import os
import unittest

from proxima_agent.tools.snapshots import SnapshotStore


class TestSnapshotStore(unittest.TestCase):
    def setUp(self):
        self.store = SnapshotStore(max_snapshots=3)

    def test_save_and_restore_round_trip(self):
        ns = {"x": 1, "items": [1, 2, 3], "__builtins__": {}}
        self.store.save("cp1", ns)
        # Mutate the live namespace after the snapshot.
        ns["x"] = 999
        ns["new_var"] = "added"
        restored = self.store.restore("cp1", ns)
        self.assertEqual(restored["x"], 1)          # rolled back
        self.assertNotIn("new_var", restored)        # added var removed
        self.assertEqual(restored["items"], [1, 2, 3])

    def test_dunders_are_skipped_in_snapshot_but_preserved_on_restore(self):
        marker = object()
        ns = {"__builtins__": marker, "a": 5}
        self.store.save("cp", ns)
        snap = self.store._snapshots["cp"]
        self.assertNotIn("__builtins__", snap.namespace)  # not copied
        ns["a"] = 10
        restored = self.store.restore("cp", ns)
        self.assertIs(restored["__builtins__"], marker)   # live dunder preserved

    def test_capacity_eviction_of_oldest(self):
        for i in range(4):  # max is 3
            self.store.save(f"cp{i}", {"v": i})
        names = [s.name for s in self.store.list()]
        self.assertEqual(len(names), 3)
        self.assertNotIn("cp0", names)  # oldest evicted
        self.assertIn("cp3", names)

    def test_update_in_place_does_not_evict_unrelated(self):
        self.store.save("a", {"v": 1})
        self.store.save("b", {"v": 2})
        self.store.save("c", {"v": 3})
        # Updating an existing snapshot must not push out another.
        self.store.save("a", {"v": 99})
        self.assertEqual(len(self.store), 3)
        self.assertTrue(self.store.exists("b"))

    def test_restore_missing_raises_keyerror(self):
        with self.assertRaises(KeyError):
            self.store.restore("nope", {})

    def test_delete_and_clear(self):
        self.store.save("a", {"v": 1})
        self.assertTrue(self.store.delete("a"))
        self.assertFalse(self.store.delete("a"))
        self.store.save("b", {"v": 2})
        self.store.clear()
        self.assertEqual(len(self.store), 0)

    def test_uncopyable_object_stored_by_reference(self):
        # A generator can't be copy.copy()'d cleanly for restore semantics but
        # must not crash save — it's stored by reference.
        class NoCopy:
            def __copy__(self):
                raise TypeError("cannot copy")
        obj = NoCopy()
        ns = {"handle": obj}
        self.store.save("cp", ns)
        self.assertIs(self.store._snapshots["cp"].namespace["handle"], obj)


if __name__ == "__main__":
    unittest.main()
