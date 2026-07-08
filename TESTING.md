# Testing Guide

This document explains how Proxima's test suites are organized, how to run them,
the mocking philosophy every test follows, which modules are intentionally not
unit-tested (and why), and how to test new code you contribute.

Proxima has **two independent suites**:

| Suite | Language | Runner | Location |
|-------|----------|--------|----------|
| JavaScript | Node.js (ESM) | `node --test` | `tests/` |
| Python | CPython 3.12 | `unittest` | `proxima-agent/tests/` |

At the time of writing: **JS 623 tests / Python 423 tests — all green.**

---

## 1. Running the tests

### JavaScript

From the repository root:

```bash
npm test
```

This runs the glob `tests/**/*.test.js` via Node's built-in test runner. The
project is ESM (`"type": "module"` in `package.json`), so `.cjs` modules are
loaded inside tests with `createRequire`:

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const keys = require('../../electron/api/byok/keys.cjs');
```

Run a single file (useful while iterating):

```bash
node --test tests/utils/paths.test.js
```

Run several files:

```bash
node --test tests/agentic/smart-router.test.js tests/agentic/handoff.test.js
```

> Note: this Node version does not accept a bare directory argument
> (`node --test tests/utils/` fails). Pass explicit file paths, or use
> `npm test` for the full glob.

### Python

Always run from the `proxima-agent/` directory using the project virtualenv
(**not** pytest — pytest is not a dependency):

**Windows (PowerShell/CMD):**
```bash
cd proxima-agent
.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
```

**macOS/Linux:**
```bash
cd proxima-agent
.venv/bin/python -m unittest discover -s tests -p "test_*.py"
```

Run a single module or test:

**Windows:**
```bash
.venv\Scripts\python.exe -m unittest tests.test_config
.venv\Scripts\python.exe -m unittest tests.test_config.TestBYOKKeys.test_short_key_rejected
```

**macOS/Linux:**
```bash
.venv/bin/python -m unittest tests.test_config
.venv/bin/python -m unittest tests.test_config.TestBYOKKeys.test_short_key_rejected
```

Syntax-check a file without running it:

```bash
# Windows
.venv\Scripts\python.exe -m py_compile proxima_agent/tools/utils.py

# macOS/Linux
.venv/bin/python -m py_compile proxima_agent/tools/utils.py
```

> On Windows/PowerShell, `unittest` prints progress dots to **stderr**, which
> PowerShell surfaces as a `RemoteException` and sets exit code 1 even on
> success. The authoritative signal is the final `OK` / `FAILED (...)` line, not
> the shell exit code. In CI (bash), the exit code is reliable.

---

## 2. Test file layout

Test files **mirror the source tree** and use the `.test.js` / `test_*.py`
naming convention.

```
src/utils/paths.js            → tests/utils/paths.test.js
electron/api/routes.cjs       → tests/electron/api/routes.test.js
proxima_agent/config.py       → proxima-agent/tests/test_config.py
proxima_agent/recall/vault.py → proxima-agent/tests/test_recall_vault.py
```

Shared fixtures live in `tests/fixtures/` (JS). Reusable Python fakes are kept
local to each test file (small, explicit) rather than in a shared conftest.

---

## 3. Mocking philosophy — **mock at the boundary, only**

The single rule that governs every test in this repo:

> **Mock the boundary (I/O, network, OS, GUI, subprocess, DB, clock).
> Never mock the thing you are testing.**

We test *real behaviour and real logic*. We replace only the edges where the
code talks to the outside world. Concretely:

| Boundary | How it's mocked |
|----------|-----------------|
| HTTP / provider APIs | Inject a fake `chatFn`/`sendToModel`; patch `global.fetch` (JS) or `urllib.request.urlopen` (Py) |
| Filesystem data dirs | Redirect to a temp dir via env (`PROXIMA_DATA_DIR`, `APPDATA`) or by patching the module's path constant (`MEMORY_DB_PATH`, `VAULT_DB_PATH`, `CONFIG_PATH`) |
| SQLite stores | Point the DB path at a `tempfile` dir, construct a fresh instance per test |
| `subprocess` (git, shell, node) | Patch `subprocess.run` / `Popen` and assert the **argv list** + returncode/stdout mapping |
| Electron / `ws` server / HTTP server | Inject dependencies (see `routes.cjs` `createRouteHandler(deps)`) and assert routing decisions with spies |
| OS/GUI (pyautogui, pywinauto, CDP/Chrome) | Patch the probe (`_cdp_alive`, `_check_browser`) so nothing launches |
| Time / randomness | Assert ranges, or pass explicit `now`/seeds; never `sleep()` |

Real temp files **are** used for pure file helpers (`file_ops`, `search_ops`,
`code_intel`) — that is real behaviour on a throwaway path, not a network/OS
boundary, so it is not mocked.

### What a good test looks like

- Tests **behaviour**, not implementation details.
- **Fails** if the code breaks; **passes** when it's correct.
- Has a description that completes: *"it should [behaviour] when [condition]"*.
- Uses **Arrange → Act → Assert**, and cleans up (temp dirs, env, patches) in
  teardown so tests are isolated and order-independent.
- Deterministic: same result every run, in any order, offline.

### Banned patterns (these will be rejected in review)

- `expect(true).toBe(true)` / `assertTrue(True)` — always-pass tests.
- Asserting only that a mock was *called*, without asserting the *outcome*.
- `expect(x).toBeDefined()` unless `undefined` is the genuine failure condition.
- Real network calls, real writes outside a temp dir, real DB, real `sleep()`.
- `.skip()` / commented-out tests without a reason.

---

## 4. Intentionally NOT unit-tested (skip-with-reason)

Some modules are pure runtime/OS/network wrappers with **no isolatable logic**.
We do not write fake tests for them; we document them and cover their *pure*
building blocks instead. These are integration/E2E concerns.

### JavaScript

| Module | Reason | What IS covered |
|--------|--------|-----------------|
| `electron/api/rest-api.cjs` | Boots an HTTP server; key helpers resolve storage via `electron.app.getPath()` | Routing logic covered via DI in `routes.test.js` |
| `electron/api/ws-server.cjs` | All exports need a live `ws.Server` | — (E2E) |
| `src/mcp/index.js` | MCP server bootstrap/registration | Tool registration verified in P0 tests |
| `electron/main-v2.cjs`, provider engines, `browser-manager.cjs` | Electron main-process / live browser views | Pure parsers/classifiers/builders extracted and tested |

### Python

| Module | Reason | What IS covered |
|--------|--------|-----------------|
| `tools/computer/*`, `tools/desktop/*` | OS UI-automation wrappers (pywinauto / AT-SPI / Accessibility) | — |
| `tools/browser_cdp.py` | Live Chrome DevTools connection | Passive `state.py` probe path tested with CDP mocked |
| `tools/ocr.py` | Native OCR engine / language packs | — |
| `tools/execute.py`, `agent.py` | Executes real code / full agent loop | `gate.py`, `error_classifier`, `retry_utils` tested |
| `web/server.py` | FastAPI server | — |
| `multi_agent/subagent.run_subagent` | Real `openai` client + real `execute_code` | Its helpers (prompt build, code extract, trim) tested |
| `recall/vault` indexer & `repo_intel.RepositoryIndex` | Background threads + SQLite index + Node acorn subprocess | Pure parsing (`parse_python_file`, `PyVisitor`, lineage rules) tested |

If you make one of these unit-testable by extracting pure logic, please add
tests for the extracted part and update this table.

---

## 5. Contributing new code — how to test it

**New code must ship with tests.** Follow these steps:

1. **Create the mirror test file.**
   `src/foo/bar.js` → `tests/foo/bar.test.js`
   `proxima_agent/foo/bar.py` → `proxima-agent/tests/test_bar.py`

2. **Cover the contract, per module type:**
   - *Utilities/helpers:* happy path, edge cases (empty/null/zero/boundary),
     unexpected input types, error cases, return-shape.
   - *CLI commands:* valid args → expected stdout/exit; missing/invalid args →
     clear error + non-zero exit; piped/file input.
   - *SDK / tool methods:* given input X → output shape Z; resolved AND rejected
     promises; every public method covered.
   - *MCP tools:* schema enforced; valid input → correct output; invalid input →
     correct error structure; tool is registered/discoverable.
   - *Agents:* decision logic (state → action), tool selection, multi-step
     chaining, graceful failure recovery, correct stop/escalate boundaries.
   - *External calls:* mock the HTTP client; test 2xx, 4xx, 5xx, malformed
     bodies, timeouts/connection failures.
   - *Config/env:* present → works; missing → clear failure; defaults applied.

3. **Mock only the boundary** (Section 3). If your code is hard to test because
   it mixes I/O with logic, that's a design smell — extract the pure logic into
   a function and test that directly (this is how most of the suite was built).

4. **Keep it isolated & deterministic:** temp dirs, restore env/patches in
   teardown, no reliance on test order, no network, no `sleep`.

5. **Run the relevant suite and make it green** before opening a PR:
   ```bash
   npm test                                   # JS changes
   
   # Python changes (Windows)
   cd proxima-agent && .venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
   
   # Python changes (macOS/Linux)
   cd proxima-agent && .venv/bin/python -m unittest discover -s tests -p "test_*.py"
   ```
   For JS, also run `get_diagnostics`/your editor's problem panel — the suite
   must stay at zero diagnostics.

6. **Regression tests for bug fixes:** when you fix a bug, add a test that fails
   on the old behaviour and passes on the fix. Reference the behaviour in the
   test name (e.g. `test_element_not_found_beats_generic_not_found`).

7. **If you must skip** a module, say **why** in the test file's docstring and
   add a row to the Section 4 table — never leave a silent gap or a fake test.

---

## 6. Quick reference

```bash
# JS — everything
npm test

# JS — one file
node --test tests/utils/paths.test.js

# Python — everything (from proxima-agent/)
# Windows:
.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
# macOS/Linux:
.venv/bin/python -m unittest discover -s tests -p "test_*.py"

# Python — one module / one test
# Windows:
.venv\Scripts\python.exe -m unittest tests.test_config
.venv\Scripts\python.exe -m unittest tests.test_config.TestGetLimit
# macOS/Linux:
.venv/bin/python -m unittest tests.test_config
.venv/bin/python -m unittest tests.test_config.TestGetLimit

# Python — syntax check only
# Windows:
.venv\Scripts\python.exe -m py_compile proxima_agent/<path>.py
# macOS/Linux:
.venv/bin/python -m py_compile proxima_agent/<path>.py
```
