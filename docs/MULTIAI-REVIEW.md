# Multi-AI branch review — master findings

Review of `multiai-tab` vs `main` (18 commits, 13,243 insertions / 4,148
deletions, 44 files). Three reviewers over two rounds, plus executive
verification. Suite state at review time: **731 pass / 0 fail**.

Reviewers: **R1** robustness · **R2** UI/UX · **R3** integration contracts.
Round 1 produced 45 proposals; Round 2 was adversarial cross-examination, where
each reviewer verified, refuted or refined the others' claims and several
findings were corrected or overturned.

---

## Verdict

The branch is a large, coherent, well-documented feature with a real test suite
and a spec that mostly matches the code. Reviewers confirmed seven substantial
things as correctly built (see *Verified sound* at the end).

It should not merge as it stands. There is one **confirmed arbitrary command
execution** path reachable from any MCP client, a **default privilege level that
does not do what its label says** on both CLIs, and a **workspace safety contract
that is bypassed on every code path except one**. Separately, the app's own help
text makes four safety claims the code contradicts.

Everything below is grounded in a file and line a reviewer opened, or in a
command that was actually run.

---

## Settled in Round 2

### Corrections to Round 1

Two Round 1 findings were overturned or materially narrowed by later evidence.
Recording them because the corrected version changes the fix.

**The executive's `P-EX-1` was mis-diagnosed.** The original probe ran
`claude -p --disallowedTools '*'` and observed the CLI emit raw `<invoke>` blocks
and fabricate tool results, including an invented prompt-injection payload. R1
re-ran it with the app's *actual* flag set — which includes
`--system-prompt-file` — and got **3/3 clean refusals**
("I can't do that — I have no tools available in this setup"),
`permission_denials: []`, no `<invoke>`. Dropping only `--system-prompt-file`
reproduced the fabrication exactly.

So `--disallowedTools '*'` **does** genuinely remove the tools; the enforcement
works. The fabrication is a *prompting* failure, and the countermeasure is the
"You have no tools and no filesystem… Never run commands" sentence in
`DISCUSSION_SYSTEM_PROMPT` (`cli.cjs:43-46`), which is already in the code. This
retires the proposal to replace `*` with an explicit tool list — that would be a
maintenance trap that silently *grants* every tool Claude Code adds in future.

It also makes the real finding sharper, not softer: the default level is one
string away from broken, and **`P-R1-15` shows two APIs let a caller delete that
string.**

**R2's "the branch change is invisible outside git" was wrong** —
`multiaiRefreshWorkspaceStatus` does print `Folder is on <branch>`
(`multiai-renderer.js:1367`). The real defects are narrower: that line refreshes
only on chat render, `inspect()` sets no warning for `cur === branch && dirty`,
and the surrounding copy asserts the opposite of what the code does.

### The five conflicts — all resolved

| # | Conflict | Resolution | Basis |
|---|---|---|---|
| 1 | Auto-return the tree to the base branch | **Drop the auto-switch.** Ship the warning gap and the WIP-attribution narrowing. | Unanimous. `docs/MULTIAI.md:114-135` documents "Review with `git log multiai/…`; merge or delete the branch when done" — branch parking is deliberate design, so **Q-R1-2 is answered**. Switching the tree out from under the user's editor is a worse surprise than the one it fixes. |
| 2 | How much queue state to surface | **Two states — `working` and `waiting` — with the reason as a dim sub-label**, not a third peer state. | Unanimous. A seat blocked on `acquireWriter` can sit for a full 10-minute CLI timeout while rendering identically to one mid-inference, and the user's only decision (wait or Stop) depends on telling those apart. But promoting the writer lock to a peer state teaches an internal concept nobody needs. |
| 3 | Pseudo-streaming vs real SSE | **Document it; add the missing closed-response guard. No real streaming.** Keep-alive comments optional. | R1 **refuted** R3's "this regresses a pattern already in the file": both pre-existing streaming sites are guarded `provider === 'gemini'`, so genuine streaming is Gemini-only and the `cli:` path is *consistent* with the gateway. R3 confirmed real streaming is an L-cost rearchitecture — Claude Code runs `--output-format json` (one blob at exit) and Codex `--output-last-message <file>`; neither yields incremental tokens as invoked. |
| 4 | Onboarding vs clutter | **In-feed empty state only.** Auto-expand the Agents tab only when the library is empty (once per install). | Unanimous. R2 established the welcome-panel alternative is **structurally unavailable**: `welcome-panel` lives inside `#browser-container`, which `switchTab('multiai')` sets to `display:none`. Its content is browser-provider onboarding anyway, wrong for this tab. |
| 5 | Orchestrated mode scope | **Reject unification. Force `tools:'none'` in Orchestrated + one explanatory line.** | Unanimous, and now a safety fix rather than a scope choice. R1 proved a workspace + `full` CLI seat **is** reachable in Orchestrated via `P-R1-16`'s name collision, in a mode where the Workspace tab is hidden and `prepareWorkspace` never runs. R2 corrected the framing — Orchestrated is **not** inherited from `main`; the whole tab is new here. R3 confirmed it has zero REST/MCP surface. |

### Open questions answered from code

- **Q-R1-1** — `--permission-mode dontAsk` is valid (`claude --help` lists it). `--disallowedTools '*'` does remove the tools. See the correction above.
- **Q-R1-2** — Branch parking is deliberate and documented. Only the *auto-switch* was ever in question, and it is now rejected.
- **Q-R2-1** — Genuine inconsistency. `discover()`'s Claude branch populates `models` from parsed `--help` **aliases only** and its own note says "Aliases or full model names (claude-…)". So the roster cell's `claude-cli` exclusion (`:1214`) is right and `multiaiRouteLabel:1157` is the bug — it warns on legitimate full model names. **One line.**
- **Q-R2-3** — `independentFirstRound: false`, checkbox unchecked. It is opt-in; `docs/MULTIAI.md` listing it unqualified alongside Rounds and Brevity is the error. Doc fix.
- **Q-R2-4** — **Keep committing on error; fix the presentation.** Not committing would leave a `full` seat's half-finished edits untracked until the *next* run sweeps them up as "WIP left by an interrupted turn" — strictly worse and attributed to the wrong agent. The card should read `partial — turn errored`.
- **Q-R3-2** — No functional bug. `askVariant` never passes `workspace`, so a library seat's `tools` level is genuinely ignored, consistently. **Caveat**: that guarantee is delivered as a *prompt*, and `P-R1-15` shows `body.system` overwrites it.

---

## Ship-blocking set

Ranked by consensus across the three reviewers' independent rankings. Items
marked **†** were introduced in Round 2, so only their author has ranked them;
they are here on the strength of their evidence and are the specific focus of
Round 3 signoff.

### 1. `P-R1-6` — Arbitrary command execution from a model-supplied string
**All three reviewers ranked this #1 or #4; R1 and R3 both #1.**

`cli.cjs:460-467` builds a command string and calls `spawn(..., { shell: true })`.
On Windows that is `cmd.exe /d /s /c "<string>"`, which interprets `& | < > ^ ( ) %`.
The quoting function only quotes on whitespace-or-quote, and its escape (`\"`)
is not a cmd escape.

R1 executed all four payloads. **`whoami` ran in every one**, including the
quoted branch:

| payload | outcome |
|---|---|
| `opus&whoami` | `whoami` ran |
| `opus\|whoami` | `whoami` ran |
| `opus^&whoami` | `whoami` ran |
| `a"&whoami&"b` | `whoami` ran |

The input path is fully open: `normalizeAgents` does not validate `model`
(`multiai-core.cjs:99`); `resolveVariant` assigns `body.model` verbatim on both
branches (`variants.cjs:86,88`); the MCP schema is a bare `z.string()`
(`tools-cli.js:73`). Reachable from `POST /v1/multiai/variants/ask`,
`POST /v1/chat/completions`, WS `ask_variant`, and the `ask_variant` MCP tool —
i.e. **from another model**.

**Fix**: stop using `shell: true`; spawn the resolved binary directly, and for
`.cmd`/`.bat` shims spawn `cmd.exe` with an argv array. Independently, validate
model and effort against `/^[A-Za-z0-9._:\[\]-]+$/` at `resolveVariant`, and
reject cmd metacharacters in workspace roots at folder-pick time. The validation
alone closes the injection path and is a handful of lines.

### 2. `P-R1-15` † — A caller-supplied `system` deletes the only thing keeping `none` seats honest
`variants.cjs:100` — `body.system || ONE_SHOT_SYSTEM_PROMPT` **replaces** rather
than appends. Reachable from `POST /v1/multiai/variants/ask`, `/v1/chat/completions`
(any `role:'system'` message), WS `ask_variant`, and `tools-cli.js:76`.

Measured: with the app's prompt, 3/3 clean refusals; with it removed, immediate
`<invoke name="Read">` + `<invoke name="Bash">` plus a fabricated
`Command running in background with ID: 8ceabb3`.

> **Signoff correction (R1).** That measurement used
> `DISCUSSION_SYSTEM_PROMPT` (`cli.cjs:43-46`), which ends *"Never run
> commands."* The path this item fixes is the **variant** path, whose string is
> `ONE_SHOT_SYSTEM_PROMPT` (`variants.cjs:13-15`) — it has the "no tools and no
> filesystem" clause but **not** "Never run commands", and was never measured.
> Pinning the clause as written would pin the weaker, untested string.
> **Align `ONE_SHOT_SYSTEM_PROMPT` with `DISCUSSION_SYSTEM_PROMPT` as part of
> this same change.** This also narrows a rejection: `P-EX-1` (2) is a no-op for
> `cli.cjs` but is **not** a no-op for `variants.cjs` — accept it there.

Every OpenAI-compatible client sends a system message — Open WebUI, LiteLLM, the
`openai` SDK, every agent framework. So the **normal** use of `/v1/chat/completions`
against a `cli:` model strips the guard and puts the seat back into
fabricate-tool-calls mode, returning invented file contents and shell output as a
plain assistant answer. For Codex the same override removes the only restraint on
a `danger-full-access` shell.

**Fix**: make the no-tools clause non-overridable — always emit it, append
`body.system` after it. **One line.**

### 3. `P-EX-1` + `P-R1-7` — The default tools level does not do what its label says
R1 ran the app's exact `none` args for Codex. Codex prints its own banner:
**`approval: never`, `sandbox: danger-full-access`**. The UI
(`multiai-renderer.js:1012`) says `'Discussion only — no file access (the CLI runs
in a scratch folder).'` `docs/MULTIAI.md:92` is honest; the UI is not.

The asymmetry is now established by measurement: **Claude `none` has its tools
genuinely removed; Codex `none` has a real unsandboxed shell restrained only by
prompt text** — the same prompt `P-R1-15` shows is deletable. And `none` is the
default (`multiai-core.cjs:101`).

**Fix**: prefer `--sandbox read-only -C <scratch>` for Codex `none` where the
helpers exist; where they do not, either refuse the seat or **label it honestly**.
The label must not say the opposite of the flag. Plus retain `P-EX-1`'s
proposals (3) and (4): strip/flag `<invoke …>` blocks in recorded runner output,
and a regression test. Proposals (1) and (2) are retired (see Corrections).

### 4. `P-R2-22` † — The app's help text makes four safety claims the code contradicts
Independently verified by the executive in the working tree; all strings present
verbatim. R2 cited three; a fourth was found.

| Where | Claim | Contradicted by |
|---|---|---|
| `index-v2.html:1719` | "these providers only see text you send them — none can read or write files on this computer" | `cli.cjs:513-527`, `:568-580` |
| `index-v2.html:1687` | "Proxima refuses to run over your uncommitted work" | `workspace.cjs:106-118` |
| `multiai-renderer.js:1344` | "Proxima never sweeps your uncommitted work into it" | `workspace.cjs:106-118` |
| `index-v2.html:1708` | "Agent (file tools) — the only strategy that touches your actual filesystem" | Classic CLI seats at `read`/`write`/`full` |
| `multiai-renderer.js:1012` | `none: 'Discussion only — no file access…'` | `cli.cjs:579` (Codex bypass at `none`) |

> **Signoff change (R2) — the fifth string moves here.** The `:1012` tooltip was
> originally routed into blocking item #3, which has a behavioural half that may
> reasonably be deferred. This item is copy-only and must land regardless. If it
> ships alone while `:1012` still reads "no file access" on the **default** tools
> level, a corrected help modal makes the stale tooltip *more* credible, not
> less. **Put `:1012` in the copy commit; leave #3 only the flag change.** This
> is the highest-risk interaction in the set.
>
> R2 also notes the sentence at `:1708` is sharper than it looks: the
> Orchestrated strategy it *does* warn about is confined by `resolveInRoot`
> (listed under *Verified sound*); the Classic `full` seat it steers attention
> away from is confined by nothing.

The second and third name the dangerous case — "or already on the chat's branch" —
and then promise safety precisely in it. The fourth was true before this branch
and now steers attention toward the loud, well-marked feature and away from the
quiet one that is more dangerous. Note the visual marking makes the same error in
the same direction (`P-R2-3`).

These are assertions, not omissions. A user who reads the modal to decide whether
this is safe to point at a real repository is told, in the app's own words, that
it cannot touch their files. **Copy-only, no behaviour change** — and it should
land even if the behavioural fixes are deferred, especially then.

### 5. `P-R1-2` + `P-R1-16` † — Workspace safety is bypassed on every path but one
`prepareWorkspace` is called from exactly one line (`multiai.cjs:652`, in
`runClassic`). Orchestrated's `runCrew`/`runWorkflow`/`runLoop`, and the judge /
summary / auto-summary / title paths through `sendAux`, all reach `sendCli` →
`workspaceFor` with **no repo check, no dirty-tree refusal, no branch switch, no
writer lock and no commit**.

R1 established the escalation mechanism: `findAgent` (`multiai-core.cjs:124-134`)
matches on **name** before provider. Verified by running it — renaming a
`claude-cli` seat to `Claude` makes `findAgent(agents,'claude')` return that seat
*with its `tools` level*. The Name field is free text and doubles as the @mention
id, so this is a natural thing for a user to do. The Judge, auto-summary, title
generator and every pipeline step then run with `full` shell access in the repo.

The same collision has a second edge: a library seat named `Sonnet 4.5`
normalises to `sonnet45` and can hijack an external client's request for model
`sonnet-4.5` onto a local CLI on the user's subscription.

R3 established the blast radius is **local UI only** — Orchestrated has no REST
route and no MCP tool — which lowers it below `P-R1-6`/`P-R1-8` but does not
retire it.

**Fix**: resolve bare provider strings by provider only; reserve name lookup for
`@mentions` and explicit agent-id fields. `sendAux` must never inherit a `tools`
level. Force `tools:'none'` in Orchestrated (Conflict 5).

> **Signoff correction (R1) — the finding is larger and the fix above is
> insufficient.** Three things, all verified by running the code:
>
> 1. **No rename is needed for Codex.** `normalizeAgents({provider:'codex-cli'})`
>    yields `id: 'codex'`, so `findAgent(agents,'codex')` hits on the **id**
>    branch directly. (`claude-cli` → `claude-code`, so the rename story is true
>    only for Claude.)
> 2. **"Resolve by provider only" does not close it.** `providerLabel('codex-cli')
>    === 'Codex'` (`multiai-core.cjs:144`) and `findAgent`'s provider branch
>    normalises labels (`:132`) — so the provider-only path *still* returns the
>    `full` CLI seat. That branch also matches only when exactly one agent uses
>    the provider; the fix must not assume it is unconditional.
> 3. **`maybeAutoSummary` reaches it with no collision at all.**
>    `multiai.cjs:625` — `const judge = chat.judgeProvider ? agentFrom(...) :
>    agents[0];`. With no judge configured, the auto-summary runs the roster's
>    **first seat, `tools` intact**, through `sendAux` → `sendCli` →
>    `workspaceFor`. Its edits are never committed (`sendAux` has no `commitAll`)
>    and sit in the tree for the next writer turn's `git add -A` to claim.
>
> **So the load-bearing half is `sendAux` forcing `tools:'none'`** — listed third
> above as if optional. Promote it. Also exclude CLI providers from the
> provider-label alias match.
>
> **Hard implementation constraint (R1 + R3):** do **not** change `findAgent`
> itself. `multiai-core.test.js:279-297` locks its id→name→normalised-name chain
> for legitimate `@mention` and HANDOFF resolution, which genuinely needs name
> matching. Add a **separate provider-only resolver** for the call sites that
> pass a bare provider string (`sendAux`, `judgeProvider` dispatch, Orchestrated
> step resolution, `isVariantModel`'s bare-string branch) and leave `findAgent`
> untouched.

### 6. `P-R1-8` + `P-R2-19` † + `P-R1-17` † — Externally-started runs are invisible, unstoppable, and corruptible
One missing event causes all of it. No listener sets running to `true`
(`preload.cjs:108-115` has no such channel); `multiaiRunning()` is polled once at
init.

R3 refined this usefully: REST and MCP **already** see external runs correctly
via `runSignals`. It is a renderer-only gap. But the renderer consequences stack:

1. Turns and "X is thinking…" notes stream into the open chat with no ●, no Stop, Send still enabled.
2. If the user presses Send, `multiaiRunRound` increments `chat.cycle`, pushes the message and **persists before awaiting IPC**. The IPC is then refused — but the message and bumped cycle are already in the store, merge in, and are read by the live run's next turn as the newest instruction, in a cycle it does not belong to. `runClassic`'s return filter then drops the mismatched turns.
3. If the user deletes the chat instead, `multiaiDeleteChat` only stops the run `if (multiaiIsRunning(chatId))` — false here. The run keeps holding CLI slots and a `write`/`full` seat's in-flight turn still reaches `commitAll`, committing to the repo for a chat that no longer exists.

**Fix**: emit `multiai-run-started` from `startSignal` (`multiai.cjs:123`), add the
preload channel, set running on it. Have `multiai-running` return
`{chatId, startedBy, round, of}`. Guard `multiaiSend`/`multiaiDeleteChat` on a
fresh check, and move the user-message push to after the IPC resolves.

**Rejected sub-proposal**: requiring `workspace.root` to have come from
`dialog.showOpenDialog`. It breaks the headless workflow the docs explicitly
advertise and is unenforceable for the standalone server. Use a first-run
confirmation for externally-created workspace chats with `tools !== 'none'` instead.

### 7. `P-R1-3` + `P-R1-9` — Stop races the commit, and can leave an unkillable orphan
`handle.abort()` returns immediately and `killTree` fires `taskkill` without
waiting, while `commitAll` runs on the next tick and the writer lock is released
*after* the commit. So Stop can commit a half-written file as the seat's work,
and releases the lock while a zombie is still writing — defeating the
serialisation the whole workspace design rests on.

Separately, `cli.cjs:474-481` re-checks `aborted` before resolving the executable
but not before `spawnCli`. For Codex that window includes `resolveCodex()`, which
runs `--version` on two candidates at 8s each. Stop inside that window spawns a
process the app can no longer kill.

**Fix**: make `abort()` return a promise settling on the child's `close` (or a
3-5s deadline) and await it before `commitAll` and before releasing the lock.
Re-check `aborted` immediately before `spawnCli`.

> **Signoff correction (R1) — `P-R1-9`'s second half was dropped.**
> `multiai.cjs:546` — `const releaseWriter = writer ? await acquireWriter(chatId)
> : null;` runs straight into `sendAgent` at `:550` with **no `sig.cancelled`
> re-check**. So Stop during a parallel round still spawns writers 2..n as the
> lock drains, each of which reaches `commitAll`. The fix above covers only the
> `cli.cjs` re-check. Whoever implements this is already editing
> `takeTurn:544-558`; the check is one line there.
>
> The single await point for the abort is `sendCli:391`
> (`if (raced.cancelled) handle.abort();`); `stopChat:115` can stay
> fire-and-forget once that awaits.

### 8. `P-R1-1` — CLI children outlive the app
`cleanupSpawnedChildren()` (`main-v2.cjs:1050-1058`) only stops the REST API and
IPC server. Each child lives solely in a `runProcess` closure — no registry, no
`killAll()`. Closing Proxima mid-run leaves `claude.exe`/`codex.exe` running
detached; on a `full` seat that process keeps editing the repo with no parent, no
timeout (the timer died with it), and no attribution, and the next `prepare()`
commits the result as "WIP left by an interrupted turn".

**Fix**: a module-level `Set` of live children, an exported `killAll()`, called
from `cleanupSpawnedChildren()` and the signal handlers.

### 9. `P-R1-4` — The writer lock is keyed by chat, not by repo
`writerLocks` is a `Map<chatId, …>` and `runSignals` enforces one run per *chat*.
Two chats pointing at the same folder can run simultaneously — one from the UI,
one from REST, the exact concurrent-agents scenario this feature exists to
enable. They check out different `multiai/*` branches in one working tree while
the other's seats are mid-edit, and each `git add -A` sweeps the other's
in-progress work into its own commit.

**Fix**: key the mutex on `path.resolve(root)`, and refuse to start a run whose
workspace root is claimed by another running chat. Per `P-R3-13`, that refusal
must be **synchronous in `api.run`** — checked the way `isRunning(chatId)` already
is — or a `wait:false` caller gets `{started:true}` for a dead run.

### 10. `P-R1-5` (halves a and c only) — The WIP commit swallows work the app did not make
`workspace.cjs:106-121` — when the tree is dirty on the chat branch, `prepare()`
commits **everything** as `multiai: WIP left by an interrupted turn`, under the
app's identity, with `--no-verify`, with no check on who made the changes. And
`inspect()` sets no warning in exactly this state (`:87` warns only when
`dirty && cur !== branch`).

Since branch parking is deliberate (Conflict 1), the user's own later work
routinely sits here.

**Fix**: record head + a dirty-file list at the end of each writer turn; only
auto-attribute WIP that matches. Anything else surfaces as "uncommitted changes
on this branch that Proxima did not make". Extend `inspect()`'s warning to the
`cur === branch && dirty` case.

> **Signoff correction (R1) — one signal already exists.**
> `multiai-renderer.js:1365` already renders `with uncommitted changes` in amber
> in exactly this state. The gap is the *warning text explaining the
> consequence* (`out.warning`), not the absence of any indicator — otherwise the
> fix duplicates an existing badge.

### 11. `P-R2-2` — An agent can be dropped from a run with zero trace
`multiai.cjs:649-651` filters out browser agents whose provider is disabled in
Settings, with no `note()`. The roster ticks the agent, the summary counts it, the
composer hint names it, and the run happens without it. The `if (!agents.length)
agents = all.slice()` fallback also makes behaviour inconsistent between "some
disabled" and "all disabled".

Both R1 and R2 flag this as **the only place in the branch where a configured
capability fails with no trace anywhere**. The codebase already has the
convention two functions away (`runClassic:672-676` notes a benched agent).
**One `note()` call.**

### 12. `P-R1-11` — One transient throw poisons discovery for the session
`discover()` has no `try/finally`; `_discovering = null` only on the success path.
A single throw leaves a permanently rejected promise, and `force:true` is only
honoured *after* the in-flight check, so ↻ cannot recover it.

Both other reviewers raised the severity from R1's own framing:
- **R2**: the symptom is not a visibly dead editor. With `cliInfo: null` the UI falls back to model hints and generic efforts and **looks completely healthy** — what silently disappears is the CLI version, login state, and the `⚠ no sandbox helpers: read/write tools unavailable` warning. A safety warning vanishes without trace.
- **R3**: `variants()` calls `discover()` directly and does **not** swallow the rejection, so `GET /v1/multiai/variants` and the `cli_variants` MCP tool start failing **every request** until restart.

**Fix**: `try/finally`, ~3 lines. Let `force` short-circuit the in-flight check.
Surface the failure in `cliInfo` rather than nulling it.

### 13. `P-R1-10` — Colliding scratch filenames can hand a seat the wrong system prompt
`cli.cjs:534` names the system-prompt file `system-<pid>-<Date.now()>.txt` — no
random suffix, though Codex's `outFile` has one. R1 simulated four seats writing
in one tick: **2 distinct filenames for 4 writes, last write wins.** `takeTurn`
has no `await` before `sendAgent` for a non-writer seat, so an independent first
round does exactly this.

R1 raised it medium → high because of what it compounds with: if a `write` seat's
workspace prompt overwrites a `none` seat's file, the `none` seat is spawned
believing it has file tools — the exact measured condition that produces
fabricated `<invoke>` blocks and invented tool results.

**Fix**: `fs.mkdtempSync` per run, removed in a `finally`.

> **Signoff correction (R1) — a third limb was dropped, and it decides the fix.**
> `mcp_empty.json` lives in the same global `scratchDir` (`cli.cjs:442-447`), is
> written only if absent, and is what `claudeArgs` points
> `--strict-mcp-config --mcp-config` at (`:528`) — while a Codex `none` seat runs
> **inside that same directory** with the sandbox bypassed (`:576`). A seat that
> writes real MCP servers into it changes what the next Claude seat loads.
> Confirmed global: both `sendCli:384` and `askVariant` pass `cwd: dataDir()`.
> **The "at minimum a random suffix" fallback does not close this** — take
> `mkdtemp`-per-run, not the cheap variant.

### 14. `P-R2-3` (marking half) — The most dangerous configuration is the least marked
`multiai-renderer.js:1228` — `toolsWarn = isCli && tools !== 'none' && (!hasWs ||
codexNoSandbox)`. With a workspace attached and `tools='full'`, `toolsWarn` is
**false**: no amber border. The harmless case (tools configured but inert) is
marked; the case that grants an unsandboxed shell on a real repo is not.

**Fix**: persistent border for `full` and `write` regardless of workspace state.
The confirmation dialog can follow.

---

## Accepted, not blocking

Real, evidenced, and worth scheduling. None corrupts state or executes code.

| ID | Finding | Cost |
|---|---|---|
| `P-R1-20` † | Codex discovery describes a different binary than the one that runs. Live on this machine: the app picks bundle `0.152.1`; `models_cache.json` says `client_version 0.142.5`; `config.toml`'s `gpt-5.6-sol` is absent from the parsed list, firing a **spurious** stale-data warning and defeating effort clamping *after* discovery. | M |
| `P-R1-19` † | The status strip needs a hook that does not exist. `acquire()` is two layers below `multiai.cjs` in a deliberately Electron-free module. Add an optional `onState(state)` callback to the `cli.run` options bag. **Prerequisite for `P-R2-1`.** | S |
| `P-R1-18` † | REST `run` reports `200 {messages:[]}` / `202 {started:true}` for a run that never started — the realistic case being the dirty-tree refusal, the feature's headline safety check. | S |
| `P-R2-1` | No per-agent run visibility. Two states + sub-label (Conflict 2), rebuilt from a `multiai-running` snapshot. Blocked on `P-R1-19`. | M |
| `P-R2-20` † | Fabricated tool-call text renders as ordinary prose and is fed to every agent as evidence. Flag `message.toolClaim`, badge it, fold the block into `<details><pre>`. Worth doing independently of the `P-R1-15` fix, since it survives if that fix is incomplete. | S |
| `P-R2-21` † | The agent library is the public model catalogue of the REST port and MCP server, and the UI presents it as a local convenience. Renaming changes a published model id; the unconfirmed ✕ breaks external callers. | S |
| `P-R2-23` † | ↻ is the only recovery for three stale states, blocks the main process, and has no busy/success/failure state — indistinguishable from `P-R1-11`'s permanent failure. | S |
| `P-R1-14` / `P-R3-3` | Variant calls have no cancellation and an unbounded queue; `timeoutSeconds` bounds the process, never the queue wait. Per `P-R3-14`, the deadline error must carry `.status = 503`. | M |
| `P-R3-15` † | `sendJSON`/`sendError` need a `res.writableEnded \|\| res.destroyed` guard — land it *with* the abort-on-disconnect wiring, not after. | S |
| `P-R1-12` | `execFileSync('where')` blocks the Electron main thread — window, BrowserViews, REST server and IPC freeze together, up to 3 × 5s, fired from the ↻ button. | M |
| `P-R1-13` | Timeout timer not cleared on failure paths; unbounded `stdout`. (Recycled-PID risk **refuted** by R1 — `child.pid` is normally undefined there.) | S |
| `P-R2-15` | Replies render as raw text — no markdown, no code blocks. The judge verdict and the structured summary are the worst cases. | M |
| `P-R2-5` | The 12 kB diff card has no `max-height` and truncates mid-line, hiding its own truncation. (`stat` **is** forwarded — R2 corrected itself; only `truncated` is lost.) | S |
| `P-R2-6` | The feed force-scrolls on every arriving message; you cannot read during a run. | S |
| `P-R2-9` | Warning text at **2.34:1** contrast, 0.68rem. R1 confirmed it is hiding a *live* warning on this machine right now. | S |
| `P-R2-7` | The roster re-renders the whole table on every arrow key and drops focus to `<body>`. | M |
| `P-R2-8` | One `aria-` attribute in 4,542 lines; no `aria-live`; tooltips are the accessible names. | M |
| `P-R2-10` | Route state is read once and goes stale after any Settings change, so the roster lies about what will happen. | S |
| `P-R2-11` | A 0-agent chat's feed is blank with no route to the Agents tab. (Severity reduced — a full help modal exists behind ❔.) | S |
| `P-R2-12` | The Workspace preview never refreshes on tab select, and the check that blocks the run happens *after* Send. | S |
| `P-R2-13` | Warnings are sorted last into an ellipsised one-liner; "▶ Run round" is two hidden clicks deep. | S |
| `P-R2-14` | Toasts are the sole error channel and collide — a second error is visible ~100 ms. Run failures are never written to the feed. | S |
| `P-R2-4` | The transcript never records which model or route produced a turn, though the message carries both and REST exposes them. | S |
| `P-R3-1` | The standalone server's own comment claims it shares concurrency caps with the app; they are separate processes. Plus: it has no `resetAvailabilityCache`, so a `503 not installed` persists forever. | S |
| `P-R3-2` | Effort clamping silently no-ops until `discover()` has run in that process — and, per `P-R1-20`, also afterwards for unlisted models. | S |
| `P-R3-4` | `docs/openapi.json` documents none of the 8 new routes, though it is served as the machine-readable contract to exactly this feature's audience. | M |
| `P-R3-5` | No `[5.1.0]` CHANGELOG entry and no README mention for a version-bumping 13k-line feature. Plus `docs/MULTIAI.md:151` documents a ✎ control that does not exist. | S |
| `P-R3-6` | Document `stream: true` on `cli:` models as single-shot (Conflict 3), and add the missing closed-response guard. | S |
| `P-R3-8` | The "≤8 variants" cap is enforced in three places and tested at none. | S |
| `P-R3-9` | The MCP harness bypasses zod validation entirely, so every documented input constraint has zero coverage. **Use `inputSchema.parse()`, not a real `McpServer`** — see Rejected. | S |
| `P-R3-10` | `codexEffortFor`'s clamp branch is untested; the test named for it exercises the "no discovery yet" branch instead. | S |
| `P-R3-11` | REST `run` with `wait:true` is uncapped while `/wait` is capped at 120s. | S |
| `P-R3-12` | 409/400/404 status codes are implemented and never asserted. | S |
| `P-R3-13` † | The per-repo lock refusal must be synchronous in `api.run`. Land with `P-R1-4`. | S |
| `P-R2-16` (line only) | One line in the Pipeline pane: steps use browser providers only; agents/routes/workspace are Classic-only. Plus the three-line fix to `multiaiOptionsWithSelected:2089-2091`, which silently falls back to the first option when a saved provider is absent. | S |
| `Q-R2-1` fix | Add the `claude-cli` exclusion at `multiaiRouteLabel:1157`. | One line |

---

## Rejected

With the reason, so these do not resurface.

| Proposal | Why rejected |
|---|---|
| `P-EX-1` (1) — deny by explicit tool name instead of `*` | Measurement shows `*` already removes the tools. A hard-coded list is a maintenance trap that silently **grants** every tool Claude Code adds later. |
| `P-EX-1` (2) — add a no-tools line to the system prompt | Already implemented at `cli.cjs:43-46`. No-op. |
| `P-R1-5` (b) — auto-switch the tree back to base | Contradicts documented design (`docs/MULTIAI.md:114-135`). Unanimous. Replace with an explicit "return to `<base>`" button. |
| `P-R1-8` (2) — allowlist `workspace.root` to dialog-picked folders | Breaks the headless workflow the docs advertise; unenforceable for the standalone server. Use a first-run confirmation instead. |
| `P-R2-16` — unify the agent model across modes | A design change, not a defect fix, in a mode with none of Classic's safety infrastructure. Expanding `tools:'full'` reach into three unguarded paths multiplies the risk the panel is closing. |
| `P-R2-17` — inline-style sweep as its own commit | Diagnosis correct; a mechanical restyling pass across the largest file in the delta immediately before merge is the change most likely to introduce a silent visual regression. Fold `renderAgentRow()` into `P-R2-3`/`P-R2-7`, touching only those rows. |
| `P-R2-18` — header tab-strip overflow | Never reproduced; measured as an estimate against a `minWidth` the user chose. `.tab-nav` is pre-existing layout the delta did not touch. Author withdrew it. |
| `P-R3-7` — variant `usage` zeros | `{0,0,0}` is a common, understood convention. Omitting breaks strict clients; estimating substitutes a plausible lie for an obvious one. A doc sentence is the whole fix. |
| `P-R2-1`'s writer-lock as a 4th visual state | Internal detail leaking into the main stream. Fold into the `waiting` label. |
| `P-R3-9`'s stated remedy — construct a real `McpServer` | The finding stands; standing up real SDK dispatch in the harness is a test-infrastructure project. `inputSchema.parse()` gets the same guarantee in a few lines per tool. |

---

## Needs a decision from you

Everything else was settled from code. These are intent, not fact.

1. **`Q-R1-4` — roster edits during a run.** Today `tools` is pinned at run start (`multiai.cjs:646-651`) while `chat.workspace.root` is read live every turn (`:512`). Change the folder mid-run and the next writer turn edits the new folder on a branch prepared for the old one. Both behaviours are defensible; they should be one rule. Whichever you pick, the roster must *show* it — silently accepting edits that half-apply is the one option to rule out.
2. **`Q-R2-2` — was Orchestrated ported from ProximaChatApp and deliberately frozen?** The code says "PCA parity" (`multiai-renderer.js:845`). It is not inherited from `main` — the whole tab is new here. A one-line doc commitment is being recommended on the assumption the answer is yes.
3. **`Q-R3-1` — should `workspace.root` be confined at all?** No allowlist today; any absolute path is accepted from REST/MCP. This may be exactly the intended trust model for a local-automation feature. Note this is separate from `P-R1-6`: rejecting cmd metacharacters in paths is a bug fix regardless of how you answer.
4. **`Q-R1-3` — should a workspace chat be allowed into Orchestrated at all?** The safety fix (force `tools:'none'`) lands either way; this is about whether the combination should exist.

Two of these overlap material in the Cowork chats that could not be fully
recovered ("Proxima app gaps analysis", "Multi-agent local chat frontend"), so
they may already be settled.

---

## Round 3 signoff

All three reviewers returned **APPROVED WITH CHANGES**. No blocking objection to
any finding, rejection, or the 14-item set — each independently confirmed the set
is right as drawn, with no additions and no removals. The corrections they raised
are folded into the items above; what follows is what they added about *building*
these fixes.

### Line references to trust the string, not the number

Several citations drifted by 1-3 lines during consolidation. All are inside the
right function. Grep the string rather than the number.

| Master says | Actually |
|---|---|
| `multiai-renderer.js:1367` ("Folder is on") | **`:1365`** |
| `workspace.cjs:87` (`inspect()` warning) | **`:86`** |
| `multiai.cjs:1252` (swallowing `.catch`) | **`:1251`** |
| `runClassic:672-676` (benched-agent `note()`) | **`:678`** |
| `main-v2.cjs:1050-1058` (`cleanupSpawnedChildren`) | **`:1051`** |

R2's original `index-v2.html:1710`/`:1707` were wrong and are corrected to
`:1719`/`:1687` in the table above; all four strings re-verified verbatim by two
reviewers and the executive.

### Seven passing tests will break

The suite is 731/0 today. These assertions encode the behaviour being changed and
must be rewritten **in the same commit** as the fix, not discovered in CI.

| Test | Broken by | Note |
|---|---|---|
| `multiai-handlers.test.js:642` | `P-R1-15` | asserts `systemPrompt.startsWith('Custom system.')` |
| `multiai-handlers.test.js:683` | `P-R1-15` | asserts `systemPrompt.startsWith('Terse.')` |
| `variants.test.js:63` | `P-R1-15` | asserts `systemPrompt.startsWith('Custom.')` |
| `cli.test.js:130-131` | `P-EX-1`+`P-R1-7` **behavioural half only** | asserts Codex `none` emits the bypass flag; the label-only half does not touch it |
| `workspace.test.js:73-90` | `P-R1-5` | asserts `prepare()` commits leftovers as WIP with `wip.wip` truthy |
| `multiai-core.test.js:279-297` | `P-R1-16` **only if implemented wrongly** | locks `findAgent`'s name matching for `@mentions`. If this goes red, the fix touched the wrong function |

Rewrite the three `P-R1-15` assertions to `.includes(...)` or to the new
prefix-then-caller-text order. The `.includes('[Persona]')` assertions at `:634`
and `variants.test.js:58` are unaffected. For `workspace.test.js`, define the
"no recorded turn" case deliberately — do not let it be "fixed" by making the new
gate default-open.

**The pseudo-stream test at `multiai-handlers.test.js:678-689` is safe.** R3
checked: the mock `res` has no `destroyed`/`writableEnded` properties, so the new
guard is always false and every write proceeds as before.

**Coverage that does not exist and should.** No test exercises `spawnCli`'s
Windows quoting branch at all — `cli.test.js` tests argument construction, never
the spawn. `P-R1-6` lands with zero regression coverage unless one is written.
Neither escalation path in `P-R1-16` (rename-collision, model-hijack) has a test
either.

**`P-R3-9`'s remedy as written will throw.** `meta.inputSchema` is a raw Zod
*shape* (a plain object of field types), not a composed schema — it has no
`.parse()`. The real SDK wraps it via `z.object(shape)` internally. The correct
call is `z.object(tool.meta.inputSchema).parse(args)`.

### Implementation constraints

**Do not implement `P-R2-3` by widening `toolsWarn`.** The obvious edit — dropping
`(!hasWs || codexNoSandbox)` at `multiai-renderer.js:1228` — regresses
`toolsTitle` at `:1229-1234`, which branches on the same condition. The
no-workspace copy ("this seat runs without tools until one is set") would then be
shown for an *armed* `full` seat with a workspace attached: telling the user the
most dangerous configuration in the app has no tools, exactly inverted. Two
independent signals are needed, with **different** treatments — reusing one amber
for both is what produced the finding.

**`P-R2-2`'s marking must not reuse amber either.** R2 withdrew that half of its
own Round 1 proposal: if `write`/`full` gains a persistent amber border, a benched
browser seat and an armed unsandboxed shell would look identical again. Use a
distinct treatment (dimmed row, struck checkbox). The `note()` in `runClassic` is
the part that matters and is unaffected.

**Decide the `multiai-running` payload shape now.** Item #6 specifies
`{chatId, startedBy, round, of}`; `P-R2-1` needs `agents:[{agentId, state}]` to
rebuild the strip when the user switches into a running chat. Ship `agents: []`
in the same change or the IPC payload gets versioned twice.

**`P-R1-19` is four touch points, not one.** `cli.run` fans out to
`runClaude`/`runCodex`/`runGemini`, each building its own `runProcess`, and
`await acquire(kind)` is at `runProcess:475`. The `onState` callback threads
through all four. It must stay optional or `variants-server.js`'s Electron-free
contract breaks. Land it inside #6, which is already reopening the run-event
surface.

**`P-R3-14`'s queue deadline is shared with the UI.** `MAX_PARALLEL` and the
single `await acquire(kind)` serve both `sendCli` (UI turns) and `askVariant`
(REST/MCP). A four-seat single-provider panel — the feature's own headline
example — routinely has two seats queued. A deadline tuned for a REST client will
abort legitimate UI turns. Scope it per-surface, and do not land it before
`P-R2-1`/`P-R1-19` give waiting a visible state.

**`P-R2-9` must not land before `P-R1-20`.** The string currently hidden at 2.34:1
is `⚠ default gpt-5.6-sol not in its list`, and `P-R1-20` establishes it is
**spurious** — stale `models_cache.json` from a different Codex build. Fixing
contrast first makes a false warning prominent and trains the user to ignore that
footer, which is also where the genuine `⚠ no sandbox helpers` line renders.
That is the exact "stop checking" failure #4 is blocking on, reintroduced by a
fix meant to help. (`#4b4b60` is 10 sites — 4 in the renderer, 6 in the HTML — so
this is a straight hex swap, not blocked on any refactor.)

**Free hint for #6.** `preload.cjs:114` already carries `onMultiaiChatCreated`, so
an externally-created *chat* reaches the renderer while an externally-started
*run* does not. The pattern to copy is four lines above the gap, in the same file.
Note `startSignal` fires for all three entry points including the UI's own run —
make the event idempotent, and ensure the `finally` at `multiai-renderer.js:1877`
cannot clear a still-live external run.

**#3: take the label-only half for this merge.** The behavioural half needs
helper-presence, which `codexArgs` cannot see — it is synchronous and built at
`runCodex:587`, *before* `resolveCodex()` resolves via the `exe` thunk at `:594`.
Reading `discovered()` instead returns `null` in a cold standalone
`variants-server.js` process, which is `P-R3-2`'s exact bug — and the fallback
would silently be bypass-the-sandbox. Schedule the behavioural half with
`P-R3-2`.

### Merge order

1. **#4 `P-R2-22` first, alone** — copy-only, no dependency, must not be held hostage. Include the `:1012` tooltip.
2. **#1 `P-R1-6` in two commits** — the `resolveVariant` character class closes the injection and touches nothing else; removing `shell: true` rewrites `spawnCli:460-467` on the path of every CLI run. The regex is safe against the current suite and already accommodates the `[1m]` suffix.
3. **#2 `P-R1-15` before #3** — both settle what a `none` seat actually gets; #2 decides which string is pinned. Resolve the `ONE_SHOT`/`DISCUSSION` discrepancy here. Land with the three test rewrites.
4. **#5 before #9** — shrinking what can claim a repo before keying the lock per-repo; otherwise a leaky resolver just relocates the failure.
5. **#9 + `P-R3-13` are one change. Never split.** `P-R1-18` touches the same `api.run` lines — do it here too.
6. **#6's renderer reordering before #9's refusal** — `multiai-renderer.js:1859` persists and bumps `cycle` before awaiting IPC at `:1872`; a repo-conflict refusal would corrupt `cycle` the same way an external run does today. Defer only the persist and the bump, **not** the optimistic render, or the feed goes dead for a round-trip.
7. **#7 before #10** — same fifteen lines, and #10's "record head + dirty-file list at the end of each writer turn" is only meaningful once the turn terminates deterministically, which is what #7 provides. Reversed, #10 records a list a zombie is still invalidating.
8. **#8 after #7, reusing it** — `killAll()` must use the same awaitable kill, or quit-time teardown races `commitAll` exactly as Stop does today.
9. **#12 absorbs `P-R2-23`'s main-side half** (one owner for `cliError`). **`P-R3-15` merges with `P-R3-6`'s guard** — same defect at two call sites; today's unguarded write is `multiai.cjs:1308-1315`, and `rest-api.cjs:218-226` only becomes reachable once abort-on-disconnect lands.
10. **`P-R2-3` and `P-R2-7` share the `renderAgentRow()` extraction** — whoever lands first extracts it whole. If `P-R2-7` lands the per-`<tr>` update, `P-R2-3`'s border must be a property of the row renderer or it will not repaint when the Tools cell changes, which is the only moment it matters.

### Two notes on how to read the set

- **#12, #13 and #14 are in the set on "cheap enough that deferring costs more" grounds, not peer severity with #1-#7.** Do not mis-price them.
- **One unresolved asymmetry about confirmation dialogs.** #14 defers `P-R2-3`'s confirm, while #6's replacement for the rejected allowlist *is* a confirmation dialog — so a confirm is inside the gate for the rarer remote path and outside it for the common local one (a user picking `full` next to a folder they just attached). R2's preference, unopposed: keep both out of the gate and ship them together afterwards, so there is one confirmation design rather than two.

### One item restored to Accepted

**Unconfirmed destructive deletes in the roster.** `multiaiAgentRemove` and
`multiaiLibraryRemove` delete with no `confirm()` and no undo, while
`multiaiDeleteChat` — strictly less costly — does confirm. The library half
survives inside `P-R2-21`, but only for its REST-contract consequence; the roster
✕ was dropped entirely, and it is the one users hit more often. One mis-click
destroys a seat's provider, model, effort, tools level and persona. Not blocking.
Fold into `P-R2-7`, which is already rebuilding that row's action cell. **Cost: S.**

---

## Verified sound

Reviewers looked for problems here and found none. Recorded so they are not
re-litigated.

- **Loopback binding and API-key gating** — `listen(REST_PORT, '127.0.0.1')` and `validateApiKey(req)` both run **before** the `_routeExtensions` loop, so the new REST surface inherits the same auth as the rest of the gateway.
- **REST error envelope** — the new routes produce the same `{error:{message,type,code}, timestamp}` shape as every pre-existing one.
- **Store integrity** — atomic write, backup rotation, corruption parking; `mergeStores` is a union keyed on `id` with a stable sort and tombstones, so a renderer snapshot saved mid-run cannot clobber main's appends or resurrect a deleted chat.
- **`resolveInRoot`** — correct `path.resolve` + `startsWith(root + sep)`, rejects the root itself for `delete`. The Orchestrated file-tools escape hatch is closed.
- **Packaging** — `asarUnpack` lists exactly the three files `variants-server.js` requires by literal path, and `multiai-core.cjs` has zero Electron requires, so the standalone `proxima-variants-mcp` genuinely works from inside the packaged app.
- **Prior decision #2 ("newest Codex wins")** — verified working: `resolveCodex({force:true})` picks bundle `0.152.1` over PATH `0.142.5` on this machine.
- **`rounds` clamping** — always clamped server-side to 1..30 regardless of REST/MCP input, including NaN and negatives.
- **HTML escaping** — `multiaiEscape` is `textContent`-based and `multiaiEscapeAttr` is only used inside double-quoted attributes; all user-controlled strings pass through one of them. No injection path found.
- **IPC listener hygiene** — `removeAllListeners` before `on` for all seven channels; `emit()` guards `isDestroyed()`.
- **`startSignal`** — genuinely prevents two runs on one chat, honoured by all three entry points.
- **Queued-turn Stop** — correct: the slot is released and no process is spawned.
- **App-not-running path** for the MCP tools — clear error, no crash or hang.
