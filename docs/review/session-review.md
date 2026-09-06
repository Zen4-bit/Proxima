# Review · 0017938..HEAD

## Claude · sonnet (sonnet)

Confirmed. Now writing the review.

**DEFECTS**

`electron/providers/cli.cjs:970-997` — `runAntigravity` creates a scratch dir (`const dir = scratchDir(cwd)`, line 971, which `mkdtempSync`s a new folder under `os.tmpdir()/multiai-cli` and writes `mcp_empty.json` into it) but never calls `removeScratch(dir)`. `runClaude` (line 860), `runCodex` (line 909) and `runGemini` (line 1034) all clean up with `promise.finally(() => removeScratch(dir))`; `runAntigravity` has no such call anywhere, including on the early-reject path when the prompt exceeds `AGY_PROMPT_MAX` (line 974-979), where `dir` is created and immediately abandoned without even being used. Every Antigravity turn — a `none`-tools discussion seat, since workspace seats use `workspace.root` as `cwd` and never touch `dir` — leaks one directory into the OS temp folder permanently. `scripts/review-panel.mjs`'s own worked example runs `panel.length * ROUNDS` turns per invocation (line 168), so a handful of review-panel runs is enough to litter `%TEMP%\multiai-cli` with orphaned `run-*` folders that nothing ever prunes.

**DESIGN**

`electron/ipc/multiai-core.cjs:51-58` — `independentMode()`'s migration only preserves the old `true` case: `chat.independentFirstRound ? 'first' : DEFAULTS.independentRounds`. A chat saved before this feature existed with `independentFirstRound` `false` or absent — i.e. every chat that ran the old (documented) default of round-robin — is silently promoted to `independentRounds: 'all'` the first time it's opened, not just `'first'`. Given the same commit's own admission that blind rounds break in-round `HANDOFF →` in charter mode (`docs/MULTIAI.md`'s new "cost is in charter mode" paragraph), an existing charter-mode chat that relied on sequential turn order gets its handoff semantics changed on upgrade with no prompt, no changelog entry the user reads before it happens, and no way to tell after the fact that the value was defaulted rather than chosen — `chat.independentRounds` is presumably written back as `'all'` on next save, at which point the distinction between "user chose this" and "silently defaulted" is gone for good.

## Codex (gpt-6-astra)

DEFECTS

- scripts/review-panel.mjs:196 — `--paths` reviews different files from those supplied to the panel. Modify a tracked file without committing, then run `--paths "that/file" --go`. The brief uses `git diff -- that/file`, but the review workspace is created at HEAD without those modifications. Reviewers opening the file see the old implementation; anything beyond the truncated diff cannot be reviewed correctly. The workspace must contain the same snapshot used to generate the brief.

- scripts/review-panel.mjs:233–237 — Failed participants disappear from the exported review, and even complete failure exits successfully. Run with installed CLIs whose turns fail authentication or exhaust their quota. The backend records `role: 'error'`; this script retains only `assistant`, prints “Done: 0 replies,” and writes a heading-only report with exit code 0. Partial failure similarly produces a report with no indication that a reviewer never answered. Preserve failure and PASS outcomes, report panel coverage, and distinguish an unsuccessful run from a completed review.

- electron/multiai-renderer.js:2109–2115 — Selecting “custom…” loses custom-entry mode on a newly added, automatically named CLI seat. Add Claude, switch to Claude Code, leave its generated name and model, then select “custom…”. The flag is stored under the current agent ID; clearing the model subsequently changes the generated name and resets that ID at line 2153. Rendering looks up the flag under the new ID at line 2236 and displays the dropdown again. The first click also clears the configured model. Use a stable row identity for this state.

- scripts/review-panel.mjs:228–231 — A polling failure removes the workspace while the review can still be running. Start a sufficiently long review, then have one `/wait` request fail or its connection reset while the server and CLI processes remain alive. The `finally` block immediately force-removes the worktree; it never stops the detached `wait:false` run or waits for its processes to finish. Remaining file reads fail against a directory the script just deleted. Stop and await the run before cleanup, or retain the workspace when its state is unknown.

DESIGN

- scripts/review-panel.mjs:210,231 — The script persists a normal, reusable chat pointing to a workspace it deletes when the review finishes. Open that chat afterward and ask the panel to verify a finding: its configured folder no longer exists. Retaining the transcript is useful, but the chat needs an explicit completed-snapshot lifecycle or a way to recreate the reviewed revision before accepting follow-up turns.

MISSING

- tests/electron/multiai-roster.test.js:305–315 — The custom-picker regression test supplies the fixed name `A`, bypassing the automatic renaming that breaks newly added seats. Cover selecting “custom…” on an unsaved seat with its generated name and nonempty model.

- scripts/review-panel.mjs — Tests for workspace/diff consistency, failed-participant reporting, and cleanup after a polling error. These can use stubbed CLI discovery and REST responses without spending model turns.

## Claude · opus (opus)

**DEFECTS**

**1. `electron/providers/cli.cjs:982` — Antigravity is the first runner to put free text in argv, and the Windows shim path refuses free text.**
`runAntigravity` builds `[`-p=${full}`]` where `full` is system prompt + user prompt. `spawnCli` (line 727) routes any `.cmd`/`.bat` resolution through `cmd.exe /d /s /c` + `cmdCommandLine`, and `cmdCommandLine:715` throws outright on any argument containing `"`:

```js
if (String(a).includes('"')) throw new Error('cannot pass a double quote to a Windows CLI shim');
```

Its own comment justifies that as safe because "the validated model/effort fields cannot [contain a quote]" — true for every other runner. `runClaude:833` deliberately writes the system prompt to `system.txt` and passes the user prompt on stdin; `runGemini:1009` puts the prompt on stdin. Antigravity does neither.

Reproduce: `agy` resolving to `agy.cmd` (npm install — `preferExecutable:219` picks the `.cmd` over the extensionless shim, and `knownLocations:195` has no `agy` entry so this is entirely PATH-dependent), any seat, any prompt containing a `"`. The review brief this very script generates contains dozens (`'not yet a defect.'`, every quoted identifier in a diff). The throw is synchronous inside `spawnCli`, so it isn't even the seat's rejected promise — `runProcess` may surface it as a spawn failure with a message about double quotes that means nothing to the user.

Same path, second failure: `cmd.exe` caps its command line at 8191 characters. `AGY_PROMPT_MAX = 28000` (line 43, "measured: 30k runs, 60k is ENAMETOOLONG") was measured on an install where `agy` resolves to a real executable. On a `.cmd` install the true ceiling is ~8k and the guard passes 27,999-character prompts straight into a failure the guard exists to prevent. The constant is presented as a property of Windows; it is a property of how `which('agy')` happened to resolve.

**2. `electron/providers/cli.cjs:971` — every Antigravity turn leaks a scratch directory.**
`const dir = scratchDir(cwd)` calls `fs.mkdtempSync` (line 667). `runClaude:860`, `runCodex:909` and `runGemini:1034` all end with `promise.finally(() => removeScratch(dir)).catch(() => {})`. `runAntigravity` has no such line — it returns at 997 with the directory still on disk. Worse, `dir` is created unconditionally and only *used* when `level === 'none'`, so a workspace-attached Antigravity seat creates and abandons a directory it never even writes to. A 4-round panel with one Antigravity seat leaves 4 directories under `%TEMP%\multiai-cli\`; nothing ever prunes them.

**3. `scripts/review-panel.mjs:196` — a read-only run cuts a branch and never removes it.**
```js
git('worktree', 'add', '-b', `proxima-review-${Date.now()}`, temporary, 'HEAD');
```
The `finally` at line 231 runs `git worktree remove --force`, which deletes the worktree and leaves the branch. `git branch` grows by one `proxima-review-<epoch>` on every `--go`. Given commit `1ef33bd` is titled "A read-only run does not cut a branch", this is the fix reintroducing the thing it names — the branch moved from `multiai/*` to `proxima-review-*`, it did not stop being cut. The cleanup needs `git branch -D` after the removal, or `--detach` plus a fix to whatever in `workspace.prepare()` mishandles detached HEAD (the comment at 191-195 says detached HEAD is why the branch is there, so the real bug is in `prepare`).

**4. `scripts/review-panel.mjs:59` — `--paths` reviews unstaged changes only, and an empty brief still spends the full run.**
`target()` returns `args: ['--', ...globs]`, so `git diff -- <globs>` at lines 65 and 68 is worktree-vs-index. Stage the change you want reviewed and the diff is empty. Nothing checks: `brief()` happily emits `Files:\n` with an empty stat and an empty ` ```diff ` block, the plan prints "That is 8 turns on your subscriptions", and `--go` runs all eight against nothing. The `--base` path uses `BASE...HEAD` (committed only, no worktree at all), so one script silently means two different things by "the change" depending on which flag you passed — and the doc's "builds a review brief from the working tree" is true of neither. A `if (!diff.trim()) throw` before the panel is built is the minimum.

**5. `electron/multiai-renderer.js:1422` vs `electron/ipc/multiai-core.cjs:57` — the same legacy boolean maps two opposite ways.**
```js
// renderer 1421-1423
if (setup.independentRounds === undefined && setup.independentFirstRound !== undefined) {
    chat.independentRounds = setup.independentFirstRound ? 'first' : 'off';
}
// core 57
return chat && chat.independentFirstRound ? 'first' : DEFAULTS.independentRounds;  // 'all'
```
`false` → `'off'` through a setup, `false` → `'all'` through a chat. `docs/MULTIAI.md:221` documents only the second (`true` → `first`; everything else takes the new default). Reproduce: save a setup in the previous build (where `independentFirstRound: false` was the untouched default, so essentially every saved setup carries it), upgrade, apply that setup — you get strict turn-taking, while opening any chat from the same era gives you `all`. The user never asked for `off`; `false` meant "never touched this".

**6. `electron/ipc/multiai.cjs:917` — the note is wrong for `first`.**
```js
if (directed && indMode !== 'off' && order.length > 1)
    note(chatId, 'Round 1 takes turns so that order means something; independent rounds resume after it.');
```
With `indMode === 'first'`, round 1 was the *only* blind round, and line 937's `!(directed && r === 1)` has just cancelled it. Nothing resumes after round 1 — the setting is fully nullified for this Send. Reproduce: Independent = `first round only`, send `@claude kick off, others react`, rounds ≥ 2. Every round takes turns, and the transcript says otherwise.

**7. `scripts/review-panel.mjs:228-232` — the worktree is removed out from under a run that is still going.**
The `finally` fires on any throw from the polling loop, including a transient failure of `POST /wait` at line 221. That request failing does not stop the run inside Proxima — `wait:false` at 219 explicitly decoupled them, per the comment at 216-218. So one bad poll deletes the directory that four CLI seats are mid-turn reading. They then report file-not-found findings about a repo that no longer exists.

**DESIGN**

`electron/ipc/multiai.cjs:944` — `results.map(x => x && x.handoff).filter(Boolean).pop()` picks which `HANDOFF →` wins by position in `turnOrder`. In a blind round every seat writes its handoff without seeing the others', so conflicting handoffs are normal, not exceptional — and the tiebreak is roster index, announced nowhere. The run then opens the next round with a seat chosen by an accident of ordering. Either note the conflict ("three seats handed off; taking X's") or take the first, but do not resolve a genuine disagreement silently.

`electron/multiai-renderer.js:1398` — `MULTIAI_SETUP_FIELDS` lists both `independentRounds` and `independentFirstRound`, and line 1420 copies whichever the setup defines onto the chat. Meanwhile `multiaiReadClassicFields:2899` does `delete chat.independentFirstRound` precisely to stop the two drifting. So the UI removes the legacy key and applying a setup puts it back. Cost: `independentMode()` prefers `independentRounds` so it looks harmless today, but the chat object now carries two fields that disagree, and the next reader that checks the boolean first — the REST handler at `multiai.cjs:1420` already accepts it as a first-class field — gets the stale answer. Drop `independentFirstRound` from the settable field list; read it only in the one migration function.

`electron/providers/cli.cjs:961-967` — `tools: 'none'` does not mean the same thing for Antigravity as for the others. `claudeArgs:818-819` passes `--strict-mcp-config --mcp-config <empty>` and `--disallowedTools '*'`, and the comment at 661-663 explains why the empty MCP config has to be per-run and isolated. `antigravityArgs` for `none` passes only `--mode plan` — no MCP isolation, no tool denial, and no `--add-dir`, so the seat runs in plan mode with the user's global agent configuration loaded. A user reading the Tools column sees one control with one meaning; it has two.

`electron/multiai-renderer.js:1030-1035` — the roster block comment still states "every new chat starts with the whole library switched on", which `multiaiApplyDefaultSetup:1534` (and its own comment at 1530-1533) now contradicts directly. That comment is the first thing anyone touching this code reads.

`electron/providers/cli.cjs:559` — `out.antigravity.efforts: []` while every per-model entry carries its own `efforts`. `multiaiCliEfforts:1233-1235` looks up `models.find(x => x.id === model)` first and falls back to `info.efforts`. A seat with a blank model (the "CLI's own default", which `review-panel.mjs:119` explicitly treats as always-correct) therefore gets `null` — no Effort control at all, on the one CLI the docs single out as having "a real `--effort` switch". Codex solves exactly this by aggregating per-model efforts into `efforts` at line 493-494; Antigravity skips it.

**MISSING**

`tests/electron/providers/antigravity.test.js` covers `parseAgyModels` and nothing else. There is no test for `antigravityArgs` (the `--effort` / suffixed-id conflict the whole design turns on), none for the `AGY_PROMPT_MAX` refusal, none for the JSON-envelope parse at 986-996, and none that a folded family id (`gemini-3.8-flash`, which `agy models` never printed) is an id `agy --model` actually accepts. That last one is the load-bearing assumption of the entire fold: if `agy` only accepts the suffixed ids it listed, every Antigravity seat fails at spawn and the test suite passes.

No test for `multiaiSetupInto`'s legacy branch. `tests/electron/ipc/multiai-core.test.js:345-349` and `multiai-handlers.test.js:1070` cover `independentMode`'s migration in both directions; `multiai-renderer.js:1422`, which implements the opposite rule for the same input, has none — which is why the two disagree.

`scripts/review-panel.mjs` has no test at all, and it is not a throwaway: it is the thing that produced this review. The three cheap ones are the empty-diff guard, `flag()` returning the next flag when a value is omitted (`--rounds --go` → `ROUNDS = NaN`, and `panel.length * NaN` prints "That is NaN turns on your subscriptions" in the confirmation the whole `--go` gate exists to make meaningful), and the branch/worktree cleanup being complete.

Nothing handles a `defaultSetupId` pointing at a deleted setup: `multiaiApplyDefaultSetup:1538` returns silently, the menu at 1713-1716 shows no pinned name, and the user gets an empty chat with no explanation of why their pin stopped working. Either clear the pin when the setup is deleted, or say so.

## Codex (gpt-6-astra)

DEFECTS

- electron/providers/cli.cjs:986–995 — Antigravity can report a failed process as a successful answer. I reproduced this in memory using the actual runAntigravity function with a stubbed process result: `{code: 1, stdout: 'Starting session...\n', stderr: 'Authentication failed'}` resolves to `{text: 'Starting session...', model: null}`. Nonempty stdout bypasses failure detection unless it parses as JSON with an explicit failing status. The transcript records the startup message as an assistant answer, discards the authentication error, and resets the seat’s consecutive-failure counter. Check the exit status and validate the response envelope.

- scripts/review-panel.mjs:201–215 — There is another cleanup failure before the polling case already reported: chat creation is outside the try/finally. Let the initial GET succeed, then return HTTP 500 from POST /v1/multiai/chats. The worktree has already been created at line 196, but execution never reaches the cleanup scope. Both the checkout and its registered worktree remain. Cleanup must cover every operation after successful worktree creation.

DESIGN

- electron/ipc/multiai.cjs:919–945 — The handoff issue is more fundamental than choosing the last handoff. With `independentRounds: 'all'`, two enabled participants and two rounds, a round-one handoff merely rearranges the array passed to round two’s Promise.all. Both participants still receive blind prompts and run concurrently; the recipient does not speak before the other participant reacts. The note promising that a handoff “applies to the next round” describes no meaningful speaking-order behavior.

- Regarding Opus’s branch-cleanup recommendation: no workspace.prepare fix is needed to use a detached review worktree here. electron/ipc/multiai.cjs:794–801 already returns before calling prepare when every seat is read-only, and scripts/review-panel.mjs:130 creates only read seats. The script’s detached-HEAD justification is obsolete in this very revision; `worktree add --detach … HEAD` can preserve the intended commit without creating the leftover branch.

## Claude · sonnet (sonnet)

Confirmed — good enough to write up. Now composing the contribution.

**DEFECTS**

`scripts/review-panel.mjs:126-137` — `seats()` gates the Antigravity seat behind `d.antigravity.loggedIn` (and Gemini, when it's added by hand, would need `d.gemini.loggedIn` too — `cli.cjs:540`), but for Claude and Codex it only checks `d.claude.available` / `d.codex.available`. Look at what `available` means for those two in `electron/providers/cli.cjs:463-516`: it is set the moment the binary resolves on PATH (`avail.claude`/`avail.codex` from `warmAvailability()`), before anything checks whether the user is signed in — neither `out.claude` nor `out.codex` ever gets a `loggedIn` field, unlike `out.gemini:540` and `out.antigravity:562` which explicitly compute one (`!!auth`, `models.length > 0`). So a machine with `claude`/`codex` installed but logged out — a fresh checkout, a CI box, a session where the subscription expired — passes `seats()`'s check, gets added to the panel, printed in the plan as a real seat, and counted in "That is N turns on your subscriptions" (line 168). `--go` then spends a real run on it: `runCodex` fails with whatever `codex exec` prints to stderr wrapped as `Codex: <why>` (`cli.cjs:903`), and by the two-strikes rule in `multiai.cjs:893-895` the seat gets benched mid-run with a note, after already occupying a chat slot and a round. The plan-only preview — the thing `--go` exists to let you check before spending anything — cannot tell you this seat is dead, because the script trusts `available` from providers that don't distinguish "installed" from "authenticated," while trusting `loggedIn` from the ones that do. Either probe auth for Claude/Codex the same way `discover()` does for Gemini/Antigravity before counting them as a seat, or drop the "on your subscriptions" claim in the printed plan down to something that admits it hasn't checked.
