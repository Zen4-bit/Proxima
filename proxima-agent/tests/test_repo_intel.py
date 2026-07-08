"""Tests for proxima_agent.tools.coding.repo_intel — pure parsing layer.

The RepositoryIndex class (SQLite index + background threads + Node JS parser)
is runtime-bound and covered as integration; here we test the PURE, isolatable
pieces it is built on:
  • parse_python_file / PyVisitor — AST → symbols/imports/relations/references
  • _detect_line_ending

These carry the actual code-intelligence logic and are fully deterministic.
"""
import unittest

from proxima_agent.tools.coding import repo_intel


class TestParsePythonFile(unittest.TestCase):
    def test_extracts_classes_and_functions_with_fqn(self):
        src = (
            "class Animal:\n"
            "    def speak(self):\n"
            "        return 'hi'\n"
            "\n"
            "class Dog(Animal):\n"
            "    def bark(self):\n"
            "        return 'woof'\n"
        )
        data = repo_intel.parse_python_file(src)
        names = {s["fully_qualified_name"] for s in data["symbols"]}
        self.assertIn("Animal", names)
        self.assertIn("Animal.speak", names)
        self.assertIn("Dog.bark", names)

    def test_captures_inheritance_relation(self):
        src = "class Base:\n    pass\n\nclass Child(Base):\n    pass\n"
        data = repo_intel.parse_python_file(src)
        inherits = [r for r in data["relations"] if r["relation_type"] == "inherits"]
        self.assertTrue(any(r["source_fqn"] == "Child" and r["target_fqn"] == "Base" for r in inherits))

    def test_captures_imports_local_and_external(self):
        src = "import os\nfrom . import sibling\nfrom pkg.mod import thing as t\n"
        data = repo_intel.parse_python_file(src)
        modpaths = {(i["module_path"], i["symbol_name"], i["is_local"]) for i in data["imports"]}
        self.assertIn(("os", "os", False), modpaths)
        # relative import flagged local
        self.assertTrue(any(i["is_local"] for i in data["imports"] if i["symbol_name"] == "sibling"))
        self.assertIn(("pkg.mod", "t", False), modpaths)

    def test_async_function_signature(self):
        data = repo_intel.parse_python_file("async def fetch():\n    return 1\n")
        fetch = next(s for s in data["symbols"] if s["name"] == "fetch")
        self.assertEqual(fetch["type"], "function")
        self.assertIn("async def", fetch["signature"])

    def test_records_references(self):
        data = repo_intel.parse_python_file("x = 1\nprint(x)\n")
        ref_names = {r["symbol_name"] for r in data["references"]}
        self.assertIn("print", ref_names)
        self.assertIn("x", ref_names)

    def test_syntax_error_raises_valueerror(self):
        with self.assertRaises(ValueError):
            repo_intel.parse_python_file("def broken(:\n")


class TestDetectLineEnding(unittest.TestCase):
    def test_crlf_dominant(self):
        self.assertEqual(repo_intel._detect_line_ending("a\r\nb\r\nc\n"), "\r\n")

    def test_lf_dominant(self):
        self.assertEqual(repo_intel._detect_line_ending("a\nb\nc\n"), "\n")


class TestPyVisitorDirect(unittest.TestCase):
    def test_contains_relation_for_method_in_class(self):
        data = repo_intel.parse_python_file("class C:\n    def m(self):\n        pass\n")
        contains = [r for r in data["relations"] if r["relation_type"] == "contains"]
        self.assertTrue(any(r["source_fqn"] == "C" and r["target_fqn"] == "C.m" for r in contains))


if __name__ == "__main__":
    unittest.main()
