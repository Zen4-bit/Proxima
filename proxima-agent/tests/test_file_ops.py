"""Tests for proxima_agent.tools.coding.file_ops — file read/write/edit helpers.

Real temp files (no mocks needed — these are local FS helpers). Covers
line-numbered vs raw read, atomic write + round-trip, exact & flexible edit,
insert/delete/append, multi-edit patch, copy/move, and graceful failure
strings for missing paths.
"""
import os
import tempfile
import unittest

from proxima_agent.tools.coding import file_ops


class FileOpsBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _path(self, name):
        return os.path.join(self.tmp, name)

    def _write(self, name, content):
        p = self._path(name)
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return p


class TestRead(FileOpsBase):
    def test_read_adds_line_numbers(self):
        p = self._write("a.txt", "alpha\nbeta\n")
        out = file_ops.read_file(p)
        self.assertIn("   1 | alpha", out)
        self.assertIn("   2 | beta", out)

    def test_read_raw_is_exact(self):
        p = self._write("a.json", '{"k": 1}')
        self.assertEqual(file_ops.read_file_raw(p), '{"k": 1}')

    def test_read_line_range(self):
        p = self._write("a.txt", "l1\nl2\nl3\nl4\n")
        out = file_ops.read_file(p, 2, 3, raw=True)
        self.assertEqual(out, "l2\nl3\n")

    def test_read_missing_returns_error_string(self):
        out = file_ops.read_file(self._path("missing.txt"))
        self.assertIn("Cannot read", out)


class TestWrite(FileOpsBase):
    def test_write_creates_and_round_trips(self):
        p = self._path("sub/new.txt")
        msg = file_ops.write_file(p, "hello")
        self.assertIn("Written", msg)
        self.assertEqual(file_ops.read_file_raw(p), "hello")

    def test_write_preserves_crlf_of_existing_file(self):
        p = self._write("crlf.txt", "a\r\nb\r\n")
        file_ops.write_file(p, "x\ny\n")
        with open(p, "rb") as f:
            raw = f.read()
        self.assertIn(b"\r\n", raw)  # CRLF style preserved


class TestEdit(FileOpsBase):
    def test_exact_replace(self):
        p = self._write("a.txt", "foo bar")
        msg = file_ops.edit_file(p, "bar", "baz")
        self.assertIn("Replaced 1", msg)
        self.assertEqual(file_ops.read_file_raw(p), "foo baz")

    def test_replace_all(self):
        p = self._write("a.txt", "x x x")
        file_ops.edit_file(p, "x", "y", count=0)
        self.assertEqual(file_ops.read_file_raw(p), "y y y")

    def test_flexible_fallback_on_indentation(self):
        p = self._write("a.py", "def f():\n    return old\n")
        msg = file_ops.edit_file(p, "return old", "return new")
        self.assertIn("Replaced 1", msg)
        self.assertIn("    return new", file_ops.read_file_raw(p))

    def test_not_found_returns_error(self):
        p = self._write("a.txt", "hello")
        msg = file_ops.edit_file(p, "absent", "x")
        self.assertIn("Not found", msg)


class TestLineOps(FileOpsBase):
    def test_insert_lines(self):
        p = self._write("a.txt", "l1\nl2\n")
        file_ops.insert_lines(p, 2, "inserted")
        self.assertEqual(file_ops.read_file_raw(p), "l1\ninserted\nl2\n")

    def test_delete_lines(self):
        p = self._write("a.txt", "l1\nl2\nl3\nl4\n")
        file_ops.delete_lines(p, 2, 3)
        self.assertEqual(file_ops.read_file_raw(p), "l1\nl4\n")

    def test_append_file(self):
        p = self._write("a.txt", "start\n")
        file_ops.append_file(p, "more\n")
        self.assertEqual(file_ops.read_file_raw(p), "start\nmore\n")


class TestPatch(FileOpsBase):
    def test_multiple_edits_apply_sequentially(self):
        p = self._write("a.txt", "one two three")
        out = file_ops.patch_file(p, [
            {"old": "one", "new": "1"},
            {"old": "three", "new": "3"},
        ])
        self.assertIn("✓", out)
        self.assertEqual(file_ops.read_file_raw(p), "1 two 3")

    def test_patch_reports_missing_edit(self):
        p = self._write("a.txt", "hello")
        out = file_ops.patch_file(p, [{"old": "absent", "new": "x"}])
        self.assertIn("Not found", out)


class TestCopyMove(FileOpsBase):
    def test_copy_file(self):
        src = self._write("src.txt", "data")
        dst = self._path("dst.txt")
        file_ops.copy_file(src, dst)
        self.assertEqual(file_ops.read_file_raw(dst), "data")

    def test_move_file(self):
        src = self._write("src.txt", "data")
        dst = self._path("moved.txt")
        file_ops.move_file(src, dst)
        self.assertFalse(os.path.exists(src))
        self.assertEqual(file_ops.read_file_raw(dst), "data")

    def test_copy_missing_source_returns_error(self):
        out = file_ops.copy_file(self._path("nope.txt"), self._path("out.txt"))
        self.assertIn("Copy failed", out)


if __name__ == "__main__":
    unittest.main()
