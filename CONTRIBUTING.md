# Contributing to Proxima

Thanks for your interest in improving Proxima. Proxima is a local AI engine
(Electron desktop app) that unifies ChatGPT, Claude, Gemini, and Perplexity
behind one API, and ships a local Python agent. This guide covers
how to set up, test, and submit changes.

> **License note:** Proxima is licensed for **personal, non-commercial use**
> (see [LICENSE](LICENSE)). By contributing, you agree your contributions are
> provided under the same terms.

---

## Table of contents
- [Ways to contribute](#ways-to-contribute)
- [Project layout](#project-layout)
- [Local setup](#local-setup)
- [Running the tests](#running-the-tests)
- [Mock strategy (important)](#mock-strategy-important)
- [Coding style](#coding-style)
- [Fork → branch → PR workflow](#fork--branch--pr-workflow)
- [Commit messages](#commit-messages)
- [Reporting bugs & requesting features](#reporting-bugs--requesting-features)

---

## Ways to contribute
- Fix bugs or improve reliability of the provider engines / BYOK providers.
- Add or harden tests (see [TESTING.md](TESTING.md)).
- Improve docs (`docs/`, `README`, this file).
- Propose features via a [feature request](.github/ISSUE_TEMPLATE/feature_request.md) **before** large PRs.

## Project layout

Proxima is **two codebases in one repo** — a JavaScript/Electron side and a
Python agent side. Know which one your change touches:

```
electron/            Electron main process (CommonJS .cjs)
  api/               REST API, routes (DI), ws-server, pages/, byok/
  providers/         engines/ (per-provider fetch+SSE) + sender.cjs, api.cjs
  ipc/               IPC handlers (core, settings, cli)
src/                 MCP server + agentic system (ESM, "type": "module")
  mcp/               Modular MCP tools (registerTool pattern)
  agentic/ core/ memory/ quality/ retry/ cost/ config/ utils/ tools/
cli/                 proxima-cli.cjs (terminal client)
sdk/                 Python + JavaScript SDKs
proxima-agent/       Python local agent (separate package)
tests/               JavaScript test suite (node --test)
proxima-agent/tests/ Python test suite (unittest)
docs/                architecture.md, openapi.json, build/deploy guides
```

Two runtime modes you must keep working:
- **Session mode** (default): talks to providers through your logged-in browser
  sessions via the engine scripts (`electron/providers/engines/*`). No API keys.
- **BYOK mode**: uses your own provider API keys (`electron/api/byok/*`).

## Local setup

**Requirements:** Node.js 18+ and Python 3.10+.

```bash
git clone https://github.com/Zen4-bit/Proxima.git
cd Proxima
npm install            # JavaScript / Electron deps
npm start              # launch the Electron app (optional)
```

Python agent (only if you touch `proxima-agent/`):

```bash
cd proxima-agent
python -m venv .venv
.venv\Scripts\activate         # Windows
# source .venv/bin/activate    # macOS / Linux
pip install -e .
```

## Running the tests

**Every change must keep both suites green.** See [TESTING.md](TESTING.md) for
the full guide.

JavaScript (from repo root):
```bash
npm test
# single file while iterating:
node --test tests/utils/paths.test.js
```

Python (from `proxima-agent/`):
```bash
python -m unittest discover -s tests -p "test_*.py"
# single module:
python -m unittest tests.test_config
```

> Note: Python's `unittest` prints progress dots to **stderr**; on Windows
> PowerShell that can show a `RemoteException` and a non-zero exit even on
> success — trust the final `OK` / `FAILED` line.

CI runs exactly these commands on every PR (Node 18 & 20, Python 3.10–3.12).

## Mock strategy (important)

Proxima follows one rule for tests: **mock at the boundary, never mock the thing
you are testing.** We test real logic; we only replace the edges that touch the
outside world.

| Boundary | How it's mocked |
|----------|-----------------|
| Provider HTTP / LLM APIs | inject a fake `chatFn` / `sendToModel`; patch `global.fetch` (JS) or `urllib.request.urlopen` (Py) |
| Filesystem data dirs | redirect via env (`PROXIMA_DATA_DIR`, `APPDATA`) or patch the module's path constant |
| SQLite stores | point the DB path at a temp dir; fresh instance per test |
| `subprocess` (git/shell/node) | patch `subprocess.run`/`Popen`, assert the argv list |
| Electron / ws / HTTP servers | inject dependencies (see `routes.cjs` `createRouteHandler(deps)`) and assert with spies |
| OS/GUI (pyautogui, pywinauto, CDP) | patch the probe (`_cdp_alive`, `_check_browser`) so nothing launches |
| time / randomness | assert ranges or pass explicit `now`/seeds; no `sleep()` |

**Banned:** always-pass tests (`expect(true).toBe(true)`), asserting a mock was
called without asserting the outcome, real network/DB/file writes outside temp
dirs, `.skip()` without a documented reason. New behaviour → new test. Bug fix →
a regression test that fails on the old code.

If code is hard to test because it mixes I/O with logic, extract the pure logic
into a function and test that (this is how most of the suite is built).

## Coding style

**JavaScript**
- `src/` is ESM (`import`/`export`, `"type": "module"`). `electron/`, `cli/`,
  and `src/tools/*.cjs` are CommonJS (`require`/`module.exports`).
- Load a `.cjs` module from an ESM test with `createRequire(import.meta.url)`.
- 4-space indentation; keep JSDoc on exported functions.
- Use the established patterns: **dependency injection** (`init(deps)` /
  `createXxx(deps)`) and **`server.registerTool(name, schema, handler)`** for
  MCP tools.
- File-size policy (from `docs/architecture.md`): logic/template files ≤ ~400
  lines, orchestrators/DOM-heavy files ≤ ~800. Split modules that grow past this.
- No new runtime dependency without a clear reason — prefer stdlib.

**Python (`proxima-agent/`)**
- Target Python 3.10+. Tests use **`unittest`** — do **not** add pytest.
- 4-space indentation, type hints and docstrings on public functions.
- Lint with `ruff` if available; keep functions small and pure where possible.
- Best-effort I/O (disk/network/OS) must never crash the agent — swallow and
  return a clear result, matching the existing modules.

**General**
- Match the surrounding file's style; don't reformat unrelated code.
- Never commit secrets, API keys, `.env`, cookies, or `node_modules`/`.venv`.
- Keep provider behaviour working in **both** Session and BYOK modes.

## Fork → branch → PR workflow

1. **Fork** the repo on GitHub and clone your fork.
2. Create a topic branch off `main`:
   ```bash
   git checkout -b fix/gemini-stream-idle-timeout
   ```
   Use a descriptive prefix: `fix/`, `feat/`, `docs/`, `test/`, `refactor/`.
3. Make focused changes. Add/adjust tests. Run **both** test suites locally.
4. Commit (see message style below) and push to your fork.
5. Open a **Pull Request against `main`**. Fill in the
   [PR template](.github/PULL_REQUEST_TEMPLATE.md): what changed, why, and test
   status.
6. CI must pass. Address review feedback by pushing new commits to the branch.
7. Keep PRs small and single-purpose — large mixed PRs are hard to review.

Do not push directly to `main`. All changes go through a PR.

## Commit messages
- Short imperative subject (≤ ~70 chars): `fix: reset Gemini stream on new chat`.
- Optional body explaining the *why* and any tradeoffs.
- Reference issues with `Fixes #123` when applicable.

## Reporting bugs & requesting features
- **Security vulnerabilities:** do **not** open a public issue — see
  [SECURITY.md](SECURITY.md).
- **Bugs:** use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md).
- **Features:** use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md).

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).
