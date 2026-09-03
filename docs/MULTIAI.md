# Multi-AI Chat tab

A native tab in this fork that runs discussions, debates and pipelines across the
browser-session providers Proxima already drives (ChatGPT, Claude, Gemini,
Perplexity), with a transcript that local agents (Codex, Claude Code, scripts)
can read and append to over the gateway's REST API.

Code: `electron/ipc/multiai-core.cjs` (pure logic, unit-tested),
`electron/ipc/multiai.cjs` (main-process handlers + REST routes),
`electron/multiai-renderer.js` + the `#multiai-panel` block in
`electron/index-v2.html` (UI). Tests: `tests/electron/ipc/`.

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
- **Rounds, Brevity, Personas** as before; the Gemini participant has a model
  picker (`3.5-flash`, `3.1-pro`, `3.1-flash-lite`, `auto`). Other providers ignore
  engine choice in the provider layer.
- **Stop early when all agree.** A round where everyone says the stop token or
  passes ends the run and posts a system note.
- **Independent first round.** Round 1 of each Send runs everyone in parallel
  and blind (no same-cycle replies in their prompt); later rounds are round-robin.
- **Directed turns.** `@claude kick off, others react` puts Claude first;
  `only @gemini and @chatgpt …` restricts the round to those two.
- **Judge** with scope: whole chat / since my last message / last round only
  (resolved by cycle *and* round).
- **Summarize state** pins a `DECISIONS / OPEN QUESTIONS / CLAIMS TO VERIFY /
  NEXT STEP` summary; later turns start from it.
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
  shows ● in the list; one run per chat at a time; Stop abandons the in-flight
  call (the browser request itself is not cancellable in the provider layer).
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
| GET | `/v1/multiai/chats` | | `{chats:[{id,title,mode,participants,messageCount,cycle,updatedAt}]}` |
| POST | `/v1/multiai/chats` | `{title?, participants?, mode?, discussMode?, brevity?, topic?, who?}` | `{chat}` (201); `topic` is recorded as the first message |
| GET | `/v1/multiai/chats/:id` | `?since=<messageId>` | `{chat}` with `messages` (each has a `label` like `0103CG`) and `running` |
| POST | `/v1/multiai/chats/:id/messages` | `{who, text, provider?, role?}` | `{message}` (201). Appends a turn; nothing is sent to providers. `role: "user"` starts a new cycle. |
| POST | `/v1/multiai/chats/:id/run` | `{text?, who?, rounds?, wait?}` | `{started:true}` (202) or, with `wait:true`, `{messages}` once the rounds finish |
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
