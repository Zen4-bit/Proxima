"""Proxima — Code Intelligence.
Provides language-aware static code analysis, syntax checking, symbol indexing, and diffing.
"""
import os
import re
import ast
import json
import sys
import shutil
import subprocess
from pathlib import Path


def syntax_check(path):
    """Checks Python file for syntax errors."""
    path = str(Path(path).resolve())
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            source = f.read()
    except OSError as e:
        return f"✗ Cannot read {path}: {e}"
    try:
        compile(source, path, "exec")
        return f"✓ No syntax errors in {path}"
    except SyntaxError as e:
        return f"✗ Syntax error in {path}:\n  Line {e.lineno}: {e.msg}\n  {e.text}"
    except (ValueError, TypeError) as e:
        return f"✗ Cannot compile {path}: {e}"


_RUFF_CMD = "unresolved"


def _resolve_ruff():
    """Resolves ruff command prefix cache."""
    global _RUFF_CMD
    if _RUFF_CMD != "unresolved":
        return _RUFF_CMD
    _RUFF_CMD = None
    candidates = [[sys.executable, "-m", "ruff"]]
    exe = shutil.which("ruff")
    if exe:
        candidates.append([exe])
    for base in candidates:
        try:
            r = subprocess.run(base + ["--version"], capture_output=True,
                               text=True, timeout=10)
            if r.returncode == 0:
                _RUFF_CMD = base
                break
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue
    return _RUFF_CMD


def _run_ruff(path, results, fix=False):
    """Runs ruff linter on target path."""
    base = _resolve_ruff()
    if base is None:
        return False
    cmd = base + ["check", path]
    if fix:
        cmd.append("--fix")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return False
    out = (r.stdout or "").strip()
    if r.returncode == 0:
        results.append("✓ Ruff: clean")
        return True
    if out:
        results.append(f"Ruff issues:\n{out[:2000]}")
        return True
    return False


def _run_pyflakes_pylint(path, results):
    """Runs pyflakes and pylint as fallback linters."""
    try:
        r = subprocess.run(
            [sys.executable, "-m", "pyflakes", path],
            capture_output=True, text=True, timeout=30
        )
        if r.stdout.strip():
            results.append(f"Pyflakes issues:\n{r.stdout.strip()}")
        elif r.returncode == 0:
            results.append("✓ Pyflakes: clean")
        else:
            results.append("⚠ Python linter not available — lint NOT verified (pip install ruff)")
    except FileNotFoundError:
        results.append("⚠ Python linter not available — lint NOT verified (pip install ruff)")
    except subprocess.TimeoutExpired:
        results.append("⚠ Pyflakes timed out — lint NOT verified")

    try:
        cmd = [sys.executable, "-m", "pylint", "--errors-only", "--disable=C,R,W", path]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if r.stdout.strip() and "Your code has been rated" not in r.stdout:
            errors = [l for l in r.stdout.strip().split("\n") if l.strip() and "rated" not in l]
            if errors:
                results.append(f"Pylint errors:\n" + "\n".join(errors[:20]))
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


def lint(path, fix=False):
    """Runs syntax checks and linters matching the file extension."""
    path = str(Path(path).resolve())
    ext = Path(path).suffix.lower()
    results = []
    
    if not os.path.exists(path):
        return f"✗ File not found: {path}"
    
    if ext in (".py",):
        results.append(syntax_check(path))
        if not _run_ruff(path, results, fix=fix):
            _run_pyflakes_pylint(path, results)
    
    elif ext in (".js", ".mjs", ".cjs"):
        try:
            r = subprocess.run(
                ["node", "--check", path],
                capture_output=True, text=True, timeout=15
            )
            if r.returncode == 0:
                results.append("✓ Node syntax: OK")
            else:
                results.append(f"✗ Node syntax error:\n{r.stderr.strip()}")
        except FileNotFoundError:
            results.append("⚠ Node.js not found — skipping syntax check")

        if shutil.which("npx"):
            try:
                cmd = ["npx", "--no-install", "eslint", path, "--no-eslintrc", "--rule", '{"no-undef": "error", "no-unused-vars": "warn"}']
                if fix:
                    cmd.append("--fix")
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                if r.stdout.strip():
                    results.append(f"ESLint:\n{r.stdout.strip()[:1000]}")
                elif r.returncode == 0:
                    results.append("✓ ESLint: clean")
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass

    elif ext in (".ts", ".tsx"):
        if shutil.which("npx"):
            try:
                r = subprocess.run(
                    ["npx", "--no-install", "tsc", "--noEmit", "--pretty", path],
                    capture_output=True, text=True, timeout=30
                )
                if r.returncode == 0:
                    results.append("✓ TypeScript: no errors")
                else:
                    results.append(f"✗ TypeScript errors:\n{r.stdout.strip()[:1500]}")
            except (FileNotFoundError, subprocess.TimeoutExpired):
                results.append("⚠ tsc not found")
        else:
            results.append("⚠ tsc not found (npx unavailable)")
    
    elif ext in (".json",):
        try:
            with open(path, "r", encoding="utf-8") as f:
                json.load(f)
            results.append(f"✓ Valid JSON: {path}")
        except json.JSONDecodeError as e:
            results.append(f"✗ Invalid JSON: {path}\n  Line {e.lineno}, Col {e.colno}: {e.msg}")
    
    elif ext in (".html", ".htm"):
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        issues = []
        if "<html" not in content.lower():
            issues.append("Missing <html> tag")
        if "</html>" not in content.lower():
            issues.append("Missing </html> closing tag")
        if "<head" not in content.lower():
            issues.append("Missing <head> tag")
        if "<body" not in content.lower():
            issues.append("Missing <body> tag")
        open_tags = re.findall(r'<(\w+)[\s>]', content)
        close_tags = re.findall(r'</(\w+)>', content)
        void_tags = {"img", "br", "hr", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"}
        for tag in set(open_tags):
            if tag.lower() in void_tags:
                continue
            opens = sum(1 for t in open_tags if t.lower() == tag.lower())
            closes = sum(1 for t in close_tags if t.lower() == tag.lower())
            if opens > closes:
                issues.append(f"Possibly unclosed <{tag}> ({opens} opens, {closes} closes)")
        if issues:
            results.append(f"HTML issues in {path}:\n" + "\n".join(f"  • {i}" for i in issues))
        else:
            results.append(f"✓ HTML looks OK: {path}")
    
    elif ext in (".css",):
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        issues = []
        opens = content.count("{")
        closes = content.count("}")
        if opens != closes:
            issues.append(f"Mismatched braces: {opens} opens, {closes} closes")
        lines = content.split("\n")
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped and not stripped.startswith(("/*", "*", "//", "@", "}", "{")) and ":" in stripped and not stripped.endswith((",", "{", ";", "*/", ")")):
                if not stripped.endswith("}"):
                    issues.append(f"  Line {i}: possibly missing semicolon: {stripped[:60]}")
        if issues:
            results.append(f"CSS issues in {path}:\n" + "\n".join(issues[:20]))
        else:
            results.append(f"✓ CSS looks OK: {path}")
    
    else:
        results.append(f"⚠ No linter configured for {ext} files")
    
    return "\n".join(results) if results else f"✓ No issues found in {path}"


def validate_project(path="."):
    """Lints files in project directory up to a limit."""
    path = str(Path(path).resolve())
    exclude = {"node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build", ".next"}
    ext_whitelist = {".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".html", ".css", ".mjs", ".cjs"}
    js_ts_ext = {".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"}
    MAX_FILES = 50

    npx_available = shutil.which("npx") is not None

    results = []
    checked = 0
    errors = 0
    skipped_js_ts = 0
    truncated = False

    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in exclude]
        for fname in files:
            ext = Path(fname).suffix.lower()
            if ext not in ext_whitelist:
                continue

            if ext in js_ts_ext and not npx_available:
                skipped_js_ts += 1
                continue

            if checked >= MAX_FILES:
                truncated = True
                break

            fpath = os.path.join(root, fname)
            rel = os.path.relpath(fpath, path)
            result = lint(fpath)
            checked += 1
            if "✗" in result:
                errors += 1
                results.append(f"\n── {rel} ──\n{result}")
            elif "⚠" in result or "issue" in result.lower():
                results.append(f"\n── {rel} ──\n{result}")
        if truncated:
            break

    notes = ""
    if skipped_js_ts:
        notes += f"\n⚠ Skipped {skipped_js_ts} JS/TS file(s): npx/eslint not available.\n"
    if truncated:
        notes += f"\n⚠ Truncated: only the first {MAX_FILES} files were linted. Narrow the path to check more.\n"

    summary = f"\n{'='*40}\nChecked {checked} files, {errors} with errors\n{'='*40}\n"
    body = "\n".join(results) if results else "✓ All files clean!"
    return summary + notes + body


def _run_js_parser(path):
    """Parses JS/TS file to JSON via bundled acorn parser."""
    parser = Path(__file__).parent / "js_parser.cjs"
    if not parser.exists() or shutil.which("node") is None:
        return None
    try:
        r = subprocess.run(
            ["node", str(parser), path, "50000"],
            capture_output=True, text=True, timeout=30
        )
        if r.returncode != 0 or not r.stdout.strip():
            return None
        return json.loads(r.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
        return None


def _py_find_functions(path):
    """Accurate Python function/class listing via ast."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError, ValueError):
        return None

    rows = []

    class _Visitor(ast.NodeVisitor):
        def __init__(self):
            self.depth = 0

        def _emit(self, node, is_class):
            indent = "  " * self.depth
            if is_class:
                sig = f"class {node.name}"
            else:
                args = [a.arg for a in node.args.args]
                if node.args.vararg:
                    args.append("*" + node.args.vararg.arg)
                if node.args.kwarg:
                    args.append("**" + node.args.kwarg.arg)
                kw = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
                sig = f"{kw} {node.name}({', '.join(args)})"
            rows.append((node.lineno, f"  {node.lineno:4d} | {indent}{sig}"))

        def _descend(self, node, is_class):
            self._emit(node, is_class)
            self.depth += 1
            self.generic_visit(node)
            self.depth -= 1

        def visit_FunctionDef(self, node):
            self._descend(node, False)

        def visit_AsyncFunctionDef(self, node):
            self._descend(node, False)

        def visit_ClassDef(self, node):
            self._descend(node, True)

    _Visitor().visit(tree)
    if not rows:
        return f"No functions/classes found in {path}"
    rows.sort(key=lambda r: r[0])
    return f"Functions/classes in {path}:\n" + "\n".join(r[1] for r in rows)


def _js_find_functions(path):
    """Accurate JS/TS function/class listing via js_parser.cjs."""
    data = _run_js_parser(path)
    if data is None:
        return None
    syms = data.get("symbols", [])
    if not syms:
        return f"No functions/classes found in {path}"
    rows = []
    for s in sorted(syms, key=lambda s: s.get("start_line", 0)):
        sig = s.get("signature") or s.get("fully_qualified_name") or s.get("name", "?")
        rows.append(f"  {s.get('start_line', 0):4d} | {sig}")
    return f"Functions/classes in {path}:\n" + "\n".join(rows)


def find_functions(path, language=None):
    """Lists classes and functions found in a file."""
    path = str(Path(path).resolve())
    ext = Path(path).suffix.lower()

    if ext == ".py":
        _r = _py_find_functions(path)
        if _r is not None:
            return _r
    elif ext in (".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"):
        _r = _js_find_functions(path)
        if _r is not None:
            return _r

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    
    results = []
    
    if ext in (".py",):
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith("def ") or stripped.startswith("class ") or stripped.startswith("async def "):
                indent = len(line) - len(line.lstrip())
                results.append(f"  {i:4d} | {'  ' * (indent // 4)}{stripped.split(':', 1)[0]}")
    
    elif ext in (".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"):
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if re.match(r'(export\s+)?(async\s+)?function\s+\w+', stripped):
                results.append(f"  {i:4d} | {stripped[:80]}")
            elif re.match(r'(const|let|var)\s+\w+\s*=\s*(async\s+)?\(', stripped):
                results.append(f"  {i:4d} | {stripped[:80]}")
            elif re.match(r'(export\s+)?(default\s+)?class\s+\w+', stripped):
                results.append(f"  {i:4d} | {stripped[:80]}")
    
    elif ext in (".java", ".cs", ".cpp", ".c", ".h"):
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if re.match(r'(public|private|protected|static|void|int|string|bool|class)\s+', stripped, re.IGNORECASE):
                if '{' in stripped or '(' in stripped:
                    results.append(f"  {i:4d} | {stripped[:80]}")
    
    if not results:
        return f"No functions/classes found in {path}"
    return f"Functions/classes in {path}:\n" + "\n".join(results)


def _py_get_imports(path):
    """Accurate Python import listing via ast."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError, ValueError):
        return None
    rows = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = ", ".join(
                a.name + (f" as {a.asname}" if a.asname else "") for a in node.names
            )
            rows.append((node.lineno, f"  {node.lineno:4d} | import {names}"))
        elif isinstance(node, ast.ImportFrom):
            mod = ("." * (node.level or 0)) + (node.module or "")
            names = ", ".join(
                a.name + (f" as {a.asname}" if a.asname else "") for a in node.names
            )
            rows.append((node.lineno, f"  {node.lineno:4d} | from {mod} import {names}"))
    if not rows:
        return f"No imports found in {path}"
    rows.sort(key=lambda r: r[0])
    return f"Imports in {path}:\n" + "\n".join(r[1] for r in rows)


def _js_get_imports(path):
    """Accurate JS/TS import listing via js_parser.cjs."""
    data = _run_js_parser(path)
    if data is None:
        return None
    imps = data.get("imports", [])
    if not imps:
        return f"No imports found in {path}"
    rows = []
    for im in sorted(imps, key=lambda x: x.get("line_number", 0)):
        sym = im.get("symbol_name", "")
        mod = im.get("module_path", "")
        rows.append(f"  {im.get('line_number', 0):4d} | {sym} from '{mod}'")
    return f"Imports in {path}:\n" + "\n".join(rows)


def get_imports(path):
    """Lists all imports in a file."""
    path = str(Path(path).resolve())
    ext = Path(path).suffix.lower()

    if ext == ".py":
        _r = _py_get_imports(path)
        if _r is not None:
            return _r
    elif ext in (".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"):
        _r = _js_get_imports(path)
        if _r is not None:
            return _r

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    
    imports = []
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if ext in (".py",):
            if stripped.startswith("import ") or stripped.startswith("from "):
                imports.append(f"  {i:4d} | {stripped}")
        elif ext in (".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"):
            if stripped.startswith("import ") or (stripped.startswith("const ") and "require(" in stripped):
                imports.append(f"  {i:4d} | {stripped[:100]}")
    
    if not imports:
        return f"No imports found in {path}"
    return f"Imports in {path}:\n" + "\n".join(imports)


def diff_files(file1, file2):
    """Compares two files and shows differences."""
    import difflib

    try:
        with open(file1, "r", encoding="utf-8", errors="replace") as f:
            lines1 = f.read().splitlines()
        with open(file2, "r", encoding="utf-8", errors="replace") as f:
            lines2 = f.read().splitlines()
    except OSError as e:
        return f"✗ Cannot read file: {e}"

    diff = difflib.unified_diff(lines1, lines2, fromfile=file1, tofile=file2, lineterm="")
    result = "\n".join(list(diff)[:200])
    return result if result else "Files are identical"
