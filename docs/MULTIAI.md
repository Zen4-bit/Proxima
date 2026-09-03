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
| `cli` (implied for `claude-cli`, `codex-cli`) | `claude -p` / `codex exec` on this machine, one-shot, tool-less, in an empty scratch folder, ≤2 in parallel per CLI | Claude Code aliases `opus` `sonnet` `haiku` `fable` (+ `[1m]`), `--effort low…max`; Codex `gpt-5.5` etc., `model_reasoning_effort` (`max` → `xhigh`) |

Settings is the single source of truth for API mode, keys and default models —
the tab never stores keys and never overrides the mode; it only reads it
(`↻` in the Agents block re-reads Settings and re-probes the CLIs). Effort maps to
`reasoning_effort` for OpenAI and to an extended-thinking budget for Anthropic
(1k → 32k tokens for `minimal` → `max`).

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
  account must support the model you pick (`gpt-5` is rejected on ChatGPT
  subscriptions; `gpt-5.5` works).
- **Labels.** Known providers keep their codes; other agents get initials of
  their name (`Opus · high` → `OH`).

Legacy chats (a `participants` list) are migrated to one browser-tab agent per
provider the first time they are opened; the `participants` field is kept in
sync for older readers.

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
- **Independent first round.** Round 1 of each Send runs everyone in parallel
  and blind (no same-cycle replies in their prompt); later rounds are round-robin.
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
| POST | `/v1/multiai/chats` | `{title?, agents?, participants?, mode?, discussMode?, contextMode?, brevity?, topic?, who?}` | `{chat}` (201); `topic` is recorded as the first message. `agents: [{name?, provider, route?, model?, effort?, persona?}]`; `participants` is the legacy one-agent-per-provider shorthand |
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
