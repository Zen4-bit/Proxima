# Multi-AI Chat tab

A native tab in this fork that runs discussions, debates and pipelines across
**agents** — the browser-session providers Proxima already drives (ChatGPT,
Claude, Gemini, Perplexity), the same providers over their APIs when API mode
is on in Settings, and Claude Code / Codex run locally on your subscriptions —
with a transcript that local agents (Codex, Claude Code, scripts) can read and
append to over the gateway's REST API or MCP tools.

Code: `electron/ipc/multiai-core.cjs` (pure logic, unit-tested),
`electron/ipc/multiai.cjs` (main-process handlers + REST routes),
`electron/providers/cli.cjs` (Claude Code / Codex runners),
`electron/multiai-renderer.js` + the `#multiai-panel` block in
`electron/index-v2.html` (UI). Tests: `tests/electron/ipc/`, `tests/mcp/`.

## Agents and routes

A participant is an **agent**: `name + provider + route + model + effort +
persona`. The same provider can appear several times with different models or
efforts ("Opus · max" and "Sonnet · low", or "GPT high" and "GPT low"), which is
how you run a single-provider panel. Each agent's id (`opus-max`) is the slug of
its name, made unique within the chat (`bull`, `bull-2`); it is what `@mentions`,
HANDOFFs, the judge picker and the provider-side thread key on.

| Route | What runs the turn | Model / effort |
|---|---|---|
| `auto` (default) | Follows **Settings → API mode**: on, with a key for that provider → the provider's API; otherwise the browser tab | API: the agent's model when Settings lists it (a browser-side name like the Gemini engine `3.1-pro` is ignored), else the model selected in Settings; effort honoured. Browser: model ignored except Gemini's engine picker; effort ignored |
| `browser` | Always the logged-in browser tab | as above |
| `api` | The provider's API; falls back to the browser tab (with a ⚠ in the editor) if API mode is off or no key | model + effort |
| `cli` (implied for `claude-cli`, `codex-cli`, `gemini-cli`) | `claude -p` / `codex exec` / `gemini -p` on this machine, one-shot, ≤2 in parallel per CLI; tool-less in an empty scratch folder unless the chat has a **workspace** and the seat has **tools** (below) |
| `api` (implied for a local / custom endpoint) | Any OpenAI-compatible server registered in **Settings → API → Local / custom endpoint** (Ollama, LM Studio, vLLM, llama.cpp, a gateway) | model id required (the row's list comes from the endpoint's `/models`); no effort switch; works with API mode off | Claude Code aliases `opus` `sonnet` `haiku` `fable` (+ `[1m]`) or full names, `--effort low…max`; Codex model slugs from your account list, `model_reasoning_effort` clamped to what that model supports; Gemini CLI model ids, no effort switch |

Settings is the single source of truth for API mode, keys and default models —
the tab never stores keys and never overrides the mode; it only reads it
(`↻` in the Agents block re-reads Settings and re-probes the CLIs). Effort maps to
`reasoning_effort` for OpenAI and to an extended-thinking budget for Anthropic
(1k → 32k tokens for `minimal` → `max`).

**What the CLIs offer is discovered, not hard-coded.** `cli.discover()`
(`electron/providers/cli.cjs`) probes each installed CLI — on startup in the
background and on ↻ — and the agent table uses the result: the model column's
suggestions, the effort column's levels, the placeholder default, and the
warnings.

| CLI | Discovered from | What you get |
|---|---|---|
| Claude Code | `claude --version`, `claude --help` (the `--effort` levels and `--model` aliases), `~/.claude/settings.json` | version, effort levels, aliases (`fable`, `opus`, `sonnet`, `haiku`), configured default model |
| Codex | `codex --version`, `~/.codex/models_cache.json` (your account's model list: slug, display name, supported reasoning levels, default level), `~/.codex/config.toml` (`model`, `model_reasoning_effort`, `[profiles.*]`) | version, per-model effort lists, defaults, profiles; a configured default that is not on the list is flagged; a typed model that is not on the list gets an amber border; the effort is clamped to what the model supports at run time |
| Gemini CLI | `gemini --version`, `~/.gemini/settings.json` (auth method) | version, whether a login method is configured (the row and route show ⚠ until it is) |

Route-specific behaviour:

- **Context.** API and CLI turns are one-shot, so `Delta` context is replaced by
  `Bounded` for them (the browser route keeps Delta). `Full` works everywhere.
- **Threads.** Browser agents keep one provider-side thread per agent
  (`multiai:<chatId>:<agentId>:<gen>`), rotated every 12 turns (40 in Delta).
- **Stop** aborts browser turns in the BrowserView and kills CLI process trees;
  an API request in flight is left to finish and its result discarded.
- **Codex** has no "no tools" switch and its sandbox helper is missing on some
  Windows installs, so it runs with approvals/sandbox bypassed inside an empty
  scratch folder and a system prompt that forbids running anything. The Codex
  account must support the model you pick — that is exactly what the
  discovered model list tells you.
- **Gemini CLI** runs headless (`-p … -o json --approval-mode plan`); the
  system prompt and transcript go in on stdin. It needs a login method set once
  in the CLI (`gemini`, then pick Google login or an API key).
- **Labels.** Known providers keep their codes; other agents get initials of
  their name (`Opus · high` → `OH`).

### Local-model seats

Settings → API has a *Local / custom endpoint* form: a name (`ollama`,
`lmstudio`, `vllm`…), the chat-completions URL
(`http://127.0.0.1:11434/v1/chat/completions`) and an optional key. Saving registers a BYOK provider whose `endpoint` is honoured by
the OpenAI-compatible client (`byok.keys` store, `settings.byok-save-key` with
`{endpoint, displayName}`). `routeInfo()` lists it as `apiOnly: true` with the
models the endpoint reported (`GET <base>/models`, the URL with
`/chat/completions` stripped; refreshed on ↻), so it shows
up in the roster's provider menu and in *+ add agent…* as "<name> (API)". Such
seats are pinned to the `api` route (there is no browser tab), have no effort
switch, and need a model id — the cell turns amber until one is set. They run
even when API mode is off, since there is nothing to fall back to.

### Workspace seats (file access)

The **Workspace** tab attaches a git folder to the chat (`chat.workspace =
{root, branch}`; the branch is `multiai/<chat id tail>`). CLI seats then get a
**Tools** level in the roster:

| Tools | Claude Code | Codex | Gemini CLI |
|---|---|---|---|
| `none` (default) | `--disallowedTools *`, scratch folder | bypass mode in a scratch folder, "don't run anything" system prompt | `--approval-mode plan`, scratch folder |
| `read` | `--allowedTools Read,Glob,Grep,LS --permission-mode dontAsk` | `--sandbox read-only` | `--approval-mode plan` |
| `write` | `--allowedTools …,Edit,MultiEdit,Write,NotebookEdit,Bash(git status*),Bash(git diff*),Bash(git log*) --permission-mode acceptEdits` | `--sandbox workspace-write` | `--approval-mode auto_edit` |
| `full` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` |

All levels run with `cwd = root` and a system-prompt block telling the seat
where it is and what it may do (`core.workspaceBlock`). Before a run that has
tool seats, `workspace.prepare()` checks the folder: it must be a git repo (an
empty one gets an initial commit); if the folder is on another branch it must
be clean — Proxima refuses to sweep your uncommitted work into its branch —
and is switched to the chat's branch; leftovers on the chat's own branch (an
interrupted turn) are committed as WIP.

**Every chat is a fresh start.** A chat's branch is created the first time
from the *base branch* (`workspace.baseBranch`): the branch the folder is on
if that is one of yours (`main`, `feature-x`…); if the folder is parked on
another chat's `multiai/*` branch, origin's default branch, then `main`, then
`master`, then the first local branch that is not a chat branch. It is never
cut from another chat's branch, so chat B does not inherit chat A's edits —
merge A's branch into your base when you want to keep them. The Workspace tab
previews all this before any run (`multiai-workspace-info` →
`workspace.inspect`): repo or not, current branch, dirty or clean, and where
this chat's branch would start. After every **write/full** turn the folder is committed (`git add -A`,
author *Proxima Multi-AI*, message `<seat> [<label>]`) and the result is recorded
as a `role: 'change'` message — file list, `--stat`, and the patch (≤12 kB) —
which the other participants read like any other turn and the feed shows as a
🛠 card with a folding diff. Writers are serialised per chat (one at a time, even
in a parallel first round); readers and discussion seats overlap. On Windows,
Codex's `read`/`write` levels need two helpers next to `codex.exe`
(`codex-windows-sandbox-setup.exe`, `codex-command-runner.exe`). The standalone
CLI installer ships without them; the Codex desktop app bundles a complete
`codex.exe` + helpers under `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\`.

**Which codex runs.** `cli.resolveCodex()` looks at both the app bundle and
the `codex` on PATH, runs `--version` on each once, and uses the newest for
everything — seats, variants, discovery (a tie or unknown versions go to the
bundle, since only it can sandbox). Same `~/.codex` login, config and model
list either way. Discovery reports `cliInfo.codex.exe / source
(bundle|path) / version / alternatives / sandbox (native|missing)`; the
Agents footer shows "Codex 0.152.1 (desktop app) · also 0.142.5 on PATH —
newest wins", and warns when the chosen binary has no sandbox helpers
(read/write unavailable; `full` bypasses the sandbox and always works). A
machine with only the desktop app (no `codex` on PATH) still gets Codex seats. Gemini CLI may ask to trust the folder the first
time. Review with `git log multiai/…`; merge or delete the branch when done.

Over REST/MCP: `POST /v1/multiai/chats` and `multiai_create_chat` accept
`workspace: {root}` and a per-agent `tools`; `multiai_read_chat` shows the
workspace and `(change)` messages.

**Roster and library.** The options panel is a tab strip — *Agents ·
Discussion · Context · Charter · Judge · Workspace* (Classic) or *Pipeline*
(Orchestrated) — over one pane, collapsible to the strip plus a one-line
summary. The Agents tab is a table: one row per agent, every cell editable in
place, with a checkbox per row. Ticked agents take turns in this chat; unticked
ones are benched — still configured, but they take no turns, get no mentions
and aren't introduced to the others (`enabled: false` on the stored agent;
`normalizeAgents` drops them). Agents are defined once — *+ add agent…* offers
a new row per provider and anything in the library — and live in a library
(`uiPrefs.agentLibrary`, keyed by `uid`). Every new chat starts with the whole
library switched on; editing a library agent in its row applies to every chat that
carries it; ✕ on a row removes the agent from that chat only, ✕ in the library
list removes it for good (chats keep a chat-local copy). Agents that arrive
without a `uid` — legacy `participants`, chats created over REST/MCP — are
chat-local.

Legacy chats (a `participants` list) are migrated to one browser-tab agent per
provider the first time they are opened; the `participants` field is kept in
sync (enabled agents only) for older readers.

The app opens on the Multi-AI tab by default (Settings → General → *Open on
start* picks another tab); the tab strip sits in the header, inline with the
logo. Provider views start off-screen and only cover the window when their tab
is selected.

## How a turn is built

The **Context** option (per chat) picks one of three strategies:

- **Bounded** (default) — a self-sufficient prompt, not the whole history (see below).
- **Delta** — only the messages since that provider's last turn; its own
  provider-side thread remembers the rest, and a rolling State summary rides
  along as the topic block (refreshed every *Auto-summary every* messages via
  the Judge provider). A fresh or rotated thread gets one full catch-up prompt
  (the bounded one), so nothing is lost. Cheapest per turn.
- **Full** — the entire transcript every turn (the original ProximaChatApp
  behaviour). Simplest, unbounded, and the cause of the late-session HTTP 500s
  and timeouts in long chats.

In bounded mode every participant receives:

1. the brief (first human message) and the latest human instruction,
2. the pinned **State summary**, if one exists (everything before it is dropped),
3. a condensed digest of older messages (400 chars each, 30 KB budget, the
   opening brief always kept),
4. the last *N* messages verbatim (**Context window**, default 10),
5. the rules: build on or challenge, reply `PASS` when nothing to add, begin
   with the **stop token** (default `DONE`) when converged.

Errors, stop notices, passes and system notes are never fed back to participants.

Each chat has its own provider-side thread per provider
(`multiai:<chatId>:<generation>`), rotated every 12 turns (40 in Delta mode) so
provider threads stay bounded; judge/summary/title calls use a fresh one-off thread. Chats never
bleed into each other or into the MCP tools' `mcp-session` thread.

## Classic mode

- **Discuss / Debate.** In Debate with three or more participants the stances are
  assigned: for, against, critical evaluator, third option.
- **Rounds, Brevity, Personas** as before; personas are set per agent in the
  Agents block. A Gemini browser agent's model field picks the engine
  (`3.5-flash`, `3.1-pro`, `3.1-flash-lite`, `auto`); other browser agents ignore it.
- **Stop early when all agree.** A round where everyone says the stop token or
  passes ends the run and posts a system note.
- **Independent rounds.** `every round` by default; `first round only` or `off`
  in the Discussion tab. A blind round runs every participant at once and shows
  none of them what the others are saying *in that round* — replies, passes and
  workspace diffs alike. Completed rounds stay visible, so round 2 answers
  round 1 and the discussion still happens, one round later.

  Turn-taking makes a round asymmetric: the first seat answers the human and the
  last answers five peers, and later seats tend to converge on whoever spoke
  first. Blind rounds remove that anchor, and each round is one parallel batch,
  so a run is about as slow as its slowest seat rather than the sum of them.

  The cost is in charter mode: a `HANDOFF →` cannot pull a seat forward inside a
  blind round, so it applies to the next one and the run posts a note saying so.
  Set `off` if in-round handoffs matter more.

  Chats saved before this setting existed keep what their `independentFirstRound`
  boolean asked for (`true` → `first`); everything else takes the new default.
- **The guided tour.** Help (next to Settings) → Take the tour: nine steps
  over the real screen, dimming everything but the control each step is about.
  It points at live elements rather than screenshots, so it is either correct
  or visibly broken when something moves — `tests/electron/multiai-tour.test.js`
  checks every selector, options tab and roster column index against the
  markup. The tour’s `auto` button advances it hands-off, and
  `npm run tour:gif` records that window into `docs/tour/tour.gif` — needs
  ffmpeg, and takes `--seconds`, `--fps`, `--width`, `--out` and `--title`.

- **Directed turns.** `@claude kick off, others react` puts Claude first;
  `only @gemini and @chatgpt …` restricts the round to those two. Mention agents
  by id (`@opus-max`), by name with the spaces dropped (`@gptlow` for "GPT low")
  or, when only one agent uses it, by provider (`@claude`).
- **Judge** with scope: whole chat / since my last message / last round only
  (resolved by cycle *and* round).
- **Summarize state** pins a `DECISIONS / OPEN QUESTIONS / CLAIMS TO VERIFY /
  NEXT STEP` summary; later turns start from it.
- **Charter mode** (per chat) enforces the coworking charter in the engine:
  claim tags `VERIFIED [who/how/path]` / `UNVERIFIED` / `ASSUMED [basis]`
  (agreement never upgrades a claim), plain agreement = PASS, a mandatory
  `HANDOFF → <participant>: …` / `OPEN → …` / `COMPLETE → …` trailer, HANDOFF
  routing (named participant goes next, or first next round), and a rotating
  red-team seat (one participant per round, marked in the feed).
- Titles are local and instant; ✨ asks the judge provider for a better one.

## Orchestrated mode

Crew (role pipeline), Workflow (`provider: task` lines — the prefix is only
treated as a provider if it names one), Loop (generate → review until
`CONVERGED`), Agent (file tools inside one chosen folder, no confirmation).
Every step is recorded as a message in the chat, whichever chat is on screen.
A failed crew role stops the pipeline instead of handing stale input on. Follow-up
Sends in the same chat include a condensed view of the prior conversation.

## Runs, persistence, safety

- Runs belong to the chat, not the screen: switch chats freely; a running chat
  shows ● in the list; one run per chat at a time. Stop aborts the call in
  flight inside the provider's BrowserView (`abort()` on each engine, wired
  through `sender.abortActive`), skips queued turns, and — in Delta mode —
  gives that provider a fresh thread on its next turn.
- A participant that fails twice in a row is benched for the rest of that run
  (a system note says so). In Delta mode an error also starts a fresh provider
  thread with a full catch-up, because some engines wipe the thread on failure.
- Judge / summary / title calls share one auxiliary provider thread per chat,
  rotated every 5 uses, so they don't open a new web conversation each time.
- Store: `<userData>/multiai/chats.json`, written atomically with a rolling
  `chats.backup.json`. A damaged file is parked as `chats.corrupt-<ts>.json` and
  the backup restored — history is never silently replaced by an empty store.
  Renderer snapshot saves are upsert-only and merge with anything the main
  process appended meanwhile; deletes are explicit (with tombstones).
- Dev checkout (`npm start`) uses its own profile, `%APPDATA%/proxima-dev`, so
  it never disturbs the installed app's ports, tokens or logins
  (`PROXIMA_SHARED_USERDATA=1` opts back in). One instance per profile.
- This fork does not auto-update from upstream unless `settings.autoUpdate`
  is `true` (see `proximaFork` in `package.json`).

## REST API for local agents

Same server as the rest of the gateway (Settings → API; default
`http://127.0.0.1:3210`, loopback only, API key if one is configured).

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/v1/multiai/chats` | | `{chats:[{id,title,mode,agents:[name],participants,messageCount,cycle,updatedAt}]}` |
| POST | `/v1/multiai/chats` | `{title?, agents?, participants?, mode?, discussMode?, contextMode?, brevity?, topic?, who?}` | `{chat}` (201); `topic` is recorded as the first message. `agents: [{name?, provider, route?, model?, effort?, persona?, enabled?}]`; `participants` is the legacy one-agent-per-provider shorthand |
| GET | `/v1/multiai/chats/:id` | `?since=<messageId>&last=<n>` | `{chat}` with `agents` (resolved `route` per agent), `messages` (each has a `label` like `0103CG`, plus `agentId`, `route`, `model` on agent turns) and `running` |
| POST | `/v1/multiai/chats/:id/messages` | `{who, text, provider?, role?}` | `{message}` (201). Appends a turn; nothing is sent to providers. `role: "user"` starts a new cycle. |
| POST | `/v1/multiai/chats/:id/run` | `{text?, who?, rounds?, wait?}` | `{started:true}` (202) or, with `wait:true`, `{messages}` once the rounds finish |
| POST | `/v1/multiai/chats/:id/wait` | `{since?, maxMs?}` | blocks until the run ends or `maxMs` (≤120 s); `{running, messages}` |
| POST | `/v1/multiai/chats/:id/stop` | | `{stopped}` |
| GET | `/v1/multiai/running` | | `{running:[chatId]}` |

Example — Codex posts a verified result and asks the browser AIs to react:

```bash
curl -s -X POST http://127.0.0.1:3210/v1/multiai/chats/$CHAT/messages \
  -H 'Content-Type: application/json' \
  -d '{"who":"Codex","provider":"codex","text":"VERIFIED backtest: PF 1.31 on clean data, path=results/phase81.csv"}'
curl -s -X POST http://127.0.0.1:3210/v1/multiai/chats/$CHAT/run \
  -H 'Content-Type: application/json' -d '{"rounds":1}'
```

Provider codes in labels: `CG` ChatGPT, `CL` Claude, `GM` Gemini, `PX` Perplexity,
`CX` Codex, `CC` Claude Code, `US` you, `JD` judge, `SM` summary, `SY` system.

## MCP tools (Claude Desktop, Claude Code, Codex, any MCP client)

The `proxima` MCP server (`src/mcp/index.js`, the one Claude Desktop already
launches) registers seven `multiai_*` tools that reach the same API over the
Agent Hub IPC bridge, so they work even with the REST API disabled:

| Tool | What it does |
|---|---|
| `multiai_list_chats` | Chats with id, title, mode, agents, message count; ● when a run is in progress |
| `multiai_read_chat {chatId, since?, last?}` | Transcript with reference labels and message ids; header lists each agent's id, resolved route, model and effort |
| `multiai_create_chat {title?, topic?, agents?, participants?, discussMode?, contextMode?, …}` | New chat, optionally with an opening message; `agents` as in the REST body (e.g. `[{provider:"claude-cli", model:"opus", effort:"max"}, {provider:"chatgpt", route:"api", effort:"low"}]`) |
| `multiai_post_message {chatId, who, text, role?}` | Append a turn under your own name (provider inferred: Codex → `codex`, Claude Code → `claude-code`); browser-AI names are never impersonated |
| `multiai_run_round {chatId, text?, who?, rounds?, wait?}` | Optionally post, then run rounds; returns immediately unless `wait` |
| `multiai_wait_for_run {chatId, since?, maxSeconds?}` | Block up to 120 s for the run, return new messages, say if still running |
| `multiai_stop {chatId}` | Stop the run |

Typical local-agent loop: `multiai_read_chat` → do the verifiable work →
`multiai_post_message` with `VERIFIED [how/path]` → `multiai_run_round` →
`multiai_wait_for_run` → repeat.

## MCP tools for local CLI variants

Three more tools on the same server (`src/mcp/tools-cli.js`) expose the CLI
route directly, so any MCP client can ask a model × effort seat on your
subscriptions without an API key or a chat:

| Tool | What it does |
|---|---|
| `cli_variants {probe?}` | What the installed CLIs offer (versions, models, effort levels, defaults, login state — the discovery above) plus the named variants in the agent library |
| `ask_variant {message, variant? \| provider?+model?+effort?, system?, timeoutSeconds?}` | One question through one CLI seat. `variant` is a library agent's name/id or shorthand `model[:effort]` — `opus:max`, `sonnet:low` (Claude Code), `gpt-5.5:high` (Codex), `gemini-3.1-pro` (Gemini CLI). A library agent's persona rides along as the system prompt. |
| `ask_variants {message, variants[], …}` | The same question to up to 8 variants in parallel (each CLI's concurrency cap applies), answers side by side; a failing variant is reported, the rest still return |

They go through the Agent Hub IPC bridge (`multiaiVariants`, `multiaiAskVariant`,
`multiaiAskVariants`), so the app must be running; that is what gives them the
app's discovery cache, library and concurrency caps. Note that calling
`ask_variant` *from* Claude Code runs Claude Code inside Claude Code — allowed,
but both turns count against the same subscription window.

### Standalone variants server (no app needed)

`src/mcp/variants-server.js` (`npm run mcp:variants`, or the
`proxima-variants-mcp` bin) serves just those three tools without the app: it
probes the CLIs and runs them in-process (`electron/providers/cli.cjs`) and
reads the agent library from Proxima's store file
(`<userData>/multiai/chats.json`; `PROXIMA_USERDATA` overrides the location).
Settings → MCP shows the ready-made config as **Local CLI variants — standalone
server**. Give a client one or the other, not both — the tool names are the
same. The shared implementation is `electron/providers/variants.cjs`.

## Variants over REST and WebSocket

The same seats are reachable from anything that speaks HTTP, on the gateway
(Settings → API, default `http://127.0.0.1:3210`, API key if configured):

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/v1/multiai/variants` | `?probe=1` to re-probe the CLIs | `{cli: {claude, codex, gemini}, library: [{id, name, provider, model, effort, persona}]}` |
| POST | `/v1/multiai/variants/ask` | `{message, variant? \| provider?+model?+effort?, system?, timeoutMs?}` | `{variant, id, provider, model, effort, text, ms, costUsd}` |
| POST | `/v1/multiai/variants/ask-many` | `{message, variants: [...≤8], system?, timeoutMs?}` | `{results: [{ok, …} \| {ok:false, variant, error}]}` |
| POST | `/v1/chat/completions` | OpenAI body with `model: "cli:opus:max"`, `"cli:gpt-5.5:high"`, `"cli:<library id>"` or a library seat's name; `stream: true` accepted, but see below | a standard `chat.completion` (or SSE chunks); `proxima` carries variant/model/effort/time |
| GET | `/v1/models` | | now also lists `cli:<seat>` entries — library seats first, then each logged-in CLI's models — so OpenAI-compatible clients can pick them from a menu |

**`stream: true` on a `cli:` model is a single-shot pseudo-stream.** The CLIs are
invoked in a way that yields no incremental tokens — Claude Code with
`--output-format json` (one blob at exit), Codex with `--output-last-message`
(read whole afterwards) — so the whole answer is produced first and then written
as one delta chunk, a stop chunk and `[DONE]`. Nothing arrives until the turn
finishes, which can be many minutes: clients that apply a first-byte stall
timeout should raise it or use the non-streaming form. (The gateway's genuine
incremental streaming is Gemini-only and predates this; the `cli:` path is
consistent with the rest of it, not a regression.) `usage` is reported as zeros,
since the CLIs do not report token counts.

**`system` is appended, not substituted.** A `cli:` seat has no tools, and the
clause saying so is what stops it emitting tool-call syntax and inventing the
results; a caller's own system message is added after it rather than replacing it.

The OpenAI-compatible path is the one to point Open WebUI, a Python
`openai` client, the VariantArena UI or any other OpenAI-speaking tool at:
`base_url = http://127.0.0.1:3210/v1`, `model = "cli:opus:max"`. `system`
messages become the CLI system prompt; a multi-turn `messages` array is
flattened into a transcript, since CLI seats are one-shot.

WebSocket (`ws://127.0.0.1:3210/ws`), JSON actions:

| Action | Fields | Replies |
|---|---|---|
| `variants` | `probe?` | `{type:"response", action:"variants", cli, library}` |
| `ask_variant` | `message`, `variant?` or `provider?/model?/effort?`, `system?`, `timeoutMs?` | `status` then `{type:"response", action:"ask_variant", variant, provider, model, effort, content, responseTimeMs}` |
| `ask_variants` | `message`, `variants: [...≤8]`, `system?` | `status`, then one `response` per seat **as each finishes** (`index`, `ok`, `content` or `error`, `remaining`), then `{type:"done"}` |

`ask_variants` over WebSocket is the natural way to watch a comparison come in
seat by seat instead of waiting for the slowest one.
