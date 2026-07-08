# Changelog

All notable changes to Proxima are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Dates reflect the project's 2026 development cycle. Where the repository did
> not record an exact release day, the day is omitted.

## [5.0.0] - 2026-07

A major release that expands Proxima from a browser-session gateway into a full agentic platform. It introduces a modular local agentic pipeline inside the MCP process, an autonomous self-healing Python execution agent, Bring-Your-Own-Key (BYOK) mode with context compaction, and advanced repository intelligence utilities.

### Added
- **Context7 Documentation Middleware (`context7-middleware.js`)** — Automatically matches user queries against regex patterns of popular libraries (React, Next.js, Vue, Svelte, Tailwind, Express, Fastify, Docker, PyTorch, etc.) and queries the Context7 API (`https://mcp.context7.com/v1/context`) to pull the latest documentation, caching results locally (TTL 10m, Max 200) to keep LLMs updated.
- **EMA-based Smart Routing & Recovery Loop (`smart-router.js`)** — Classifies user prompts using pattern maps and routes queries to providers based on capability profiles, EMA latencies (`new_avg = old_avg * 0.7 + call_time * 0.3`), and health states. Temporarily disables a provider if it hits 3 consecutive errors.
- **Intelligent Memory Decay & Fact Harvesting (`memory-intelligence.js`)** — Automatically harvests user facts, tech stacks, and preferences from conversation inputs. Scores the quality of extracted facts and implements a 7-day half-life decay function, archiving facts that fall below a 0.10 score.
- **Risk-Weighted Safety Gating & Interactive Suggest Mode (`permissions.py`)** — Scores agent code blocks based on risk weights (e.g. `rm -rf`, `os.system` are weight 3; `pip install` is weight 2). Halt execution for manual confirmation in **Smart Mode** if risk score `>= 3`, or output an interactive `[SUGGEST]` block of alternatives in **Suggest Mode** and wait for user selection.
- **CDP Chrome Automation Driver (`tools/browser_cdp.py`)** — Standalone, 2200-line browser automation engine in Python that interfaces Google Chrome over CDP/WebSockets without Selenium or WebDriver dependencies, enabling the agent to open tabs, type, click, capture console logs, and take screenshots.
- **Context Compaction Pipeline (`pruner.cjs` & `condenser.cjs`)** — Implements token-budgeted pruning to replace verbose tool outputs with brief text summaries (e.g., `[read_file] src/server.js (15,223 chars)`) and trims assistant tool arguments. Implements a condenser that uses LLM summaries to replace middle conversation turns while leaving system prompts and recent turns intact.
- **FastAPI Console Origin Guard (`web/server.py`)** — Exposes routes on port 8500 protected by an origin-guard middleware blocking any CORS request not originating from loopback paths (`localhost` or `127.0.0.1`), and runs gateway health checks targeting `/v1/models`.
- **BYOK (Bring Your Own Key) Mode** — Use your own provider API keys instead of browser sessions. Supported providers: OpenAI, Anthropic, Google, Perplexity, and any **OpenAI-compatible** endpoint (Ollama, LM Studio, DeepSeek, Groq, OpenRouter, Together, Mistral, NVIDIA NIM, etc.) utilizing system-native OS keychain encryption (SafeStorage). Features per-provider multi-model selection and connection testing. (`electron/api/byok/`)
- **Proxima Agent Autonomous System** — Standalone local Python runtime (`proxima-agent/`) featuring:
  - **Self-Healing Run Loop** (`tools/execute.py` & `tools/self_heal.py`): Model code compilation within sandboxed workers, catching compiler/test failures and automatically patching runtime errors.
  - **Experience Learning DB** (`tools/learned_fixes.py`): Tracks execution failure->fix patterns in a local SQLite database to prevent repeating errors.
  - **Dual OCR Engine** (`tools/ocr.py`): Extract page/screen text using Tesseract OCR or macOS-native Vision APIs.
- **Proxima Agent Interactive CLI** — Interactive console shell (`proxima-agent`) supporting signal/crash trapping, runtime model selection, active file pinning, and session history management.
- **Codebase Packing & Symbol Slicing** — Specialized parser utility suite (`src/utils/`):
  - `codebase-packer.js`: Packages repositories into a single context payload with automated secret scanning and gitignore filtering.
  - `smart-slicer.js` & `symbol-extractor.js`: AST-like extraction of class/function symbols to minimize prompt context token overhead.
- **Local Cost Auditing System** — SQLite cost tracking engine (`src/cost/`) that audits raw token consumption, input/output counts, and estimated cost metrics across all active models.
- **Environment Diagnostics & Guardrails** — Runtime checks (`electron/env-check.cjs`) verifying Google Chrome, Tesseract OCR, and Linux window tools (`xdotool`, `wmctrl`), plus a pre-start script (`scripts/ensure-deps.mjs`) to auto-install missing packages.
- **New MCP Tools** — `web_scrape` (SSRF-guarded Markdown scraper), `ddg_search` (free web lookup), `run_workflow`, `run_loop`, `crew`, `proxima_cost_report`, `proxima_agentic_status`, and `analyze_file` (repository packer).
- **Streaming Responses** — SSE streaming from provider engines via a chunk callback (live token output).
- **Multi-Model Routing** — Target specific engine models (e.g. `gemini:3.5-flash`, `gemini:3.1-pro`, `gemini:auto`).
- **Offline Python Runtime Bundling** — Pinned wheels shipped with the app; the Python environment is set up offline, never downloaded from PyPI at runtime (`build/offline/`, `scripts/prepare-offline-python.mjs`, `electron/python-env.cjs`).
- **Cross-Platform Installers** — Windows (NSIS), macOS (dmg, x64+arm64), Linux (AppImage, deb).
- **Manual Cookie Import/Export** — Paste custom cookie sessions directly using EditThisCookie/Cookie-Editor format to sign a provider in (`set-cookies` / `get-cookies`).
- **Dependencies** — Added `@modelcontextprotocol/sdk` (official server standards), `zod` (strict schema validation), `better-sqlite3`, `onnxruntime-node`, and `electron-updater` (production auto-updating).
- **Full Test Suite** — Integrated JavaScript (`node --test`, `tests/`) and Python (`unittest`, `proxima-agent/tests/`) test suites, documented in `TESTING.md`.

### Changed
- **Response Capture is now Engine-Only:** Removed DOM scraping and DOM-typed response handlers. All provider responses come from the session-API engines (`electron/providers/engines/*`). Requests are serialized per provider, with a classified bounded retry (transient vs deterministic).
- **Modular Electron IPC Handlers:** Split bloated IPC main registration out of `main-v2.cjs` into specialized handlers in `electron/ipc/` (`cli.cjs`, `core.cjs`, and `settings.cjs`).
- **REST API Modularization:** Split `electron/rest-api.cjs` into `electron/api/rest-api.cjs` + `routes.cjs` (dependency-injection handler) + `tool-calling.cjs` + `pages/`, and gained BYOK/brain endpoints.
- **MCP Server Refactor:** Split single `src/mcp-server-v3.js` into modular `src/mcp/` handlers (`index`, `ipc-bridge`, `pipeline`, `helpers`, and `tools-*` modules) using a `registerTool` pattern.
- **Provider Layer Restructured:** `provider-api.cjs` → `providers/api.cjs` + `sender.cjs`; engine scripts moved to `providers/engines/`.
- **Tool Consolidation:** Consolidated search/content tools under generic `deep_search` and `content` interfaces.
- **Cache Integrity:** Clear cache on startup preserves active cookies and storage keys.
- **Version Bump:** Version bumped to 5.0.0.

### Removed
- **DOM scraping and DOM-typed send** — the typing-detection, response-polling, fingerprint-diffing, `debugDOM`, and DOM file-upload paths were removed once every provider had a working session-API engine. Failures are surfaced instead of falling back to reading the page.
- **Automatic all-provider cookie backup/restore** — replaced by manual cookie import + a Gemini-only backup before quit (Google session tokens rotate).

### Security
- SSRF protection on `web_scrape` / the Python web fetcher (DNS-resolves and rejects private/loopback/link-local/metadata addresses; IP-pins the vetted address).
- Prompt-injection scanner gates untrusted content before it enters system prompts.
- Agent safety gate fails **closed** for dangerous operations when running unattended (no console).

## [4.1.0]

### Added
- **Provider Engine System** — native browser-level communication (fetch + SSE)
  per provider, replacing pure DOM scraping; 3–10× faster with automatic DOM
  fallback still available in this release.
- **CLI tool** (`proxima ask/fix/debate/…`) with file context, git-diff piping,
  and JSON output.
- **WebSocket server** — real-time streaming at `ws://localhost:3210/ws`.
- **15 new MCP tools** — `chain_query`, `solve`, `debate`, `security_audit`,
  `verify`, `fix_error`, `build_architecture`, `write_tests`, `explain_error`,
  `convert_code`, `ask_selected`, `conversation_export`, `ask_perplexity`,
  `github_search`, `get_ui_reference`.
- **Interactive API docs** at `/docs`, `/cli`, `/ws` with a live chat widget.
- **Multi-model queries** — `model: "all"` or `model: ["claude", "chatgpt"]`.
- **Conversation export** and new REST functions (`security_audit`, `debate`),
  plus file upload via the `file` field.

### Fixed
- Staggered multi-provider queries to prevent UI freezes.
- Smart provider selection (coding → Claude, research → Perplexity).
- Response caching with TTL (5 min) and max-100 eviction.
- Rate-limit (429) detection and expired-session auto-recovery.
- Engine auto-injection on navigation with a duplicate guard.
- Claude conversation auto-recovery (404/410), ChatGPT SHA3-512 proof-of-work.
- 10 MB REST body limit with CORS headers; IPC socket-leak prevention.

---

[5.0.0]: https://github.com/Zen4-bit/Proxima/releases/tag/v5.0.0
[4.1.0]: https://github.com/Zen4-bit/Proxima/releases/tag/v4.1.0
