"""Proxima — Repository Intelligence.
Extracts code structure, dependencies, and imports from python and JS codebases.
"""

import os
import ast
import re
import json
import time
import uuid
import sqlite3
import hashlib
import logging
import atexit
import threading
import traceback
import subprocess
from pathlib import Path

# Schema Version for DB migrations
SCHEMA_VERSION = 2
SUMMARY_SCHEMA_VERSION = 1
COMPRESSION_VERSION = "v1"

def _detect_line_ending(raw: str) -> str:
    """Returns the file's dominant line ending ("\r\n" or "\n") to prevent CRLF changes on Windows."""
    crlf = raw.count("\r\n")
    lf = raw.count("\n") - crlf
    return "\r\n" if crlf > lf else "\n"

def invalidate_parent_summaries(conn, file_path: str):
    parts = file_path.replace("\\", "/").split('/')
    cur = conn.cursor()
    try:
        cur.execute("UPDATE modules SET dirty = 1 WHERE path = '.';")
        for i in range(1, len(parts)):
            dir_path = "/".join(parts[:i])
            cur.execute("UPDATE modules SET dirty = 1 WHERE path = ?;", (dir_path,))
    except Exception:
        pass

def ensure_modules_exist(conn, workspace_path: str):
    cur = conn.cursor()
    cur.execute("SELECT DISTINCT path FROM files;")
    paths = [row[0] for row in cur.fetchall()]
    
    directories = {'.'}
    for p in paths:
        parts = p.split('/')
        for i in range(1, len(parts)):
            directories.add("/".join(parts[:i]))

    # Preload modules once (path -> id) parent-first to prevent N+1 queries on deep directory trees.
    cur.execute("SELECT path, id FROM modules;")
    path_to_id = {row[0]: row[1] for row in cur.fetchall()}

    sorted_dirs = sorted(list(directories), key=lambda x: (x.count('/'), len(x)))
    for d in sorted_dirs:
        if d in path_to_id:
            continue
        if d == '.':
            parent_id = None
        else:
            parts = d.split('/')
            parent_path = '/'.join(parts[:-1]) if len(parts) > 1 else '.'
            parent_id = path_to_id.get(parent_path)

        cur.execute(
            "INSERT INTO modules (path, parent_id, dirty, schema_version) VALUES (?, ?, ?, ?);",
            (d, parent_id, 1, SCHEMA_VERSION)
        )
        path_to_id[d] = cur.lastrowid
    conn.commit()

# Global Repository Registry
_REPO_INDEXES = {}
_REPO_LOCK = threading.Lock()

@atexit.register
def close_all_active_connections():
    with _REPO_LOCK:
        for repo in list(_REPO_INDEXES.values()):
            try:
                repo.close_all_connections()
            except Exception:
                pass


class PyVisitor(ast.NodeVisitor):
    def __init__(self):
        self.symbols = []
        self.imports = []
        self.references = []
        self.relations = []
        self.scope_stack = []

    def current_scope(self):
        return ".".join(self.scope_stack)

    def visit_ClassDef(self, node):
        name = node.name
        parent = self.current_scope()
        fqn = f"{parent}.{name}" if parent else name
        
        self.symbols.append({
            "name": name,
            "fully_qualified_name": fqn,
            "type": "class",
            "start_line": node.lineno,
            "end_line": node.end_lineno if hasattr(node, "end_lineno") else node.lineno,
            "signature": f"class {name}"
        })
        
        for base in node.bases:
            target_name = None
            if isinstance(base, ast.Name):
                target_name = base.id
            elif isinstance(base, ast.Attribute):
                target_name = base.attr
                
            if target_name:
                self.relations.append({
                    "source_fqn": fqn,
                    "target_fqn": target_name,
                    "relation_type": "inherits"
                })

        if parent:
            self.relations.append({
                "source_fqn": parent,
                "target_fqn": fqn,
                "relation_type": "contains"
            })

        self.scope_stack.append(name)
        self.generic_visit(node)
        self.scope_stack.pop()

    def visit_FunctionDef(self, node):
        self.visit_any_function(node, is_async=False)

    def visit_AsyncFunctionDef(self, node):
        self.visit_any_function(node, is_async=True)

    def visit_any_function(self, node, is_async=False):
        name = node.name
        parent = self.current_scope()
        fqn = f"{parent}.{name}" if parent else name
        
        prefix = "async " if is_async else ""
        self.symbols.append({
            "name": name,
            "fully_qualified_name": fqn,
            "type": "function",
            "start_line": node.lineno,
            "end_line": node.end_lineno if hasattr(node, "end_lineno") else node.lineno,
            "signature": f"{prefix}def {name}"
        })

        if parent:
            self.relations.append({
                "source_fqn": parent,
                "target_fqn": fqn,
                "relation_type": "contains"
            })

        self.scope_stack.append(name)
        self.generic_visit(node)
        self.scope_stack.pop()

    def visit_Import(self, node):
        for alias in node.names:
            self.imports.append({
                "module_path": alias.name,
                "symbol_name": alias.asname or alias.name.split('.')[-1],
                "line_number": node.lineno,
                "is_local": False
            })

    def visit_ImportFrom(self, node):
        module_path = node.module or ""
        is_local = (node.level or 0) > 0 or module_path.startswith(".")
        for alias in node.names:
            self.imports.append({
                "module_path": module_path,
                "symbol_name": alias.asname or alias.name,
                "line_number": node.lineno,
                "is_local": is_local
            })

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            self.references.append({
                "symbol_name": node.id,
                "line": node.lineno,
                "column": node.col_offset,
                "kind": "name"
            })
        self.generic_visit(node)

    def visit_Attribute(self, node):
        if isinstance(node.ctx, ast.Load):
            # col_offset points at expression start, so we calculate the exact attribute name
            # start using end_col_offset to ensure line/column self-consistency for rename_symbol.
            line = node.lineno
            column = node.col_offset
            end_col = getattr(node, "end_col_offset", None)
            end_line = getattr(node, "end_lineno", None)
            if end_col is not None and end_line is not None:
                line = end_line
                column = end_col - len(node.attr)
            self.references.append({
                "symbol_name": node.attr,
                "line": line,
                "column": column,
                "kind": "attribute"
            })
        self.generic_visit(node)


class RepositoryIndex:
    def __init__(self, db_path: str, workspace_path: str):
        self.db_path = os.path.abspath(db_path)
        self.workspace_path = os.path.abspath(workspace_path)
        self.active_session_id = None
        self.cancel_event = threading.Event()
        self.current_generation = 0
        self._is_indexing_active = False
        self._lock = threading.Lock()
        
        # Diagnostics metrics
        self.last_index_duration_ms = 0.0
        self.last_successful_index = "Never"
        self.last_error_count = 0
        self.last_indexed_files = 0
        self.last_rebuild_at = "Never"
        
        # Scoped connection states (prevents different repo instances sharing caches)
        self._thread_local = threading.local()
        self._connections = set()
        self._connections_lock = threading.Lock()
        self._db_write_lock = threading.Lock()  # Serializes transactions

        # Ensure directories and SQLite structure exists
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self.init_db()

    def get_db_connection(self):
        if not hasattr(self._thread_local, "conn"):
            conn = sqlite3.connect(self.db_path, timeout=10.0)
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            conn.execute("PRAGMA foreign_keys=ON;")
            self._thread_local.conn = conn
            with self._connections_lock:
                self._connections.add(conn)
        return self._thread_local.conn

    def close_thread_connection(self):
        conn = getattr(self._thread_local, "conn", None)
        if conn:
            try:
                conn.close()
            except Exception:
                pass
            with self._connections_lock:
                self._connections.discard(conn)
            delattr(self._thread_local, "conn")

    def close_all_connections(self):
        with self._connections_lock:
            for conn in self._connections:
                try:
                    conn.close()
                except Exception:
                    pass
            self._connections.clear()

    def init_db(self):
        conn = self.get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT schema_version FROM metadata LIMIT 1;")
            row = cur.fetchone()
            if not row or row[0] != SCHEMA_VERSION:
                reason = f"Schema mismatch (expected {SCHEMA_VERSION}, got {row[0] if row else 'None'})"
                logging.warning(f"Index DB migration triggered: {reason}. Rebuilding database...")
                self.recreate_tables(conn)
        except sqlite3.OperationalError as e:
            logging.warning(f"Index DB initialization triggered (reason: {e}). Rebuilding database...")
            self.recreate_tables(conn)

    def recreate_tables(self, conn):
        with self._db_write_lock:
            cur = conn.cursor()
            cur.execute("DROP TABLE IF EXISTS tests;")
            cur.execute("DROP TABLE IF EXISTS modules;")
            cur.execute("DROP TABLE IF EXISTS dependency_pack_cache;")
            cur.execute("DROP TABLE IF EXISTS index_stats;")
            cur.execute("DROP TABLE IF EXISTS parse_errors;")
            cur.execute("DROP TABLE IF EXISTS dependencies;")
            cur.execute("DROP TABLE IF EXISTS imports;")
            cur.execute('DROP TABLE IF EXISTS "references";')
            cur.execute("DROP TABLE IF EXISTS relations;")
            cur.execute("DROP TABLE IF EXISTS symbols;")
            cur.execute("DROP TABLE IF EXISTS files;")
            cur.execute("DROP TABLE IF EXISTS metadata;")
            
            cur.execute("""
                CREATE TABLE metadata (
                    schema_version INTEGER,
                    index_version TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
            cur.execute("INSERT INTO metadata (schema_version) VALUES (?);", (SCHEMA_VERSION,))

            cur.execute("""
                CREATE TABLE files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    path TEXT UNIQUE,
                    mtime REAL,
                    hash TEXT,
                    generation INTEGER,
                    indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)

            cur.execute("""
                CREATE TABLE symbols (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_id INTEGER,
                    name TEXT,
                    fully_qualified_name TEXT,
                    type TEXT,
                    start_line INTEGER,
                    end_line INTEGER,
                    signature TEXT,
                    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
                    UNIQUE(fully_qualified_name, file_id)
                );
            """)

            cur.execute("""
                CREATE TABLE relations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_symbol_id INTEGER,
                    target_symbol_id INTEGER,
                    relation_type TEXT,
                    FOREIGN KEY (source_symbol_id) REFERENCES symbols (id) ON DELETE CASCADE,
                    FOREIGN KEY (target_symbol_id) REFERENCES symbols (id) ON DELETE CASCADE
                );
            """)

            cur.execute("""
                CREATE TABLE "references" (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol_name TEXT,
                    fully_qualified_name TEXT,
                    file_id INTEGER,
                    line INTEGER,
                    column INTEGER,
                    kind TEXT,
                    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
                );
            """)

            cur.execute("""
                CREATE TABLE imports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_id INTEGER,
                    module_path TEXT,
                    symbol_name TEXT,
                    line_number INTEGER,
                    is_local INTEGER,
                    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
                );
            """)

            cur.execute("""
                CREATE TABLE dependencies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    caller_file_id INTEGER,
                    callee_file_id INTEGER,
                    dependency_type TEXT,
                    line_number INTEGER,
                    resolution_confidence REAL,
                    FOREIGN KEY (caller_file_id) REFERENCES files (id) ON DELETE CASCADE,
                    FOREIGN KEY (callee_file_id) REFERENCES files (id) ON DELETE CASCADE
                );
            """)

            cur.execute("""
                CREATE TABLE parse_errors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_id INTEGER,
                    parser TEXT,
                    severity TEXT,
                    error_hash TEXT,
                    error TEXT,
                    traceback TEXT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
                );
            """)

            cur.execute("""
                CREATE TABLE index_stats (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    generation INTEGER,
                    files_indexed INTEGER,
                    symbols_indexed INTEGER,
                    references_indexed INTEGER,
                    duration_ms REAL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)

            cur.execute("""
                CREATE TABLE modules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    path TEXT UNIQUE,
                    summary TEXT,
                    parent_id INTEGER,
                    dirty INTEGER DEFAULT 0,
                    schema_version INTEGER DEFAULT 2,
                    FOREIGN KEY (parent_id) REFERENCES modules (id) ON DELETE CASCADE
                );
            """)

            cur.execute("""
                CREATE TABLE dependency_pack_cache (
                    file_id INTEGER PRIMARY KEY,
                    file_hash TEXT,
                    summary_schema_version INTEGER,
                    compression_version TEXT,
                    compressed_payload TEXT,
                    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
                );
            """)

            cur.execute("""
                CREATE TABLE tests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    test_file_id INTEGER,
                    target_file_id INTEGER,
                    framework TEXT,
                    FOREIGN KEY (test_file_id) REFERENCES files (id) ON DELETE CASCADE,
                    FOREIGN KEY (target_file_id) REFERENCES files (id) ON DELETE CASCADE
                );
            """)

            # Indexes for O(log n) lookups
            cur.execute("CREATE INDEX idx_symbols_fqn ON symbols(fully_qualified_name);")
            cur.execute("CREATE INDEX idx_symbols_file_id ON symbols(file_id);")
            cur.execute("CREATE INDEX idx_symbols_name ON symbols(name);")
            cur.execute('CREATE INDEX idx_references_fqn ON "references"(fully_qualified_name);')
            cur.execute('CREATE INDEX idx_references_file_id ON "references"(file_id);')
            cur.execute('CREATE INDEX idx_references_sym_name ON "references"(symbol_name);')
            cur.execute('CREATE INDEX idx_references_fqn_file ON "references"(fully_qualified_name, file_id);')
            cur.execute("CREATE INDEX idx_dependencies_caller ON dependencies(caller_file_id);")
            cur.execute("CREATE INDEX idx_dependencies_callee ON dependencies(callee_file_id);")
            cur.execute("CREATE INDEX idx_imports_file_id ON imports(file_id);")
            cur.execute("CREATE INDEX idx_imports_fid_name ON imports(file_id, symbol_name);")
            cur.execute("CREATE INDEX idx_parse_errors_file_id ON parse_errors(file_id);")
            conn.commit()
            self.last_rebuild_at = time.strftime("%Y-%m-%d %H:%M:%S")

    def start_session(self) -> str:
        with self._lock:
            self.cancel_event.clear()
            self.active_session_id = str(uuid.uuid4())
            self.current_generation = max(self.current_generation + 1, time.time_ns())
            self._is_indexing_active = True
            return self.active_session_id

    def cancel_session(self):
        with self._lock:
            self.cancel_event.set()
            self.active_session_id = None
            self._is_indexing_active = False
            logging.info("Indexing session cancelled cooperatively.")

    def is_session_active(self, session_id) -> bool:
        return self.active_session_id == session_id and not self.cancel_event.is_set()

    def index_workspace(self):
        session_id = self.start_session()
        start_time = time.time()
        conn = self.get_db_connection()
        
        # Ensure WAL mode configuration
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        
        existing_db_files = {}
        try:
            cur = conn.cursor()
            cur.execute("SELECT id, path, mtime, hash FROM files;")
            for fid, fpath, fmtime, fhash in cur.fetchall():
                existing_db_files[fpath] = (fid, fmtime, fhash)
        except Exception as e:
            logging.warning(f"Error fetching cached files: {e}")
            self.close_thread_connection()
            return
            
        exclude_dirs = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".proxima"}
        include_extensions = {".py", ".js", ".ts", ".jsx", ".tsx"}
        
        files_on_disk = set()
        dirty_files = []
        
        # 1. Walk directory tree
        for root, dirs, filenames in os.walk(self.workspace_path):
            if not self.is_session_active(session_id):
                self.close_thread_connection()
                return
                
            dirs[:] = [d for d in dirs if d not in exclude_dirs]
            
            for fname in filenames:
                ext = os.path.splitext(fname)[1].lower()
                if ext not in include_extensions:
                    continue
                    
                full_path = os.path.abspath(os.path.join(root, fname))
                rel_path = os.path.relpath(full_path, os.path.abspath(self.workspace_path)).replace("\\", "/")
                files_on_disk.add(rel_path)
                
                try:
                    mtime = os.path.getmtime(full_path)
                except OSError:
                    continue
                    
                if rel_path in existing_db_files:
                    fid, db_mtime, db_hash = existing_db_files[rel_path]
                    if abs(mtime - db_mtime) < 1e-4:
                        continue
                        
                dirty_files.append((rel_path, full_path, mtime))

        # 2. Handle deleted files
        deleted_files = set(existing_db_files.keys()) - files_on_disk
        if deleted_files:
            with self._db_write_lock:
                with conn:
                    for del_file in deleted_files:
                        try:
                            conn.execute("DELETE FROM files WHERE path = ?;", (del_file,))
                            invalidate_parent_summaries(conn, del_file)
                        except Exception as e:
                            logging.warning(f"Failed to delete records for file {del_file}: {e}")

        # 3. First pass: Pre-register/Update files in SQLite and read contents
        dirty_files_to_parse = []
        error_count = 0
        
        for rel_path, full_path, mtime in dirty_files:
            if not self.is_session_active(session_id):
                self.close_thread_connection()
                return
                
            try:
                with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                fhash = hashlib.md5(content.encode("utf-8")).hexdigest()
            except Exception as e:
                logging.warning(f"Failed to read file {rel_path}: {e}")
                continue
                
            with self._db_write_lock:
                with conn:
                    try:
                        cur = conn.cursor()
                        cur.execute("SELECT id FROM files WHERE path = ?;", (rel_path,))
                        row = cur.fetchone()
                        if row:
                            file_id = row[0]
                            cur.execute(
                                "UPDATE files SET mtime = ?, hash = ?, generation = ?, indexed_at = CURRENT_TIMESTAMP WHERE id = ?;",
                                (mtime, fhash, self.current_generation, file_id)
                            )
                            # Manually clean up old child rows for this updated file to preserve dependencies pointing to it
                            cur.execute("DELETE FROM symbols WHERE file_id = ?;", (file_id,))
                            cur.execute('DELETE FROM "references" WHERE file_id = ?;', (file_id,))
                            cur.execute("DELETE FROM imports WHERE file_id = ?;", (file_id,))
                            cur.execute("DELETE FROM dependencies WHERE caller_file_id = ?;", (file_id,))
                            cur.execute("DELETE FROM parse_errors WHERE file_id = ?;", (file_id,))
                            cur.execute("DELETE FROM dependency_pack_cache WHERE file_id = ?;", (file_id,))
                            invalidate_parent_summaries(conn, rel_path)
                        else:
                            cur.execute(
                                "INSERT INTO files (path, mtime, hash, generation) VALUES (?, ?, ?, ?);",
                                (rel_path, mtime, fhash, self.current_generation)
                            )
                            file_id = cur.lastrowid
                            invalidate_parent_summaries(conn, rel_path)
                        dirty_files_to_parse.append((rel_path, full_path, file_id, content))
                    except Exception as e:
                        logging.warning(f"Error preparing database entry for {rel_path}: {e}")
                        continue

        # 4. Second pass: Parse files and insert code intelligence relationships
        files_indexed = 0
        symbols_indexed = 0
        references_indexed = 0
        
        for rel_path, full_path, file_id, content in dirty_files_to_parse:
            if not self.is_session_active(session_id):
                self.close_thread_connection()
                return
                
            parsed_data = None
            parser_name = "python" if rel_path.endswith(".py") else "acorn"
            
            try:
                if rel_path.endswith(".py"):
                    parsed_data = parse_python_file(content)
                else:
                    parsed_data = parse_js_file_with_node(full_path)
            except Exception as e:
                error_count += 1
                err_msg = str(e)
                err_hash = hashlib.md5(err_msg.encode("utf-8")).hexdigest()
                tb = traceback.format_exc()
                with self._db_write_lock:
                    with conn:
                        try:
                            conn.execute(
                                """INSERT INTO parse_errors 
                                (file_id, parser, severity, error_hash, error, traceback)
                                VALUES (?, ?, ?, ?, ?, ?);""",
                                (file_id, parser_name, "error", err_hash, err_msg, tb)
                            )
                        except Exception:
                            pass
                continue

            if parsed_data:
                with self._db_write_lock:
                    with conn:
                        try:
                            cur = conn.cursor()
                            fqn_to_id = {}
                            
                            for sym in parsed_data.get("symbols", []):
                                cur.execute(
                                    """INSERT OR REPLACE INTO symbols 
                                    (file_id, name, fully_qualified_name, type, start_line, end_line, signature)
                                    VALUES (?, ?, ?, ?, ?, ?, ?);""",
                                    (file_id, sym["name"], sym["fully_qualified_name"], sym["type"],
                                     sym["start_line"], sym["end_line"], sym["signature"])
                                )
                                sym_id = cur.lastrowid
                                fqn_to_id[sym["fully_qualified_name"]] = sym_id
                                symbols_indexed += 1
                                
                            for rel in parsed_data.get("relations", []):
                                sid = fqn_to_id.get(rel["source_fqn"])
                                tid = fqn_to_id.get(rel["target_fqn"])
                                # Fallback search symbols by name if not FQN matches
                                if not tid:
                                    cur.execute("SELECT id FROM symbols WHERE name = ? LIMIT 1;", (rel["target_fqn"],))
                                    row = cur.fetchone()
                                    if row:
                                        tid = row[0]
                                if sid and tid:
                                    cur.execute(
                                        "INSERT INTO relations (source_symbol_id, target_symbol_id, relation_type) VALUES (?, ?, ?);",
                                        (sid, tid, rel["relation_type"])
                                    )
                                    
                            for imp in parsed_data.get("imports", []):
                                cur.execute(
                                    """INSERT INTO imports 
                                    (file_id, module_path, symbol_name, line_number, is_local)
                                    VALUES (?, ?, ?, ?, ?);""",
                                    (file_id, imp["module_path"], imp["symbol_name"], imp["line_number"], 1 if imp["is_local"] else 0)
                                )
                                
                            for ref in parsed_data.get("references", []):
                                cur.execute(
                                    """INSERT INTO "references" 
                                    (symbol_name, fully_qualified_name, file_id, line, column, kind)
                                    VALUES (?, ?, ?, ?, ?, ?);""",
                                    (ref["symbol_name"], ref.get("fully_qualified_name", ""), file_id, ref["line"], ref["column"], ref["kind"])
                                )
                                references_indexed += 1
                                
                            # Mapping dependencies (forward graph)
                            for imp in parsed_data.get("imports", []):
                                module_path = imp["module_path"]
                                clean_module = module_path.replace(".", "/")
                                potential_paths = [
                                    clean_module + ".py",
                                    clean_module + "/__init__.py",
                                    clean_module + ".js",
                                    clean_module + ".ts",
                                    clean_module + ".tsx",
                                    clean_module + "/index.js",
                                    clean_module + "/index.ts"
                                ]
                                if module_path != clean_module:
                                    potential_paths.extend([
                                        module_path + ".py",
                                        module_path + ".js",
                                        module_path + ".ts",
                                        module_path + ".tsx"
                                    ])
                                    
                                for p in potential_paths:
                                    p_clean = p.lstrip("./").lstrip("../")
                                    if not p_clean:
                                        continue
                                    # Match path-component boundary to prevent incorrect suffix matches like myutils.py.
                                    cur.execute("SELECT id, path FROM files WHERE path LIKE ? LIMIT 10;", (f"%{p_clean}",))
                                    _target = p_clean.replace("\\", "/")
                                    matched_id = None
                                    for cand_id, cand_path in cur.fetchall():
                                        _norm = (cand_path or "").replace("\\", "/")
                                        if _norm == _target or _norm.endswith("/" + _target):
                                            matched_id = cand_id
                                            break
                                    if matched_id is not None:
                                        confidence = 1.0 if imp["is_local"] else 0.8
                                        cur.execute(
                                            """INSERT INTO dependencies 
                                            (caller_file_id, callee_file_id, dependency_type, line_number, resolution_confidence)
                                            VALUES (?, ?, ?, ?, ?);""",
                                            (file_id, matched_id, "import", imp["line_number"], confidence)
                                        )
                                        break
                                            
                            files_indexed += 1
                        except Exception as e:
                            logging.warning(f"Error saving database records for {rel_path}: {e}")

        # 4. Save Stats
        duration_ms = (time.time() - start_time) * 1000.0
        with self._db_write_lock:
            with conn:
                try:
                    conn.execute(
                        """INSERT INTO index_stats 
                        (generation, files_indexed, symbols_indexed, references_indexed, duration_ms)
                        VALUES (?, ?, ?, ?, ?);""",
                        (self.current_generation, files_indexed, symbols_indexed, references_indexed, duration_ms)
                    )
                except Exception:
                    pass

        # Update diagnostics variables
        self.last_index_duration_ms = duration_ms
        self.last_error_count = error_count
        self.last_indexed_files = files_indexed
        self.last_successful_index = time.strftime("%Y-%m-%d %H:%M:%S")
        self._is_indexing_active = False
        
        # Ensure directory modules exist hierarchically
        try:
            ensure_modules_exist(conn, self.workspace_path)
        except Exception as e:
            logging.warning(f"Error ensuring modules exist: {e}")
            
        self.close_thread_connection()


# Global Repository Registry is defined at the top of the file

def get_repo_index(path: str = ".") -> RepositoryIndex:
    root_path = os.path.abspath(path)
    project_root = root_path
    current = root_path
    
    while True:
        if (os.path.exists(os.path.join(current, "package.json")) or
            os.path.exists(os.path.join(current, "pyproject.toml")) or
            os.path.exists(os.path.join(current, "Cargo.toml")) or
            os.path.exists(os.path.join(current, ".git")) or
            os.path.exists(os.path.join(current, "requirements.txt"))):
            project_root = current
            break
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    with _REPO_LOCK:
        if project_root not in _REPO_INDEXES:
            db_path = os.path.join(project_root, ".proxima", "index.db")
            _REPO_INDEXES[project_root] = RepositoryIndex(db_path, project_root)
        return _REPO_INDEXES[project_root]


# ── Parser Implementations ────────────────────────────────────────

def parse_python_file(content: str) -> dict:
    try:
        tree = ast.parse(content)
    except SyntaxError as e:
        raise ValueError(f"Syntax error on line {e.lineno}: {e.msg}")
        
    visitor = PyVisitor()
    visitor.visit(tree)
    
    return {
        "symbols": visitor.symbols,
        "imports": visitor.imports,
        "references": visitor.references,
        "relations": visitor.relations
    }


def parse_js_file_with_node(full_path: str) -> dict:
    parser_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "js_parser.cjs")
    
    if not os.path.exists(parser_path):
        raise FileNotFoundError(f"Subprocess parser script missing at {parser_path}")
        
    try:
        r = subprocess.run(
            ["node", parser_path, full_path, "100000"],
            capture_output=True,
            text=True,
            timeout=10.0
        )
    except subprocess.TimeoutExpired:
        raise TimeoutError("Node JS parser script exceeded 10.0s timeout limit")
    except FileNotFoundError:
        raise FileNotFoundError("Node.js runtime not found on host machine environment")
        
    if r.returncode != 0:
        err = r.stderr.strip() or r.stdout.strip() or "Unknown parser error"
        raise ValueError(err)
        
    out = r.stdout
    if len(out) > 5 * 1024 * 1024:
        raise ValueError("Subprocess output size exceeded 5MB threshold constraint")
        
    try:
        return json.loads(out)
    except json.JSONDecodeError as e:
        raise ValueError(f"JSON decoder fail on JS parse data: {e}")


# ── Repository Intelligence Public APIs ───────────────────────────

def analyze_project(path: str = ".") -> dict:
    root = Path(path).resolve()
    info = {
        "language": "unknown",
        "framework": "unknown",
        "build": "unknown",
        "tests": "unknown",
        "entrypoints": []
    }
    
    if (root / "package.json").exists():
        info["language"] = "javascript/typescript"
        try:
            with open(root / "package.json", "r", encoding="utf-8") as f:
                data = json.load(f)
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            
            if (root / "pnpm-workspace.yaml").exists() or (root / "pnpm-lock.yaml").exists():
                info["build"] = "pnpm"
            elif (root / "yarn.lock").exists():
                info["build"] = "yarn"
            else:
                info["build"] = "npm"
                
            if "next" in deps:
                info["framework"] = "nextjs"
            elif "react" in deps:
                info["framework"] = "react"
            elif "express" in deps:
                info["framework"] = "express"
                
            if "vitest" in deps:
                info["tests"] = "vitest"
            elif "jest" in deps:
                info["tests"] = "jest"
            else:
                info["tests"] = "node (native)"
        except Exception:
            pass
            
    elif (root / "pyproject.toml").exists() or (root / "requirements.txt").exists():
        info["language"] = "python"
        info["build"] = "pip/poetry"
        info["tests"] = "pytest"
        if (root / "manage.py").exists():
            info["framework"] = "django"
            info["entrypoints"].append("manage.py")
        else:
            info["framework"] = "fastapi/flask"
            if (root / "main.py").exists():
                info["entrypoints"].append("main.py")
                
    elif (root / "Cargo.toml").exists():
        info["language"] = "rust"
        info["build"] = "cargo"
        info["tests"] = "cargo test"
        
    return info


def repo_status(path: str = ".") -> dict:
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM files;")
        files_cnt = cur.fetchone()[0]
        
        cur.execute("SELECT COUNT(*) FROM symbols;")
        symbols_cnt = cur.fetchone()[0]
        
        return {
            "indexed": files_cnt > 0,
            "files": files_cnt,
            "symbols": symbols_cnt,
            "is_indexing": repo._is_indexing_active
        }
    except Exception:
        return {"indexed": False, "files": 0, "symbols": 0, "is_indexing": False}


def repo_health(path: str = ".") -> dict:
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    try:
        cur = conn.cursor()
        # Verify metadata table readability
        cur.execute("SELECT schema_version FROM metadata LIMIT 1;")
        ver = cur.fetchone()[0]
        
        cur.execute("SELECT COUNT(*) FROM parse_errors;")
        errors_cnt = cur.fetchone()[0]
        
        cur.execute("SELECT files.path, parse_errors.error FROM parse_errors JOIN files ON parse_errors.file_id = files.id LIMIT 10;")
        broken_files = [{"path": row[0], "error": row[1]} for row in cur.fetchall()]
        
        return {
            "db_ok": ver == SCHEMA_VERSION,
            "is_indexing": repo._is_indexing_active,
            "active_generation": repo.current_generation,
            "last_successful_index": repo.last_successful_index,
            "last_error_count": repo.last_error_count,
            "last_index_duration_ms": repo.last_index_duration_ms,
            "last_indexed_files": repo.last_indexed_files,
            "last_rebuild_at": repo.last_rebuild_at,
            "parse_errors": errors_cnt,
            "broken_files": broken_files
        }
    except Exception as e:
        return {
            "db_ok": False,
            "is_indexing": False,
            "active_generation": 0,
            "last_error": str(e)
        }


def find_definition(symbol: str, path: str = ".") -> str:
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT s.name, s.fully_qualified_name, s.type, s.start_line, s.end_line, s.signature, f.path 
            FROM symbols s JOIN files f ON s.file_id = f.id 
            WHERE s.name = ? OR s.fully_qualified_name = ?;""",
            (symbol, symbol)
        )
        rows = cur.fetchall()
        if not rows:
            return f"Symbol '{symbol}' definition not found in repository."
            
        res = []
        for r in rows:
            res.append(
                f"- Symbol: {r[0]} ({r[2]})\n"
                f"  FQN: {r[1]}\n"
                f"  File: {r[6]}\n"
                f"  Lines: {r[3]}-{r[4]}\n"
                f"  Signature: {r[5]}"
            )
        return "\n".join(res)
    except Exception as e:
        return f"Error looking up definition for '{symbol}': {e}"


def find_references(symbol: str, path: str = ".") -> str:
    """Find references matching target symbol semantically."""
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    
    # 1. Fetch defining FQNs and parent packages
    defining_fqns = set()
    defining_names = set()
    defining_modules = set()
    try:
        cur = conn.cursor()
        cur.execute("SELECT name, fully_qualified_name, file_id FROM symbols WHERE name = ? OR fully_qualified_name = ?;", (symbol, symbol))
        for rname, rfqn, fid in cur.fetchall():
            defining_names.add(rname)
            defining_fqns.add(rfqn)
            # Find module name by stripping symbol name
            parts = rfqn.split('.')
            if len(parts) > 1:
                defining_modules.add(".".join(parts[:-1]))
    except Exception:
        pass
        
    if not defining_names:
        defining_names.add(symbol)
        defining_fqns.add(symbol)

    try:
        cur = conn.cursor()
        # Find raw reference matches
        placeholders = ",".join("?" for _ in defining_names)
        query = f"""
            SELECT r.symbol_name, r.fully_qualified_name, r.line, r.column, r.kind, f.path, f.id
            FROM "references" r JOIN files f ON r.file_id = f.id
            WHERE r.symbol_name IN ({placeholders});
        """
        cur.execute(query, list(defining_names))
        rows = cur.fetchall()
        
        if not rows:
            return f"No references found for '{symbol}'."
            
        valid_refs = []
        for rname, rfqn, line, col, kind, fpath, fid in rows:
            # Semantic filter: check if this file defines or imports the target symbol FQN
            is_valid = False
            
            # Check 1: If file defines the target symbol (local reference)
            cur.execute("SELECT id FROM symbols WHERE file_id = ? AND fully_qualified_name IN ({});".format(
                ",".join("?" for _ in defining_fqns)
            ), [fid] + list(defining_fqns))
            if cur.fetchone():
                is_valid = True
                
            # Check 2: Check if this file imports the symbol module
            if not is_valid:
                cur.execute("SELECT module_path FROM imports WHERE file_id = ? AND symbol_name = ?;", (fid, rname))
                for imp_row in cur.fetchall():
                    imp_module = imp_row[0]
                    # Check if imported module path matches any defining module or FQN
                    if imp_module in defining_modules or any(fqn.startswith(imp_module) for fqn in defining_fqns):
                        is_valid = True
                        break
                        
            # Check 3: If no imports or declarations are found in python/JS, we allow it as a low-confidence reference
            if not is_valid:
                # If there are no other symbols with the same name, or we fall back
                cur.execute("SELECT COUNT(*) FROM symbols WHERE name = ?;", (rname,))
                if cur.fetchone()[0] <= 1:
                    is_valid = True  # single globally unique name matches
            
            if is_valid:
                valid_refs.append(
                    f"  - {fpath}:{line}:{col} | Kind: {kind}"
                )
                
        if not valid_refs:
            return f"No semantic references found for '{symbol}'."
            
        return f"Found {len(valid_refs)} references for '{symbol}':\n" + "\n".join(valid_refs)
    except Exception as e:
        return f"Error scanning references for '{symbol}': {e}"


def get_impacted_files(file_path: str, path: str = ".") -> list:
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    try:
        cur = conn.cursor()
        # Clean relative path format
        file_path = file_path.replace("\\", "/").lstrip("./").lstrip("../")
        # Require path-component boundary on suffix match to prevent false myutils.py match.
        cur.execute(
            "SELECT id FROM files WHERE path = ? OR path LIKE ? OR path LIKE ? LIMIT 1;",
            (file_path, f"%/{file_path}", f"%\\{file_path}"),
        )
        row = cur.fetchone()
        if not row:
            return []
            
        start_id = row[0]
        
        # Traverse dependencies breadth-first (up to 4 levels deep)
        visited = {start_id}
        queue = [start_id]
        impacted_paths = []
        
        for _ in range(4):
            next_queue = []
            for fid in queue:
                cur.execute(
                    "SELECT caller_file_id, f.path FROM dependencies d JOIN files f ON d.caller_file_id = f.id WHERE d.callee_file_id = ?;",
                    (fid,)
                )
                for caller_id, caller_path in cur.fetchall():
                    if caller_id not in visited:
                        visited.add(caller_id)
                        next_queue.append(caller_id)
                        impacted_paths.append(caller_path)
            if not next_queue:
                break
            queue = next_queue
            
        return list(set(impacted_paths))
    except Exception:
        return []


def get_impacted_tests(file_path: str, path: str = ".") -> list:
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    
    # 1. Resolve impacted dependents
    impacted_files = get_impacted_files(file_path, path)
    impacted_files.append(file_path.replace("\\", "/"))
    
    test_files = []
    try:
        cur = conn.cursor()
        cur.execute("SELECT path FROM files;")
        all_files_info = [(os.path.basename(row[0]), row[0]) for row in cur.fetchall()]
        
        for f in impacted_files:
            clean_f = f.lstrip("./").lstrip("../")
            base = os.path.splitext(os.path.basename(clean_f))[0]
            
            target_filenames = {
                f"test_{base}.py",
                f"{base}_test.py",
                f"{base}.test.js",
                f"{base}.test.ts",
                f"{base}.spec.js",
                f"{base}.spec.ts"
            }
            
            for p_base, p in all_files_info:
                if p_base in target_filenames:
                    test_files.append(p)
                    
        return list(set(test_files))
    except Exception:
        return []

def find_callers(symbol: str, path: str = ".") -> list:
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    callers = []
    
    defining_fqns = set()
    defining_names = set()
    defining_modules = set()
    try:
        cur = conn.cursor()
        cur.execute("SELECT name, fully_qualified_name FROM symbols WHERE name = ? OR fully_qualified_name = ?;", (symbol, symbol))
        for rname, rfqn in cur.fetchall():
            defining_names.add(rname)
            defining_fqns.add(rfqn)
            parts = rfqn.split('.')
            if len(parts) > 1:
                defining_modules.add(".".join(parts[:-1]))
    except Exception:
        pass
        
    if not defining_names:
        defining_names.add(symbol)
        defining_fqns.add(symbol)

    try:
        cur = conn.cursor()
        placeholders = ",".join("?" for _ in defining_names)
        
        # 1. Look up inherits from relations table
        query_inherits = f"""
            SELECT s.name, s.fully_qualified_name, s.start_line, f.path, f.id
            FROM relations r
            JOIN symbols s ON r.source_symbol_id = s.id
            JOIN symbols target ON r.target_symbol_id = target.id
            JOIN files f ON s.file_id = f.id
            WHERE target.fully_qualified_name IN ({",".join("?" for _ in defining_fqns)})
               OR target.name IN ({placeholders});
        """
        params = list(defining_fqns) + list(defining_names)
        cur.execute(query_inherits, params)
        for rname, rfqn, line, fpath, fid in cur.fetchall():
            context = ""
            full_abs_path = os.path.abspath(os.path.join(repo.workspace_path, fpath))
            try:
                if os.path.exists(full_abs_path):
                    with open(full_abs_path, "r", encoding="utf-8", errors="replace") as f:
                        lines = f.readlines()
                        if 1 <= line <= len(lines):
                            context = lines[line - 1].strip()
            except Exception:
                pass
            callers.append({
                "file": fpath,
                "line": line,
                "column": 0,
                "context": context,
                "kind": "inherit"
            })
            
        # 2. Look up imports from imports table
        query_imports = f"""
            SELECT i.line_number, i.module_path, f.path
            FROM imports i
            JOIN files f ON i.file_id = f.id
            WHERE i.symbol_name IN ({placeholders})
               OR i.module_path IN ({placeholders});
        """
        params_imports = list(defining_names) + list(defining_names)
        cur.execute(query_imports, params_imports)
        for line, mod_path, fpath in cur.fetchall():
            context = ""
            full_abs_path = os.path.abspath(os.path.join(repo.workspace_path, fpath))
            try:
                if os.path.exists(full_abs_path):
                    with open(full_abs_path, "r", encoding="utf-8", errors="replace") as f:
                        lines = f.readlines()
                        if 1 <= line <= len(lines):
                            context = lines[line - 1].strip()
            except Exception:
                pass
            callers.append({
                "file": fpath,
                "line": line,
                "column": 0,
                "context": context,
                "kind": "import"
            })
            
        # 3. Look up calls/names from references table
        query_calls = f"""
            SELECT r.symbol_name, r.fully_qualified_name, r.line, r.column, r.kind, f.path, f.id
            FROM "references" r JOIN files f ON r.file_id = f.id
            WHERE r.symbol_name IN ({placeholders});
        """
        cur.execute(query_calls, list(defining_names))
        rows = cur.fetchall()
        for rname, rfqn, line, col, kind, fpath, fid in rows:
            is_valid = False
            cur.execute("SELECT id FROM symbols WHERE file_id = ? AND fully_qualified_name IN ({});".format(
                ",".join("?" for _ in defining_fqns)
            ), [fid] + list(defining_fqns))
            if cur.fetchone():
                is_valid = True
                
            if not is_valid:
                cur.execute("SELECT module_path FROM imports WHERE file_id = ? AND symbol_name = ?;", (fid, rname))
                for imp_row in cur.fetchall():
                    imp_module = imp_row[0]
                    if imp_module in defining_modules or any(fqn.startswith(imp_module) for fqn in defining_fqns):
                        is_valid = True
                        break
                        
            if not is_valid:
                cur.execute("SELECT COUNT(*) FROM symbols WHERE name = ?;", (rname,))
                if cur.fetchone()[0] <= 1:
                    is_valid = True
                    
            if is_valid:
                context = ""
                full_abs_path = os.path.abspath(os.path.join(repo.workspace_path, fpath))
                try:
                    if os.path.exists(full_abs_path):
                        with open(full_abs_path, "r", encoding="utf-8", errors="replace") as f:
                            lines = f.readlines()
                            if 1 <= line <= len(lines):
                                context = lines[line - 1].strip()
                except Exception:
                    pass
                callers.append({
                    "file": fpath,
                    "line": line,
                    "column": col,
                    "context": context,
                    "kind": "call"
                })
                
        seen = set()
        dedup_callers = []
        for c in callers:
            key = (c["file"], c["line"], c["column"], c["kind"])
            if key not in seen:
                seen.add(key)
                dedup_callers.append(c)
                
        dedup_callers.sort(key=lambda x: (x["file"], x["line"], x["column"]))
        return dedup_callers
    except Exception as e:
        logging.warning(f"Error executing find_callers: {e}")
        return []

def find_implementations(symbol: str, path: str = ".") -> list:
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    
    defining_fqns = set()
    try:
        cur = conn.cursor()
        cur.execute("SELECT fully_qualified_name FROM symbols WHERE (name = ? OR fully_qualified_name = ?) AND type = 'class';", (symbol, symbol))
        for row in cur.fetchall():
            defining_fqns.add(row[0])
    except Exception:
        pass
        
    if not defining_fqns:
        defining_fqns.add(symbol)
        
    implementations = []
    visited = set()
    
    def recurse(target_fqn_or_name):
        if target_fqn_or_name in visited:
            return
        visited.add(target_fqn_or_name)
        
        try:
            cur = conn.cursor()
            cur.execute(
                """SELECT s.name, s.fully_qualified_name, s.type, s.start_line, s.end_line, s.signature, f.path
                FROM relations r
                JOIN symbols s ON r.source_symbol_id = s.id
                JOIN symbols target ON r.target_symbol_id = target.id
                JOIN files f ON s.file_id = f.id
                WHERE r.relation_type = 'inherits' AND (target.fully_qualified_name = ? OR target.name = ?);""",
                (target_fqn_or_name, target_fqn_or_name)
            )
            rows = cur.fetchall()
            for rname, rfqn, rtype, start_line, end_line, signature, fpath in rows:
                impl_entry = {
                    "name": rname,
                    "fully_qualified_name": rfqn,
                    "type": rtype,
                    "file": fpath,
                    "lines": f"{start_line}-{end_line}",
                    "signature": signature
                }
                if impl_entry not in implementations:
                    implementations.append(impl_entry)
                recurse(rfqn)
                recurse(rname)
        except Exception as e:
            logging.warning(f"Error in recurse implementation: {e}")
            
    for fqn in defining_fqns:
        recurse(fqn)
        
    return implementations

def locate_definition_column(line_content: str, symbol_name: str, symbol_type: str) -> int:
    matches = [m.start() for m in re.finditer(r'\b' + re.escape(symbol_name) + r'\b', line_content)]
    if not matches:
        return -1
    if len(matches) == 1:
        return matches[0]
    for m_idx in matches:
        preceding = line_content[:m_idx].rstrip()
        if symbol_type == "class" and preceding.endswith("class"):
            return m_idx
        elif symbol_type == "function" and (preceding.endswith("def") or preceding.endswith("function") or preceding.endswith("async def") or preceding.endswith("async function") or preceding.endswith("const") or preceding.endswith("let") or preceding.endswith("var")):
            return m_idx
    return matches[0]

def rename_symbol(old_fqn: str, new_name: str, path: str = ".", dry_run: bool = True) -> dict:
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    import tempfile
    
    definitions = []
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT s.name, s.type, s.start_line, f.path, f.id
            FROM symbols s JOIN files f ON s.file_id = f.id
            WHERE s.fully_qualified_name = ?;""",
            (old_fqn,)
        )
        definitions = cur.fetchall()
    except Exception:
        pass
        
    if not definitions:
        return {"status": "error", "message": f"Symbol '{old_fqn}' not found in index."}
        
    target_name = definitions[0][0]
    
    usages = []
    try:
        usages = find_callers(old_fqn, path)
    except Exception as e:
        logging.warning(f"Error resolving usages for rename: {e}")
        
    file_edits = {}
    
    for rname, rtype, line, fpath, fid in definitions:
        if fpath not in file_edits:
            file_edits[fpath] = set()
        file_edits[fpath].add((line, -1, rtype, "def"))
        
    for u in usages:
        if u["kind"] in ("call", "import", "inherit"):
            fpath = u["file"]
            if fpath not in file_edits:
                file_edits[fpath] = set()
            file_edits[fpath].add((u["line"], u["column"], u["kind"], "usage"))
            
    modified_contents = {}
    original_contents = {}   # LF-normalized — used for editing and dry-run diff
    original_raw = {}        # exact original bytes — used for rollback
    file_endings = {}        # per-file dominant line ending to restore on write
    
    try:
        for rel_path, edits in file_edits.items():
            abs_path = os.path.abspath(os.path.join(repo.workspace_path, rel_path))
            if not os.path.exists(abs_path):
                continue
                
            # Read exact bytes and detect line endings to preserve formatting on Windows.
            with open(abs_path, "r", encoding="utf-8", errors="replace", newline="") as f:
                raw = f.read()

            file_endings[abs_path] = _detect_line_ending(raw)
            original_raw[abs_path] = raw
            content = raw.replace("\r\n", "\n").replace("\r", "\n")
            original_contents[abs_path] = content
            lines = content.splitlines(keepends=True)
            
            resolved_edits = []
            for edit in edits:
                line_idx, col_idx, rtype_or_kind, category = edit
                if 1 <= line_idx <= len(lines):
                    line_content = lines[line_idx - 1]
                    if category == "def":
                        col_idx = locate_definition_column(line_content, target_name, rtype_or_kind)
                    elif category == "usage" and rtype_or_kind in ("import", "inherit"):
                        match = re.search(r'\b' + re.escape(target_name) + r'\b', line_content)
                        col_idx = match.start() if match else -1
                    else: # category == "usage" and rtype_or_kind == "call"
                        # col_idx is already correct
                        pass
                        
                    if col_idx >= 0:
                        resolved_edits.append((line_idx, col_idx, len(target_name), new_name))
                        
            resolved_edits.sort(key=lambda x: (-x[0], -x[1]))
            
            for line_idx, col_idx, length, replace_text in resolved_edits:
                if 1 <= line_idx <= len(lines):
                    line_str = lines[line_idx - 1]
                    # Safety guard: only rewrite if target matches to avoid corrupting mismatched columns.
                    if 0 <= col_idx and line_str[col_idx:col_idx + length] == target_name:
                        new_line = line_str[:col_idx] + replace_text + line_str[col_idx + length:]
                        lines[line_idx - 1] = new_line
                        
            modified_content = "".join(lines)
            
            try:
                if abs_path.endswith(".py"):
                    ast.parse(modified_content)
                else:
                    with tempfile.NamedTemporaryFile(suffix=".js", delete=False) as tmp_file:
                        tmp_file.write(modified_content.encode("utf-8"))
                        tmp_name = tmp_file.name
                    try:
                        parse_js_file_with_node(tmp_name)
                    finally:
                        try: os.remove(tmp_name)
                        except OSError: pass
            except Exception as e:
                return {
                    "status": "error",
                    "message": f"Syntax verification failed for '{rel_path}': {e}"
                }
                
            modified_contents[abs_path] = modified_content
            
        if dry_run:
            changes = {}
            for abs_path, new_content in modified_contents.items():
                rel = os.path.relpath(abs_path, repo.workspace_path).replace("\\", "/")
                changes[rel] = len(new_content) - len(original_contents[abs_path])
            return {
                "status": "success",
                "message": "Dry run succeeded. AST verification passed.",
                "changes": changes
            }
            
        written_backups = {}
        temp_files = []
        try:
            # 1. Write edits to temporary files first to prevent half-written/partial file states
            for abs_path, new_content in modified_contents.items():
                dir_name = os.path.dirname(abs_path)
                # Restore original line ending; newline="" disables default translation.
                out_content = (new_content.replace("\n", "\r\n")
                               if file_endings.get(abs_path) == "\r\n" else new_content)
                with tempfile.NamedTemporaryFile(mode="w", dir=dir_name, suffix=".tmp", encoding="utf-8", newline="", delete=False) as tf:
                    tf.write(out_content)
                    temp_path = tf.name
                temp_files.append((abs_path, temp_path))
                
            # 2. Swap files atomically
            for abs_path, temp_path in temp_files:
                written_backups[abs_path] = original_raw[abs_path]
                os.replace(temp_path, abs_path)
        except Exception as e:
            # Clean up temporary files on failure
            for _, temp_path in temp_files:
                if os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except OSError:
                        pass
            # Rollback already replaced files to their EXACT original bytes
            # (newline="" → no translation, so endings are restored verbatim).
            for abs_path, orig_content in written_backups.items():
                try:
                    with open(abs_path, "w", encoding="utf-8", newline="") as f:
                        f.write(orig_content)
                except Exception:
                    pass
            raise e
            
        repo.index_workspace()
        
        return {
            "status": "success",
            "message": f"Symbol successfully renamed to '{new_name}'.",
            "renamed_files": [os.path.relpath(p, repo.workspace_path).replace("\\", "/") for p in modified_contents.keys()]
        }
    except Exception as e:
        return {"status": "error", "message": f"Rename failed during execution: {e}"}

def generate_local_summary_for_file(content: str, rel_path: str) -> dict:
    symbols = []
    imports = []
    purpose = f"Code module for {os.path.basename(rel_path)}"
    
    try:
        if rel_path.endswith(".py"):
            data = parse_python_file(content)
            symbols = [f"{s['type']} {s['name']}" for s in data.get("symbols", []) if "." not in s["fully_qualified_name"]]
            imports = list({imp["module_path"] for imp in data.get("imports", [])})
            tree = ast.parse(content)
            doc = ast.get_docstring(tree)
            if doc:
                purpose = doc.split('\n')[0].strip()
    except Exception:
        pass
        
    return {
        "purpose": purpose,
        "exports": symbols[:15],
        "entrypoints": [],
        "dependencies": imports[:10],
        "important_files": [],
        "notes": f"File size: {len(content)} bytes"
    }

def generate_local_summary_for_directory(conn, dir_path: str, workspace_path: str) -> dict:
    cur = conn.cursor()
    cur.execute("SELECT path, hash FROM files WHERE path LIKE ? AND path NOT LIKE ?;", (f"{dir_path}/%", f"{dir_path}/%/%"))
    child_files = cur.fetchall()
    if dir_path == '.':
        cur.execute("SELECT path, hash FROM files WHERE path NOT LIKE '%/%';")
        child_files = cur.fetchall()
        
    cur.execute("SELECT path, summary FROM modules WHERE parent_id = (SELECT id FROM modules WHERE path = ?);", (dir_path,))
    child_dirs = cur.fetchall()
    
    exports = []
    for fpath, _ in child_files:
        exports.append(f"file:{os.path.basename(fpath)}")
    for dpath, _ in child_dirs:
        exports.append(f"dir:{os.path.basename(dpath)}")
        
    return {
        "purpose": f"Directory container for {dir_path}",
        "exports": exports[:15],
        "entrypoints": [],
        "dependencies": [],
        "important_files": [fpath for fpath, _ in child_files[:3]],
        "notes": f"Contains {len(child_files)} files and {len(child_dirs)} directories."
    }

def generate_hierarchical_summaries(path: str = ".") -> dict:
    """Generate structured summaries for all dirty directories and files, caching results in DB."""
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    
    try:
        cur = conn.cursor()
        cur.execute("SELECT id, path FROM modules WHERE dirty = 1 OR summary IS NULL;")
        dirty_modules = cur.fetchall()
        
        updated_count = 0
        for mid, mpath in dirty_modules:
            cur.execute("SELECT id FROM files WHERE path = ?;", (mpath,))
            file_row = cur.fetchone()
            
            if file_row:
                abs_path = os.path.abspath(os.path.join(repo.workspace_path, mpath))
                if os.path.exists(abs_path):
                    try:
                        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                            content = f.read()
                        summary_dict = generate_local_summary_for_file(content, mpath)
                    except Exception:
                        summary_dict = {
                            "purpose": f"Error reading file {mpath}",
                            "exports": [],
                            "entrypoints": [],
                            "dependencies": [],
                            "important_files": [],
                            "notes": ""
                        }
                else:
                    summary_dict = {
                        "purpose": f"File {mpath} not found on disk",
                        "exports": [],
                        "entrypoints": [],
                        "dependencies": [],
                        "important_files": [],
                        "notes": ""
                    }
            else:
                summary_dict = generate_local_summary_for_directory(conn, mpath, repo.workspace_path)
                
            summary_json = json.dumps(summary_dict)
            with repo._db_write_lock:
                with conn:
                    cur.execute(
                        "UPDATE modules SET summary = ?, dirty = 0 WHERE id = ?;",
                        (summary_json, mid)
                    )
            updated_count += 1
            
        return {"status": "success", "message": f"Successfully regenerated {updated_count} summaries."}
    except Exception as e:
        return {"status": "error", "message": f"Summaries generation failed: {e}"}

def compress_context(seed_files: list, path: str = ".", max_tokens: int = 100000) -> str:
    repo = get_repo_index(path)
    conn = repo.get_db_connection()
    
    seed_paths = [sf.replace("\\", "/").lstrip("./").lstrip("../") for sf in seed_files]
    
    try:
        cur = conn.cursor()
        generate_hierarchical_summaries(path)
        
        cur.execute("SELECT id, path, mtime, hash FROM files;")
        all_files = cur.fetchall()
        if not all_files:
            return "Repository index is empty. No context could be generated."
            
        file_map = {row[1]: (row[0], row[2], row[3]) for row in all_files}
        
        distance_map = {}
        for sf in seed_paths:
            if sf in file_map:
                distance_map[file_map[sf][0]] = 0
                
        queue = [file_map[sf][0] for sf in seed_paths if sf in file_map]
        visited = set(queue)
        
        while queue:
            curr_id = queue.pop(0)
            curr_dist = distance_map[curr_id]
            
            cur.execute("SELECT callee_file_id FROM dependencies WHERE caller_file_id = ?;", (curr_id,))
            for (callee_id,) in cur.fetchall():
                if callee_id not in visited:
                    visited.add(callee_id)
                    distance_map[callee_id] = curr_dist + 1
                    queue.append(callee_id)
                    
            cur.execute("SELECT caller_file_id FROM dependencies WHERE callee_file_id = ?;", (curr_id,))
            for (caller_id,) in cur.fetchall():
                if caller_id not in visited:
                    visited.add(caller_id)
                    distance_map[caller_id] = curr_dist + 1
                    queue.append(caller_id)
                    
        mtimes = [row[2] for row in all_files]
        min_mtime = min(mtimes) if mtimes else 0
        max_mtime = max(mtimes) if mtimes else 0
        mtime_range = max_mtime - min_mtime
        if mtime_range == 0:
            mtime_range = 1.0
            
        ref_counts = {}
        for fid, fpath, _, _ in all_files:
            cur.execute("SELECT COUNT(*) FROM \"references\" WHERE file_id = ?;", (fid,))
            ref_counts[fid] = cur.fetchone()[0]
            
        max_ref = max(ref_counts.values()) if ref_counts else 0
        if max_ref == 0:
            max_ref = 1.0
            
        scored_files = []
        for fid, fpath, mtime, fhash in all_files:
            dist = distance_map.get(fid, 10.0)
            dist_score = max(0.0, 1.0 - (dist * 0.25))
            
            rec_score = (mtime - min_mtime) / mtime_range
            ref_score = ref_counts.get(fid, 0) / max_ref
            
            total_score = 0.5 * dist_score + 0.3 * rec_score + 0.2 * ref_score
            scored_files.append((fid, fpath, fhash, total_score))
            
        scored_files.sort(key=lambda x: -x[3])
        
        context_parts = []
        current_chars = 0
        char_limit = max_tokens * 4
        
        for sf in seed_paths:
            if sf in file_map:
                fid, mtime, fhash = file_map[sf]
                abs_path = os.path.abspath(os.path.join(repo.workspace_path, sf))
                if os.path.exists(abs_path):
                    try:
                        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                            content = f.read()
                        payload = f"=== SEED FILE: {sf} ===\n{content}\n\n"
                        context_parts.append(payload)
                        current_chars += len(payload)
                    except Exception:
                        pass
                        
        min_info_score = 0.2
        for fid, fpath, fhash, score in scored_files:
            if fpath in seed_paths:
                continue
            if score < min_info_score:
                continue
            if current_chars >= char_limit:
                break
                
            cur.execute(
                """SELECT file_hash, summary_schema_version, compression_version, compressed_payload
                FROM dependency_pack_cache WHERE file_id = ?;""",
                (fid,)
            )
            row = cur.fetchone()
            if row and row[0] == fhash and row[1] == SUMMARY_SCHEMA_VERSION and row[2] == COMPRESSION_VERSION:
                payload = row[3]
            else:
                cur.execute("SELECT summary FROM modules WHERE path = ?;", (fpath,))
                sum_row = cur.fetchone()
                summary_data = json.loads(sum_row[0]) if sum_row and sum_row[0] else {}
                
                cur.execute("SELECT signature FROM symbols WHERE file_id = ?;", (fid,))
                sigs = [r[0] for r in cur.fetchall() if r[0]]
                
                payload = (
                    f"=== DEPENDENCY FILE: {fpath} ===\n"
                    f"Purpose: {summary_data.get('purpose', '')}\n"
                    f"Exports:\n" + "\n".join(f"  - {s}" for s in summary_data.get('exports', [])) + "\n"
                    f"Signatures:\n" + "\n".join(f"  {s}" for s in sigs) + "\n\n"
                )
                
                with repo._db_write_lock:
                    with conn:
                        cur.execute(
                            """INSERT OR REPLACE INTO dependency_pack_cache 
                            (file_id, file_hash, summary_schema_version, compression_version, compressed_payload)
                            VALUES (?, ?, ?, ?, ?);""",
                            (fid, fhash, SUMMARY_SCHEMA_VERSION, COMPRESSION_VERSION, payload)
                        )
                        
            context_parts.append(payload)
            current_chars += len(payload)
            
        return "".join(context_parts)
    except Exception as e:
        return f"Error compressing context: {e}"

def _eval_test_run(res) -> tuple:
    """Evaluate test run results using structured counts and exit code to prevent substring matching errors."""
    combined = (res.stdout or "") + "\n" + (res.stderr or "")
    m_pass = re.search(r'(\d+)\s+passed', combined)
    m_fail = re.search(r'(\d+)\s+(?:failed|errors?)\b', combined)
    passed = int(m_pass.group(1)) if m_pass else 0
    failures = int(m_fail.group(1)) if m_fail else 0
    if not m_pass and not m_fail:
        # No structured counts in the output — fall back to the exit code.
        passed, failures = (1, 0) if res.returncode == 0 else (0, 1)
    elif res.returncode != 0 and failures == 0:
        # Runner reported passes but still exited non-zero (collection error,
        # teardown failure, etc.) — treat as a failure so a broken run is never
        # called "fixed".
        failures = 1
    return passed, failures


def autonomous_repair_loop(file_path: str, edit_instruction: str, test_command: str, path: str = ".", max_iterations: int = 3) -> dict:
    repo = get_repo_index(path)
    abs_file_path = os.path.abspath(os.path.join(repo.workspace_path, file_path.replace("\\", "/").lstrip("./").lstrip("../")))
    import tempfile
    
    if not os.path.exists(abs_file_path):
        return {"fixed": False, "confidence": 0.0, "tests_passed": 0, "lint_errors": 0, "iterations": 0, "error": "File not found."}
        
    try:
        with open(abs_file_path, "r", encoding="utf-8", errors="replace", newline="") as f:
            raw = f.read()
        ending = _detect_line_ending(raw)
        original_content = raw.replace("\r\n", "\n").replace("\r", "\n")
    except Exception as e:
        return {"fixed": False, "confidence": 0.0, "tests_passed": 0, "lint_errors": 0, "iterations": 0, "error": f"Failed to read file: {e}"}

    def _write_repaired(content: str) -> None:
        out = content.replace("\n", "\r\n") if ending == "\r\n" else content
        with open(abs_file_path, "w", encoding="utf-8", newline="") as f:
            f.write(out)
        
    # Calculate baseline score of original content
    baseline_syntax_errors = 0
    try:
        if abs_file_path.endswith(".py"):
            ast.parse(original_content)
        else:
            with tempfile.NamedTemporaryFile(suffix=".js", delete=False) as tmp_file:
                tmp_file.write(original_content.encode("utf-8"))
                tmp_name = tmp_file.name
            try:
                parse_js_file_with_node(tmp_name)
            finally:
                try: os.remove(tmp_name)
                except OSError: pass
    except Exception:
        baseline_syntax_errors = 1
        
    baseline_tests = 0
    baseline_lint = 0
    if test_command:
        try:
            res = subprocess.run(
                test_command,
                shell=True,
                cwd=repo.workspace_path,
                capture_output=True,
                text=True,
                timeout=30.0
            )
            baseline_tests, baseline_lint = _eval_test_run(res)
        except Exception:
            pass
            
    best_score = baseline_tests - baseline_lint - 1000 * baseline_syntax_errors
    best_content = original_content
    last_run_metrics = {
        "tests_passed": baseline_tests,
        "lint_errors": baseline_lint,
        "syntax_errors": baseline_syntax_errors
    }
    # Metrics for best_content (what is actually left on disk after the loop).
    best_metrics = dict(last_run_metrics)
    current_content = original_content
    current_iteration = 0
    
    for i in range(1, max_iterations + 1):
        current_iteration = i
        modified_content = current_content
        if "<<<old<<<" in edit_instruction and "===new===" in edit_instruction:
            try:
                parts = edit_instruction.split("<<<old<<<")
                for part in parts[1:]:
                    sub_parts = part.split("===new===")
                    # Normalize patch text to LF to match LF-normalized file content.
                    old_text = sub_parts[0].replace("\r\n", "\n").replace("\r", "\n")
                    new_text = (sub_parts[1].split(">>>end>>>")[0]
                                .replace("\r\n", "\n").replace("\r", "\n"))
                    modified_content = modified_content.replace(old_text, new_text)
            except Exception:
                pass
        else:
            # No markers: refuse instead of overwriting entire file.
            try:
                _write_repaired(original_content)  # ensure file is left untouched
            except Exception:
                pass
            return {
                "fixed": False, "confidence": 0.0,
                "tests_passed": baseline_tests, "lint_errors": baseline_lint,
                "iterations": i,
                "error": (
                    "edit_instruction must contain '<<<old<<< ... ===new=== ... >>>end>>>' "
                    "markers. Refusing to overwrite the whole file with the raw instruction."
                ),
            }
                
        try:
            _write_repaired(modified_content)
        except Exception as e:
            try:
                _write_repaired(original_content)
            except Exception:
                pass
            return {"fixed": False, "confidence": 0.0, "tests_passed": 0, "lint_errors": 0, "iterations": i, "error": f"Failed to write edits: {e}"}
            
        syntax_errors = 0
        try:
            if abs_file_path.endswith(".py"):
                ast.parse(modified_content)
            else:
                with tempfile.NamedTemporaryFile(suffix=".js", delete=False) as tmp_file:
                    tmp_file.write(modified_content.encode("utf-8"))
                    tmp_name = tmp_file.name
                try:
                    parse_js_file_with_node(tmp_name)
                finally:
                    try: os.remove(tmp_name)
                    except OSError: pass
        except Exception:
            syntax_errors = 1
            
        tests_passed = 0
        lint_errors = 0
        
        if test_command:
            try:
                res = subprocess.run(
                    test_command,
                    shell=True,
                    cwd=repo.workspace_path,
                    capture_output=True,
                    text=True,
                    timeout=30.0
                )
                tests_passed, lint_errors = _eval_test_run(res)
            except Exception:
                pass
                
        score = tests_passed - lint_errors - 1000 * syntax_errors
        
        last_run_metrics = {
            "tests_passed": tests_passed,
            "lint_errors": lint_errors,
            "syntax_errors": syntax_errors
        }
        
        if score > best_score:
            best_score = score
            best_content = modified_content
            best_metrics = dict(last_run_metrics)
            current_content = modified_content
        else:
            try:
                _write_repaired(best_content)
                current_content = best_content
            except Exception:
                pass
                
        if syntax_errors == 0 and lint_errors == 0 and tests_passed > 0:
            break
            
    # Report metrics for best_content left on disk, not last_run_metrics.
    total_errors = best_metrics["lint_errors"] + 1000 * best_metrics["syntax_errors"]
    base_confidence = best_metrics["tests_passed"] / (best_metrics["tests_passed"] + total_errors + 1.0)
    confidence = base_confidence * (1.0 - 0.05 * min(current_iteration, 10))
    confidence = max(0.0, min(1.0, confidence))
    
    fixed = best_metrics["syntax_errors"] == 0 and best_metrics["lint_errors"] == 0
    
    return {
        "fixed": fixed,
        "confidence": round(confidence, 2),
        "tests_passed": best_metrics["tests_passed"],
        "lint_errors": best_metrics["lint_errors"],
        "iterations": current_iteration
    }
