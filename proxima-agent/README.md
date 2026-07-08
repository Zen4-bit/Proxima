# Proxima Agent: Coding & Codebase Manipulation Tools

Proxima Agent is powered by a dynamic execution loop. Instead of just writing text, the agent executes Python scripts natively on the host system to interact with your codebase. 

All core tools are exposed in the convenience package `proxima_agent.tools.code_env`. This guide documents the specific APIs available to the agent for managing, editing, searching, and validating files on the user's host PC.

---

## 1. Core Concept: Sandbox Execution

The agent is provided with a single tool: `execute(code: str)`.
Within this Python execution environment, the agent has full access to the file system, network, shell, and desktop display. It uses these APIs to perform complex software engineering operations.

---

## 2. Existing Capabilities: Audit Summary

The agent's built-in toolset includes:
- **Discovery-First Registry**: Dynamic API discovery using `list_tools()` and `describe_tool()`.
- **Git Primitives**: Highly secure shell-gated helpers (`git_status()`, `git_diff()`, `git_commit()`, `git_branch()`, `git_stash()`, `git_blame()`).
- **File Primitives**: Read, write, insert, delete, and copy/move helpers alongside whitespace/unicode-tolerant fuzzy line edit matching (`edit_file()`, `patch_file()`).
- **Telemetry & Diagnostics**: `env_state()` (process/window tracking), `recorder` (tool call log playback), and `analytics` (failure metrics).

---

## 3. Next-Generation Architecture: The 10 Pillars of a Claude Code-Grade Agent

To transition from a helper script runner to a repository-level autonomous engineer, development must focus on **Repository Intelligence & Agent Reasoning Infrastructure**. Below are the 10 pillars that define this roadmap:

### 1. Repository Indexing (Active Startup Maps)
* **Goal**: Replace simple `grep` cycles with an instantly available codebase mental map.
* **Blueprint**: On startup, run a background thread to generate and cache:
  * **ProjectMap**: File tree, types, and directories.
  * **SymbolMap**: Location of all classes, functions, and variables.
  * **ImportGraph**: Directional import declarations showing file relationships.
  * **TestGraph**: Mapping of files to their respective unit tests.
* **ROI**: Speeds up codebase navigation by $10\times$ on large repositories.

### 2. Semantic Navigation (Tree-sitter & LSP)
* **Goal**: Provide compiler-grade codebase understanding instead of simple regex pattern matching.
* **Blueprint**: Integrate Tree-sitter parsers or communicate with active Language Server Protocol (LSP) servers (such as `pyright`, `tsserver`, or `gopls`) to support:
  * `find_definition(symbol)`
  * `find_references(symbol)`
  * `find_implementations(interface)`
  * `rename_symbol(symbol, new_name)` (global, multi-file renaming)

### 3. Dependency Graphs & Impact Analysis
* **Goal**: Give the agent visibility into how local changes ripple across the repository.
* **Blueprint**: Implement `get_impacted_files(path)` and `get_impacted_tests(path)` using the ImportGraph. If the agent edits `auth/user.py`, the system flags affected modules (e.g. login flow, API controller, and associated tests) to prevent silent breakages.

### 4. Project Intelligence (`analyze_project()`)
* **Goal**: Eliminate blind manual discovery of language runtime environments.
* **Blueprint**: Implement an auto-detection tool that parses configuration files (e.g. `package.json`, `cargo.toml`, `pyproject.toml`, `tsconfig.json`) on startup and outputs:
  ```json
  {
    "language": "typescript",
    "framework": "nextjs",
    "build": "pnpm",
    "tests": "vitest",
    "entrypoints": ["src/app/page.tsx", "src/server/index.ts"]
  }
  ```
  This immediately informs the agent of the target compilation, package management, and test workflows.

### 5. Incremental Context Compression
* **Goal**: Prevent token overflow and reduce context bloat during codebase operations.
* **Blueprint**: Rather than reading hundreds of raw files, maintain hierarchical, LLM-generated vector summaries:
  * **File Summaries**: High-level descriptions of exports and functionality.
  * **Module Summaries**: Descriptions of directory responsibilities (e.g. "auth handles JWT verification and talks to db").
  * **Architecture Summaries**: Core interactions.
  The agent reasons over compressed summaries first and pulls raw files only when it needs to write changes.

### 6. Change Impact Engine
* **Goal**: Enable safer refactoring of core codebase objects.
* **Blueprint**: Implement an impact estimator that warns the agent before executing edits:
  * Example: Renaming `UserService` reports: `"This will impact 22 references across 5 files, 7 test suites, and 3 imports. Proceed?"`
  * Automatically coordinates multi-file updates to maintain compilation states.

### 7. Coding Verification Engine
* **Goal**: Replace fragile verification heuristics with strict validation pipelines.
* **Blueprint**: Enforce a transactional pipeline for every code modification:
  $$\text{Read} \to \text{Edit} \to \text{Validate (Syntax/Lint)} \to \text{Run Tests} \to \text{Build} \to \text{Done}$$
  The agent is blocked from completing a task if any validation step fails.

### 8. Long-Running Task Memory
* **Goal**: Maintain planning stability across complex, multi-turn coding sessions.
* **Blueprint**: Persist a structured state file (e.g., `task_memory.json`) tracking:
  * **Task Goal**: The ultimate target.
  * **Current Plan**: The step-by-step breakdown.
  * **Files Edited**: History of touched resources.
  * **Tests Run & Results**: Active test status.
  * **Known Issues**: Ongoing debug logs.
  This prevents the agent from losing context, repeating failed paths, or getting stuck in loops.

### 9. Architecture-Aware Planning
* **Goal**: Guide the agent to think at a system level rather than editing file-by-file.
* **Blueprint**: Enforce multi-tier planning prompts that force the agent to categorize changes into logical layers:
  `[Backend Config] -> [Database Migration] -> [API Handler] -> [UI Component] -> [Unit Tests] -> [Docs]`
  Ensures clean code separation and consistent design patterns.

### 10. Autonomous Repair Loop
* **Goal**: Self-correct compiler, test, and lint failures without user intervention.
* **Blueprint**: Integrate compiler outputs and test failures directly back into the execution loop:
  1. Make edit.
  2. Run `lint`/`test` command.
  3. On fail: Capture stderr output $\to$ feed traceback back to agent $\to$ request correction.
  4. Repeat until clean verification.

---

## 4. Reference APIs

### File Operations (`file_ops`)
- `read_file(path, start=None, end=None, raw=False)`: Read file with/without line-number prefixes.
- `read_file_raw(path)`: Read raw text.
- `write_file(path, content)`: Write/overwrite.
- `edit_file(path, old, new, count=1)`: Search and replace with whitespace-tolerant regex fallback.
- `insert_lines(path, line_num, content)`: Insert lines.
- `delete_lines(path, start, end)`: Delete lines.
- `patch_file(path, edits: list[dict])`: Sequential multi-chunk text edit.
- `copy_file(src, dst)`: Copy files/folders.
- `move_file(src, dst)`: Move/rename files/folders.

### Search Operations (`search_ops`)
- `grep(query, path=".", regex=False, include=None)`: Recursive regex grep.
- `find_replace(query, replacement, path=".", dry_run=True)`: Multi-file find & replace (dry run by default).
- `find_files(pattern, path=".")`: Glob search.
- `tree(path=".", depth=3)`: Folder tree layout.

### Code Intelligence (`code_intel`)
- `syntax_check(path)`: Validate Python files before run.
- `lint(path)`: Run linters (pyflakes, pylint, node, eslint, tsc, json, html, css validation).
- `validate_project(path)`: Project-wide syntax and linting checks.
- `find_functions(path)`: Extract classes and functions.
- `get_imports(path)`: List imported modules.
- `diff_files(file1, file2)`: Unified diff.
