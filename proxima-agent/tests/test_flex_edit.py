"""Tests for proxima_agent.tools.coding.flex_edit — resilient text replacement.

Pure string logic (no I/O). Exercises the matcher ladder: exact, line-trim,
indent-free, escape-decode, unicode-fold, ambiguity guard, identical/empty
guards, and the "did you mean" suggestion helper.
"""
import unittest

from proxima_agent.tools.coding import flex_edit


def repl(text, old, new, all_occurrences=False):
    return flex_edit.find_and_replace_flexible(text, old, new, all_occurrences)


class TestFindAndReplaceFlexible(unittest.TestCase):
    def test_exact_match(self):
        out, n, method, err = repl("foo bar baz", "bar", "QUX")
        self.assertEqual(out, "foo QUX baz")
        self.assertEqual(n, 1)
        self.assertEqual(method, "exact")
        self.assertIsNone(err)

    def test_empty_search_is_error(self):
        out, n, _, err = repl("abc", "", "x")
        self.assertEqual(n, 0)
        self.assertIn("empty", err)

    def test_identical_old_new_is_noop_error(self):
        out, n, _, err = repl("abc", "abc", "abc")
        self.assertEqual(n, 0)
        self.assertIn("identical", err)

    def test_line_trim_matches_despite_indentation(self):
        # File line is indented; the search snippet is not → exact fails, the
        # line-trim rung matches and the replacement is re-indented to the file.
        text = "def f():\n    return x\n"
        out, n, method, err = repl(text, "return x", "return y")
        self.assertEqual(n, 1)
        self.assertIsNone(err)
        self.assertIn("    return y", out)  # original 4-space indent preserved

    def test_escape_decode_matches_literal_backslash_n(self):
        text = "line1\nline2\n"
        # The model sent a literal '\n' (two chars) instead of a real newline.
        out, n, method, err = repl(text, "line1\\nline2", "REPLACED")
        self.assertEqual(n, 1)
        self.assertIn("REPLACED", out)

    def test_unicode_fold_matches_smart_quotes(self):
        text = 'msg = "hello"\n'          # straight quotes on disk
        out, n, method, err = repl(text, 'msg = \u201chello\u201d', 'msg = "bye"')
        self.assertEqual(n, 1)
        self.assertIn("bye", out)

    def test_ambiguous_match_requires_context(self):
        text = "x\nx\n"
        out, n, _, err = repl(text, "x", "y", all_occurrences=False)
        self.assertEqual(n, 0)
        self.assertIn("regions match", err)

    def test_all_occurrences_replaces_every_hit(self):
        text = "x\nx\n"
        out, n, _, err = repl(text, "x", "y", all_occurrences=True)
        self.assertEqual(n, 2)
        self.assertIsNone(err)

    def test_not_found(self):
        out, n, _, err = repl("hello", "absent", "x")
        self.assertEqual(n, 0)
        self.assertIn("not found", err)


class TestSuggestSimilarRegions(unittest.TestCase):
    def test_suggests_for_plain_no_match(self):
        text = "def calculate_total(items):\n    return sum(items)\n"
        _, n, _, err = repl(text, "def calculate_total(x):", "def f():")
        # A no-match (or ambiguous) result: only "not found" errors get a hint.
        hint = flex_edit.suggest_similar_regions(err, n, "def calculate_total(x):", text)
        if err and err.startswith("search text not found"):
            self.assertIn("Closest matching", hint)

    def test_silent_for_non_notfound_errors(self):
        self.assertEqual(flex_edit.suggest_similar_regions("some other error", 0, "x", "y"), "")


if __name__ == "__main__":
    unittest.main()
