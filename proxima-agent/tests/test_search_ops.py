"""Tests for proxima_agent.tools.coding.search_ops — search + FS exploration.

Real temp directory trees. Covers text/regex search (+ invalid-regex guard,
include filter, excluded dirs), find_replace (dry-run default, apply, max_files
cap), glob, file_stats, dir_tree, list_dir.
"""
import os
import tempfile
import unittest

from proxima_agent.tools.coding import search_ops


class SearchBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _write(self, rel, content):
        p = os.path.join(self.tmp, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return p


class TestSearchText(SearchBase):
    def test_finds_plain_text_with_context(self):
        self._write("a.py", "line1\nTODO fix this\nline3\n")
        out = search_ops.search_text("TODO", path=self.tmp)
        self.assertIn("TODO fix this", out)
        self.assertIn("a.py", out)

    def test_regex_search(self):
        self._write("a.py", "def init():\n    pass\n")
        out = search_ops.search_text(r"def \w+", path=self.tmp, regex=True)
        self.assertIn("def init", out)

    def test_invalid_regex_returns_error(self):
        out = search_ops.search_text("(", path=self.tmp, regex=True)
        self.assertIn("Invalid regex", out)

    def test_include_filter_limits_files(self):
        self._write("a.py", "needle here")
        self._write("b.txt", "needle here")
        out = search_ops.search_text("needle", path=self.tmp, include="*.py")
        self.assertIn("a.py", out)
        self.assertNotIn("b.txt", out)

    def test_no_matches_message(self):
        self._write("a.py", "nothing")
        out = search_ops.search_text("zzz", path=self.tmp)
        self.assertIn("No matches", out)


class TestFindReplace(SearchBase):
    def test_dry_run_is_default_and_writes_nothing(self):
        p = self._write("a.py", "old old old")
        out = search_ops.find_replace("old", "new", path=self.tmp, include="*.py")
        self.assertIn("DRY RUN", out)
        # File untouched.
        with open(p) as f:
            self.assertEqual(f.read(), "old old old")

    def test_apply_writes_changes(self):
        p = self._write("a.py", "old value")
        search_ops.find_replace("old", "new", path=self.tmp, include="*.py", dry_run=False)
        with open(p) as f:
            self.assertEqual(f.read(), "new value")

    def test_max_files_cap_aborts_without_writing(self):
        for i in range(3):
            self._write(f"f{i}.py", "target")
        out = search_ops.find_replace("target", "x", path=self.tmp, include="*.py",
                                      dry_run=False, max_files=2)
        self.assertIn("Aborted", out)
        # Nothing changed.
        with open(os.path.join(self.tmp, "f0.py")) as f:
            self.assertEqual(f.read(), "target")

    def test_no_matches(self):
        self._write("a.py", "hello")
        out = search_ops.find_replace("absent", "x", path=self.tmp)
        self.assertIn("No matches", out)


class TestGlobAndStats(SearchBase):
    def test_glob_files(self):
        self._write("src/a.py", "x")
        self._write("src/b.py", "y")
        out = search_ops.glob_files("**/*.py", path=self.tmp)
        self.assertIn("a.py", out)
        self.assertIn("b.py", out)

    def test_file_stats_for_file(self):
        p = self._write("a.txt", "l1\nl2\n")
        out = search_ops.file_stats(p)
        self.assertIn("Lines: 2", out)

    def test_file_stats_for_directory(self):
        self._write("a.txt", "x")
        out = search_ops.file_stats(self.tmp)
        self.assertIn("Directory:", out)

    def test_file_stats_missing(self):
        out = search_ops.file_stats(os.path.join(self.tmp, "nope"))
        self.assertIn("Not found", out)

    def test_dir_tree_and_list_dir(self):
        self._write("sub/a.py", "x")
        tree = search_ops.dir_tree(self.tmp, depth=2)
        self.assertIn("sub", tree)
        listing = search_ops.list_dir(self.tmp)
        self.assertIn("sub", listing)


class TestAliases(unittest.TestCase):
    def test_grep_and_find_files_aliases_exist(self):
        self.assertIs(search_ops.search, search_ops.search_text)
        self.assertIs(search_ops.find_files, search_ops.glob_files)
        # grep accepts (and ignores) recursive= without crashing.
        self.assertTrue(callable(search_ops.grep))


if __name__ == "__main__":
    unittest.main()
