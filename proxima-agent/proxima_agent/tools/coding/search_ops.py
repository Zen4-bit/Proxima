"""Proxima — Search Operations.
Provides cross-file text searching, multi-file replacement, glob searching, and tree list helpers.
"""
import os
import re
import glob as _glob
import fnmatch
from pathlib import Path
from datetime import datetime

from .file_ops import _atomic_write


def search_text(query, path=".", regex=False, context=2, max_results=50, include=None, exclude=None):
    """Searches for text or regex patterns across files."""
    path = str(Path(path).resolve())
    results = []
    exclude = exclude or ["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build"]
    
    if regex:
        try:
            pattern = re.compile(query, re.IGNORECASE)
        except re.error as e:
            return f"✗ Invalid regex '{query}': {e}"
    else:
        pattern = None
    
    def should_exclude(filepath):
        parts = set(Path(filepath).parts)
        return any(ex in parts for ex in exclude)
    
    def matches(line):
        if regex:
            return pattern.search(line)
        return query.lower() in line.lower()
    
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in exclude]
        
        for fname in files:
            if include and not any(fnmatch.fnmatch(fname, pat) for pat in (include if isinstance(include, list) else [include])):
                continue
            
            fpath = os.path.join(root, fname)
            if should_exclude(fpath):
                continue
            
            try:
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()
                
                for i, line in enumerate(lines):
                    if matches(line):
                        start = max(0, i - context)
                        end = min(len(lines), i + context + 1)
                        ctx = ""
                        for j in range(start, end):
                            marker = "→" if j == i else " "
                            ctx += f"  {marker} {j+1:4d} | {lines[j]}"
                        
                        rel = os.path.relpath(fpath, path)
                        results.append(f"\n{rel}:{i+1}\n{ctx}")
                        
                        if len(results) >= max_results:
                            return f"Found {len(results)}+ matches:\n" + "".join(results) + f"\n... (capped at {max_results})"
            except (UnicodeDecodeError, PermissionError, IsADirectoryError):
                continue
    
    if not results:
        return f"No matches for '{query}' in {path}"
    return f"Found {len(results)} matches:\n" + "".join(results)


def find_replace(query, replacement, path=".", include=None, regex=False, dry_run=True, max_files=200):
    """Replaces target text or regex across files with dry run safety."""
    path = str(Path(path).resolve())
    exclude = {"node_modules", ".git", "__pycache__", ".venv", "venv", "dist",
               "build", ".next", "out", "coverage", "vendor", ".idea",
               ".gradle", "target", ".mypy_cache", ".pytest_cache", ".cache"}
    _binary_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
                    ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar", ".exe", ".dll",
                    ".so", ".dylib", ".bin", ".class", ".pyc", ".o", ".a", ".lib",
                    ".jar", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4",
                    ".mov", ".avi", ".wav", ".db", ".sqlite", ".lock"}
    results = []
    total = 0

    if regex:
        try:
            compiled = re.compile(query)
        except re.error as e:
            return f"✗ Invalid regex '{query}': {e}"
    else:
        compiled = None

    pending = []
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in exclude]
        for fname in files:
            if include and not any(fnmatch.fnmatch(fname, pat) for pat in (include if isinstance(include, list) else [include])):
                continue
            if os.path.splitext(fname)[1].lower() in _binary_exts:
                continue
            fpath = os.path.join(root, fname)
            try:
                with open(fpath, "r", encoding="utf-8", errors="strict", newline="") as f:
                    content = f.read()
            except (UnicodeDecodeError, PermissionError, OSError):
                continue
            try:
                if regex:
                    new_content, n = compiled.subn(replacement, content)
                else:
                    n = content.count(query)
                    new_content = content.replace(query, replacement)
            except re.error as e:
                return f"✗ Invalid regex replacement for '{query}': {e}"
            if n > 0:
                pending.append((fpath, new_content, n))
                total += n

    if not pending:
        return f"No matches for '{query}'"

    if dry_run:
        for fpath, _new_content, n in pending:
            results.append(f"~ {os.path.relpath(fpath, path)}: {n} replacements (would apply)")
        header = (
            f"DRY RUN — pass dry_run=False to apply. "
            f"{len(pending)} file(s), {total} total replacement(s) would be made."
        )
        return header + "\n" + "\n".join(results)

    if len(pending) > max_files:
        return (
            f"✗ Aborted: {len(pending)} files would be modified, which exceeds "
            f"max_files={max_files}. Narrow the path/pattern (or raise max_files) "
            f"and try again. No files were changed."
        )

    for fpath, new_content, n in pending:
        try:
            _atomic_write(fpath, new_content)
            results.append(f"✓ {os.path.relpath(fpath, path)}: {n} replacements")
        except (UnicodeDecodeError, PermissionError, OSError):
            continue

    if not results:
        return f"No matches for '{query}'"
    return "\n".join(results)


def glob_files(pattern, path="."):
    """Finds files matching a glob pattern."""
    path = str(Path(path).resolve())
    matches = list(_glob.glob(os.path.join(path, pattern), recursive=True))
    result = f"Found {len(matches)} files:\n"
    for m in matches[:100]:
        rel = os.path.relpath(m, path)
        size = os.path.getsize(m) if os.path.isfile(m) else 0
        result += f"  {rel} ({size:,} bytes)\n"
    if len(matches) > 100:
        result += f"  ... and {len(matches) - 100} more"
    return result


def file_stats(path):
    """Returns filesystem statistics for a path."""
    path = str(Path(path).resolve())
    if os.path.isfile(path):
        stat = os.stat(path)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = sum(1 for _ in f)
        return (
            f"File: {path}\n"
            f"Size: {stat.st_size:,} bytes\n"
            f"Lines: {lines}\n"
            f"Modified: {datetime.fromtimestamp(stat.st_mtime)}\n"
            f"Created: {datetime.fromtimestamp(stat.st_ctime)}"
        )
    elif os.path.isdir(path):
        total_files = 0
        total_size = 0
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in [".git", "node_modules", "__pycache__"]]
            total_files += len(files)
            for f in files:
                try:
                    total_size += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return f"Directory: {path}\nFiles: {total_files}\nTotal size: {total_size:,} bytes"
    return f"Not found: {path}"


def dir_tree(path=".", depth=3, show_files=True):
    """Returns directory structure tree view."""
    path = str(Path(path).resolve())
    exclude = {".git", "node_modules", "__pycache__", ".venv", "venv", ".next", "dist"}
    lines = [path]
    
    def _tree(dir_path, prefix, current_depth):
        if current_depth >= depth:
            return
        try:
            entries = sorted(os.listdir(dir_path))
        except PermissionError:
            return
        
        dirs = [e for e in entries if os.path.isdir(os.path.join(dir_path, e)) and e not in exclude]
        files = [e for e in entries if os.path.isfile(os.path.join(dir_path, e))] if show_files else []
        
        all_entries = [(d, True) for d in dirs] + [(f, False) for f in files]
        
        for i, (name, is_dir) in enumerate(all_entries):
            is_last = i == len(all_entries) - 1
            connector = "└── " if is_last else "├── "
            if is_dir:
                lines.append(f"{prefix}{connector}📁 {name}/")
                extension = "    " if is_last else "│   "
                _tree(os.path.join(dir_path, name), prefix + extension, current_depth + 1)
            else:
                size = os.path.getsize(os.path.join(dir_path, name))
                lines.append(f"{prefix}{connector}{name} ({size:,}b)")
    
    _tree(path, "", 0)
    return "\n".join(lines[:500])


def list_dir(path="."):
    """Lists files and directories in a directory path."""
    path = str(Path(path).resolve())
    entries = []
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        if os.path.isdir(full):
            entries.append(f"  📁 {name}/")
        else:
            size = os.path.getsize(full)
            entries.append(f"  📄 {name} ({size:,}b)")
    return f"{path}:\n" + "\n".join(entries)


search = search_text
tree = dir_tree


def grep(query, path=".", regex=False, context=2, max_results=50,
         include=None, exclude=None, recursive=True):
    """Searches for text or regex patterns (alias of search_text)."""
    return search_text(query, path=path, regex=regex, context=context,
                       max_results=max_results, include=include, exclude=exclude)


find_files = glob_files
