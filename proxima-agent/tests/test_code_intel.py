"""Tests for proxima_agent.tools.coding.code_intel — pure analysis paths.

Covers the paths that need NO external toolchain: Python syntax_check, AST-based
find_functions / get_imports, JSON/HTML/CSS validation inside lint(), and
diff_files. The subprocess-backed linters (ruff/eslint/tsc) and the Node JS
parser are runtime-bound and exercised by their own tools; the Python AST paths
are self-sufficient (no subprocess) so they're covered here.
"""
import os
import tempfile
import unittest

from proxima_agent.tools.coding import code_intel


class CodeIntelBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _write(self, name, content):
        p = os.path.join(self.tmp, name)
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return p


class TestSyntaxCheck(CodeIntelBase):
    def test_clean_python(self):
        p = self._write("ok.py", "def f():\n    return 1\n")
        self.assertIn("No syntax errors", code_intel.syntax_check(p))

    def test_syntax_error_reported(self):
        p = self._write("bad.py", "def f(:\n    pass\n")
        out = code_intel.syntax_check(p)
        self.assertIn("Syntax error", out)


class TestFindFunctions(CodeIntelBase):
    def test_lists_functions_and_classes_via_ast(self):
        src = "class A:\n    def m(self):\n        pass\n\nasync def go():\n    pass\n"
        p = self._write("mod.py", src)
        out = code_intel.find_functions(p)
        self.assertIn("class A", out)
        self.assertIn("def m", out)
        self.assertIn("async def go", out)

    def test_no_functions(self):
        p = self._write("empty.py", "x = 1\n")
        self.assertIn("No functions", code_intel.find_functions(p))


class TestGetImports(CodeIntelBase):
    def test_lists_imports_via_ast(self):
        src = "import os\nfrom pathlib import Path as P\nfrom . import sibling\n"
        p = self._write("mod.py", src)
        out = code_intel.get_imports(p)
        self.assertIn("import os", out)
        self.assertIn("from pathlib import Path as P", out)
        self.assertIn("from . import sibling", out)


class TestLint(CodeIntelBase):
    def test_valid_json(self):
        p = self._write("d.json", '{"a": 1}')
        self.assertIn("Valid JSON", code_intel.lint(p))

    def test_invalid_json(self):
        p = self._write("d.json", '{"a": }')
        self.assertIn("Invalid JSON", code_intel.lint(p))

    def test_html_missing_tags_flagged(self):
        p = self._write("page.html", "<div>hello</div>")
        out = code_intel.lint(p)
        self.assertIn("Missing <html>", out)

    def test_html_ok(self):
        p = self._write("page.html", "<html><head></head><body>hi</body></html>")
        self.assertIn("HTML looks OK", code_intel.lint(p))

    def test_css_brace_mismatch(self):
        p = self._write("s.css", "a { color: red; ")
        out = code_intel.lint(p)
        self.assertIn("Mismatched braces", out)

    def test_missing_file(self):
        self.assertIn("File not found", code_intel.lint(os.path.join(self.tmp, "nope.py")))


class TestDiffFiles(CodeIntelBase):
    def test_shows_differences(self):
        a = self._write("a.txt", "line1\nline2\n")
        b = self._write("b.txt", "line1\nCHANGED\n")
        out = code_intel.diff_files(a, b)
        self.assertIn("-line2", out)
        self.assertIn("+CHANGED", out)

    def test_identical_files(self):
        a = self._write("a.txt", "same\n")
        b = self._write("b.txt", "same\n")
        self.assertEqual(code_intel.diff_files(a, b), "Files are identical")


if __name__ == "__main__":
    unittest.main()
