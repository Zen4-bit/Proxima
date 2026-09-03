// Proxima — Multi-AI Chat IPC Handlers (main process).
// A native "Multi-AI Chat" surface on top of the same browser-session
// providers Proxima already drives, with two logic modes:
//   - Classic: discuss/debate with personas, stop-token convergence, an
//     optional independent (parallel, blind) first round, directed turns via
//     @mentions, a judge and a pinned state summary.
//   - Orchestrated: role-based crew / sequential workflow / iterate-loop /
//     file-tools agent, calling sendMessageToProvider in-process.
//
// Ownership rules (see multiai-core.cjs):
//   - The main process owns persistence of every message it produces (runs,
//     judge, summary, REST appends) via store.appendMessage(), and notifies
//     the renderer with 'multiai-message'. The renderer keeps saving whole
//     snapshots for settings/UI edits; store.saveSnapshot() merges, so the two
//     never clobber each other. Deletions are explicit ('multiai-delete-chat').
//   - Each Multi-AI chat gets its own provider-side thread per provider
//     (session id multiai:<chatId>:<generation>), rotated every
//     DEFAULTS.providerResetEvery turns so provider threads stay bounded.
//     Prompts are self-sufficient (bounded context built from the store), so
//     a rotation never loses context.
//   - Local agents (Codex, Claude Code, scripts) read and append through the
//     REST API: GET/POST /v1/multiai/chats[...] on the existing gateway port.

const { ipcMain, app, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const sender = require('../providers/sender.cjs');
const core = require('./multiai-core.cjs');

function dataDir() {
    const dir = path.join(app.getPath('userData'), 'multiai');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function personasDir() {
    const dir = path.join(dataDir(), 'personas');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function listPersonas() {
    const dir = personasDir();
    const out = {};
    for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.md') || f.endsWith('.txt')) {
            try {
                out[f.replace(/\.(md|txt)$/, '')] = fs.readFileSync(path.join(dir, f), 'utf-8');
            } catch { /* skip unreadable file */ }
        }
    }
    return out;
}

function registerMultiAiHandlers(deps) {
    const { mainWindow, loadSettings, registerRouteExtension } = deps;
    const store = core.createStore({ dir: dataDir(), fs, path, log: (m) => console.log(m) });

    // ---- window / events ---------------------------------------------
    function win() {
        const w = typeof mainWindow === 'function' ? mainWindow() : mainWindow;
        return (w && !w.isDestroyed()) ? w : null;
    }

    function emit(channel, payload) {
        const w = win();
        if (w) w.webContents.send(channel, payload);
    }

    function enabledProviders() {
        const settings = loadSettings();
        return Object.keys(settings.providers || {}).filter(p => settings.providers[p]?.enabled);
    }

    // Persist + notify. Every message the main process produces goes through
    // here so the store and the renderer stay in step.
    function record(chatId, message) {
        const saved = store.appendMessage(chatId, message);
        if (saved) emit('multiai-message', { chatId, message: saved });
        return saved;
    }

    function note(chatId, text, extra) {
        return record(chatId, Object.assign({ who: 'System', role: 'system', text, ts: Date.now() }, extra || {}));
    }

    // ---- cancellation / run guard -----------------------------------
    // One signal per running chat. A second run on a chat that's already
    // running is refused (the UI can't express two concurrent runs in one
    // transcript, and it used to double-post). Stop resolves the signal, so
    // whatever provider call is in flight is abandoned immediately — the
    // browser request itself isn't cancellable at the provider layer, so its
    // eventual result is discarded rather than shown.
    const runSignals = new Map(); // chatId -> { cancelled, resolve, promise }

    function startSignal(chatId) {
        if (runSignals.has(chatId)) throw new Error('A run is already in progress for this chat.');
        let resolveFn;
        const promise = new Promise((res) => { resolveFn = res; });
        const sig = { cancelled: false, resolve: resolveFn, promise };
        runSignals.set(chatId, sig);
        return sig;
    }

    function endSignal(chatId) {
        runSignals.delete(chatId);
    }

    function isRunning(chatId) {
        return runSignals.has(chatId);
    }

    async function raceProvider(chatId, providerPromise) {
        const sig = runSignals.get(chatId);
        const settled = providerPromise.then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error })
        );
        if (!sig) return settled;
        return Promise.race([
            settled,
            sig.promise.then(() => ({ cancelled: true })),
        ]);
    }

    // ---- provider sessions ---------------------------------------------
    // Per chat, per provider: a generation counter and a turn counter. The
    // session id embeds the generation; bumping it starts a fresh provider
    // thread without touching the engine's live state (which a mid-flight
    // reset for another chat could corrupt).
    function providerString(chat, provider) {
        const base = String(provider).split(':')[0];
        const engine = chat.engines && chat.engines[base];
        return engine || base;
    }

    function sessionState(chat, base) {
        const all = chat.providerSessions || {};
        return all[base] || { gen: 1, turns: 0, lastId: null };
    }

    function contextModeOf(chat) {
        return core.CONTEXT_MODES.includes(chat.contextMode) ? chat.contextMode : core.DEFAULTS.contextMode;
    }

    function resetEveryFor(chat) {
        return contextModeOf(chat) === 'delta' ? core.DEFAULTS.providerResetEveryDelta : core.DEFAULTS.providerResetEvery;
    }

    function sessionIdFor(chat, st) {
        return `${core.sessionFor(chat.id)}:${st.gen}`;
    }

    // The thread state a turn will use: rotates to a fresh generation when the
    // turn bound is hit. Delta mode needs to know this BEFORE building the
    // prompt (a fresh thread gets a full catch-up instead of a delta).
    function nextSessionState(chat, base) {
        const st = sessionState(chat, base);
        if (st.turns >= resetEveryFor(chat)) return { gen: st.gen + 1, turns: 0, lastId: null, rotated: true };
        return Object.assign({}, st, { rotated: false });
    }

    // Sends one turn on the chat's thread for that provider, then advances the
    // turn counter. `st` comes from nextSessionState(); `lastId` (delta mode)
    // is the anchor to remember on success — the last message this provider
    // has now seen. A cancelled call leaves the anchor alone so the next turn
    // re-sends what the provider may or may not have read.
    async function sendOnChatThread(chat, provider, prompt, st, lastId) {
        const base = String(provider).split(':')[0];
        if (!st) st = nextSessionState(chat, base);
        const sessionId = sessionIdFor(chat, st);
        const result = await raceProvider(chat.id, sender.sendMessageToProvider(providerString(chat, provider), prompt, null, null, sessionId));
        let next = null;
        if (result.ok || result.cancelled) {
            next = { gen: st.gen, turns: st.turns + 1, lastId: result.ok ? (lastId !== undefined ? lastId : (st.lastId || null)) : (st.lastId || null) };
        } else if (contextModeOf(chat) === 'delta') {
            // Delta mode leans on the provider thread's memory, and some engines
            // (Gemini) wipe the thread on any failure. We can't see that from
            // here, so after an error start a new generation: the next turn is
            // a full catch-up instead of a delta into an amnesiac thread.
            next = { gen: st.gen + 1, turns: 0, lastId: null };
        }
        if (next) {
            chat.providerSessions = Object.assign({}, chat.providerSessions || {}, { [base]: next });
            store.updateChat(chat.id, (c) => { c.providerSessions = Object.assign({}, c.providerSessions || {}, { [base]: next }); });
        }
        return result;
    }

    // One-off calls (judge, summary, title) use a per-chat auxiliary thread,
    // separate from the chat's own thread so they never pollute it. Their
    // prompts are self-contained, so the thread is rotated every few uses to
    // keep it bounded without opening a new provider conversation every time.
    const AUX_RESET_EVERY = 5;
    async function sendAux(chat, provider, prompt) {
        const base = String(provider).split(':')[0];
        const key = `aux:${base}`;
        let st = (chat.providerSessions && chat.providerSessions[key]) || { gen: 1, turns: 0 };
        if (st.turns >= AUX_RESET_EVERY) st = { gen: st.gen + 1, turns: 0 };
        const sessionId = `${core.auxSessionFor(chat.id)}:${st.gen}`;
        const result = await sender.sendMessageToProvider(providerString(chat, provider), prompt, null, null, sessionId);
        const next = { gen: st.gen, turns: st.turns + 1 };
        if (store.getChat(chat.id)) store.updateChat(chat.id, (c) => { c.providerSessions = Object.assign({}, c.providerSessions || {}, { [key]: next }); });
        return result;
    }

    function contextOpts(chat) {
        const o = {};
        if (chat.contextWindow != null && chat.contextWindow !== '') o.contextWindow = Math.max(0, parseInt(chat.contextWindow, 10) || 0);
        return o;
    }

    // ---- persistence IPC ------------------------------------------------

    ipcMain.handle('multiai-load', () => store.load());
    ipcMain.handle('multiai-save', (event, data) => { store.saveSnapshot(data); return { success: true }; });
    ipcMain.handle('multiai-delete-chat', (event, { chatId }) => ({ success: store.deleteChat(chatId) }));
    ipcMain.handle('multiai-list-personas', () => listPersonas());
    ipcMain.handle('multiai-open-personas-folder', () => {
        shell.openPath(personasDir());
        return { success: true };
    });
    ipcMain.handle('multiai-enabled-providers', () => enabledProviders());
    ipcMain.handle('multiai-running', () => Array.from(runSignals.keys()));

    ipcMain.handle('multiai-stop-run', (event, { chatId }) => {
        const sig = runSignals.get(chatId);
        if (sig) {
            sig.cancelled = true;
            sig.resolve();
        }
        return { success: true };
    });

    ipcMain.handle('multiai-export', async (event, { title, markdown }) => {
        const w = win();
        const safeName = (title || 'multiai-chat').replace(/[\\/:*?"<>|]/g, '_').trim() || 'multiai-chat';
        try {
            const result = await dialog.showSaveDialog(w || undefined, {
                title: 'Export Multi-AI Chat',
                defaultPath: path.join(app.getPath('documents'), `${safeName}.md`),
                filters: [{ name: 'Markdown', extensions: ['md'] }],
            });
            if (result.canceled || !result.filePath) return { success: false, canceled: true };
            fs.writeFileSync(result.filePath, markdown, 'utf-8');
            return { success: true, filePath: result.filePath };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // On-demand AI title (the interim title is local and free — see renderer).
    ipcMain.handle('multiai-generate-title', async (event, { chatId, provider, prompt }) => {
        try {
            const chat = store.getChat(chatId) || { id: chatId };
            const result = await sendAux(chat, provider, prompt);
            const title = core.cleanTitle(result.response);
            if (title && chat.id && store.getChat(chatId)) store.updateChat(chatId, { title });
            return { success: !!title, title };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ---- Classic mode: discuss / debate ---------------------------------

    function messagesOfRound(chat, cycle, round) {
        return (chat.messages || []).filter(m => (m.cycle || 1) === cycle && m.round === round);
    }

    async function takeTurn(chatId, provider, round, opts) {
        const chat = store.getChat(chatId);
        if (!chat) throw new Error('Chat not found');
        const base = String(provider).split(':')[0];
        const cycle = chat.cycle || 1;
        emit('multiai-thinking', { chatId, provider: base });
        const { brief, latest } = core.briefAndLatest(chat.messages, chat.topic);
        const st = nextSessionState(chat, base);
        const cmode = contextModeOf(chat);
        const built = core.buildClassicPromptWithMeta({
            chatTitle: chat.title,
            topic: brief,
            latestUserMessage: latest,
            mode: chat.discussMode,
            brevity: chat.brevity,
            persona: (chat.personas && chat.personas[base]) || null,
            participants: opts.participants,
            provider: base,
            messages: chat.messages,
            contextOpts: contextOpts(chat),
            stopToken: chat.stopToken || core.DEFAULTS.stopToken,
            independent: opts.independent ? { cycle } : null,
            contextMode: cmode,
            // A fresh/rotated thread has no memory: force the catch-up prompt.
            delta: { sinceId: (st.rotated || st.turns === 0) ? null : st.lastId, provider: base },
        });
        const raced = await sendOnChatThread(chat, provider, built.prompt, st, cmode === 'delta' ? built.meta.lastId : null);
        const label = core.providerLabel(base);
        if (raced.cancelled) {
            record(chatId, { who: `${label} (stopped)`, text: 'Stopped before this reply arrived.', provider: base, role: 'error', cycle, round });
            return { cancelled: true };
        }
        if (!raced.ok) {
            record(chatId, { who: `${label} error`, text: raced.error.message, provider: base, role: 'error', cycle, round });
            return { error: raced.error.message };
        }
        const text = raced.value.response || '';
        if (core.isPass(text)) {
            record(chatId, { who: label, text: 'PASS', provider: base, role: 'pass', cycle, round });
            return { pass: true };
        }
        record(chatId, { who: label, text, provider: base, role: 'assistant', cycle, round });
        return { ok: true };
    }

    // Rolling summary (delta mode's "Topic block"): once more than
    // autoSummaryEvery readable messages have accumulated since the last
    // pinned summary, ask the judge provider (or the first participant) for a
    // fresh one. Runs between rounds so it never interrupts a turn.
    async function maybeAutoSummary(chatId, participants) {
        const chat = store.getChat(chatId);
        if (!chat) return;
        const every = parseInt(chat.autoSummaryEvery, 10) || 0;
        if (every <= 0) return;
        if (core.messagesSinceSummary(chat.messages).length < every) return;
        const provider = chat.judgeProvider || participants[0];
        if (!provider) return;
        const base = String(provider).split(':')[0];
        emit('multiai-thinking', { chatId, provider: base });
        const { brief } = core.briefAndLatest(chat.messages, chat.topic);
        try {
            const result = await sendAux(chat, provider, core.buildSummaryPrompt({ topic: brief, messages: chat.messages }));
            record(chatId, { who: `State summary · ${core.providerLabel(base)} (auto)`, text: result.response, provider: base, role: 'summary', cycle: chat.cycle || 1, round: 0 });
        } catch (e) {
            note(chatId, `Auto-summary failed: ${e.message}`);
        }
    }

    // Runs `rounds` rounds on a chat using its stored settings. `latestText`
    // is the human message that triggered this cycle (already recorded by the
    // caller) — used only for @mention parsing.
    async function runClassic({ chatId, rounds, latestText }) {
        const chat0 = store.getChat(chatId);
        if (!chat0) throw new Error('Chat not found');
        const sig = startSignal(chatId);
        const produced = [];
        try {
            const enabled = enabledProviders();
            let participants = (chat0.participants || []).filter(p => enabled.includes(String(p).split(':')[0]));
            if (!participants.length) participants = (chat0.participants || []).slice();
            if (!participants.length) throw new Error('No participants selected.');
            const mentions = core.parseMentions(latestText || '', participants);
            const order = mentions.order;
            if (mentions.mentioned.length) {
                note(chatId, `Directed turn: ${mentions.only ? 'only ' : ''}${mentions.mentioned.map(core.providerLabel).join(', ')}${mentions.only ? '' : ' first'}.`);
            }
            const n = Math.max(1, Math.min(30, rounds || chat0.rounds || 1));
            const token = chat0.stopToken || core.DEFAULTS.stopToken;
            const cycle = chat0.cycle || 1;
            const stopEarly = chat0.stopWhenAllAgree !== false;
            // A provider that fails twice in a row (Perplexity's HTTP 500s,
            // a logged-out tab) is benched for the rest of this run rather
            // than burning a slot — and an error message — every round.
            const failures = {};
            const benched = new Set();
            const noteFailure = (provider, res) => {
                const base = String(provider).split(':')[0];
                if (res && res.error) {
                    failures[base] = (failures[base] || 0) + 1;
                    if (failures[base] >= 2 && !benched.has(base)) {
                        benched.add(base);
                        note(chatId, `${core.providerLabel(base)} failed twice in a row — skipping it for the rest of this run.`);
                    }
                } else if (res && (res.ok || res.pass)) {
                    failures[base] = 0;
                }
            };
            const active = () => order.filter(p => !benched.has(String(p).split(':')[0]));

            outer:
            for (let r = 1; r <= n; r++) {
                if (sig.cancelled) break;
                emit('multiai-round-start', { chatId, round: r, of: n });
                const turnOrder = active();
                if (!turnOrder.length) { note(chatId, 'No participants left to take a turn.'); break; }
                const independent = r === 1 && !!chat0.independentFirstRound && turnOrder.length > 1;
                if (independent) {
                    const results = await Promise.all(turnOrder.map(p => takeTurn(chatId, p, r, { participants: order, independent: true })
                        .catch(e => ({ error: e.message }))));
                    results.forEach((res, i) => noteFailure(turnOrder[i], res));
                    if (results.some(x => x && x.cancelled) || sig.cancelled) break outer;
                } else {
                    for (const provider of turnOrder) {
                        if (sig.cancelled) break outer;
                        const res = await takeTurn(chatId, provider, r, { participants: order }).catch(e => ({ error: e.message }));
                        noteFailure(provider, res);
                        if (res && res.cancelled) break outer;
                    }
                }
                const after = store.getChat(chatId);
                const outcome = core.roundOutcome(messagesOfRound(after, cycle, r), token);
                if (stopEarly && outcome.converged) {
                    note(chatId, `Converged after round ${r}: every participant said ${token} or passed.`);
                    break;
                }
                if (stopEarly && outcome.allPassed) {
                    note(chatId, `Everyone passed in round ${r} — nothing new to add.`);
                    break;
                }
                if (!sig.cancelled) await maybeAutoSummary(chatId, order);
            }
            if (sig.cancelled) note(chatId, 'Run stopped.');
        } finally {
            endSignal(chatId);
            emit('multiai-done', { chatId });
        }
        const final = store.getChat(chatId);
        return (final && final.messages || []).filter(m => (m.cycle || 1) === (chat0.cycle || 1) && m.round > 0);
    }

    ipcMain.handle('multiai-run-round', async (event, opts) => {
        try {
            const messages = await runClassic(opts);
            return { success: true, messages };
        } catch (e) {
            emit('multiai-done', { chatId: opts.chatId });
            return { success: false, error: e.message };
        }
    });

    function scopedMessages(chat, scope) {
        const msgs = chat.messages || [];
        if (scope === 'cycle') {
            const c = chat.cycle || Math.max(1, ...msgs.map(m => m.cycle || 1));
            return msgs.filter(m => (m.cycle || 1) === c);
        }
        if (scope === 'round' || scope === 'last') {
            const c = chat.cycle || Math.max(1, ...msgs.map(m => m.cycle || 1));
            const inCycle = msgs.filter(m => (m.cycle || 1) === c);
            const maxRound = inCycle.reduce((mx, m) => Math.max(mx, m.round || 0), 0);
            return inCycle.filter(m => m.role === 'user' || m.round === maxRound);
        }
        return msgs;
    }

    ipcMain.handle('multiai-judge', async (event, { chatId, judgeProvider, scope }) => {
        const chat = store.getChat(chatId);
        if (!chat) return { success: false, error: 'Chat not found' };
        const base = String(judgeProvider).split(':')[0];
        emit('multiai-thinking', { chatId, provider: base });
        const { brief } = core.briefAndLatest(chat.messages, chat.topic);
        const prompt = core.buildJudgePrompt({ topic: brief, messages: scopedMessages(chat, scope || chat.judgeScope || 'all') });
        try {
            const result = await sendAux(chat, judgeProvider, prompt);
            const msg = record(chatId, { who: `Judge · ${core.providerLabel(base)}`, text: result.response, provider: base, role: 'judge', cycle: chat.cycle || 1, round: 0 });
            emit('multiai-done', { chatId });
            return { success: true, message: msg };
        } catch (e) {
            record(chatId, { who: 'Judge error', text: e.message, provider: base, role: 'error', cycle: chat.cycle || 1, round: 0 });
            emit('multiai-done', { chatId });
            return { success: false, error: e.message };
        }
    });

    // Pinned state summary: becomes the compaction point for every later prompt.
    ipcMain.handle('multiai-summarize', async (event, { chatId, provider }) => {
        const chat = store.getChat(chatId);
        if (!chat) return { success: false, error: 'Chat not found' };
        const base = String(provider).split(':')[0];
        emit('multiai-thinking', { chatId, provider: base });
        const { brief } = core.briefAndLatest(chat.messages, chat.topic);
        const prompt = core.buildSummaryPrompt({ topic: brief, messages: chat.messages });
        try {
            const result = await sendAux(chat, provider, prompt);
            const msg = record(chatId, { who: `State summary · ${core.providerLabel(base)}`, text: result.response, provider: base, role: 'summary', cycle: chat.cycle || 1, round: 0 });
            emit('multiai-done', { chatId });
            return { success: true, message: msg };
        } catch (e) {
            record(chatId, { who: 'Summary error', text: e.message, provider: base, role: 'error', cycle: chat.cycle || 1, round: 0 });
            emit('multiai-done', { chatId });
            return { success: false, error: e.message };
        }
    });

    // ---- Orchestrated mode: crew / workflow / loop / agent -----------------
    // Same shapes as the MCP server's run_workflow/crew/run_loop tools, but
    // in-process. Every step is recorded as a message so the transcript and
    // ledger carry the full trail, whichever chat is on screen.

    async function chat(chatId, provider, prompt) {
        const c = store.getChat(chatId);
        if (!c) throw new Error('Chat not found');
        const raced = await sendOnChatThread(c, provider, prompt);
        if (raced.cancelled) {
            const err = new Error('Stopped before this reply arrived.');
            err.wasCancelled = true;
            throw err;
        }
        if (!raced.ok) throw raced.error;
        return raced.value.response;
    }

    // Prior conversation, bounded, for follow-up cycles in Orchestrated chats.
    function priorContext(chatId) {
        const c = store.getChat(chatId);
        const prior = (c && c.messages || []).filter(m => m.role !== 'user' || (c.cycle || 1) !== (m.cycle || 1));
        if (!core.readable(prior).length) return '';
        return `\n\nPRIOR CONVERSATION IN THIS CHAT (for context):\n${core.buildContext(prior, contextOpts(c)).text}`;
    }

    function stepMessage(chatId, { who, provider, text, role, round }) {
        const c = store.getChat(chatId);
        return record(chatId, { who, provider, text, role: role || 'assistant', cycle: (c && c.cycle) || 1, round: round || 0 });
    }

    async function runCrew({ chatId, task, agents }) {
        const list = agents && agents.length ? agents : [
            { role: 'Researcher', provider: 'perplexity', instruction: 'Research the topic thoroughly with facts and citations.' },
            { role: 'Writer', provider: 'claude', instruction: 'Write a detailed, well-structured response based on research.' },
            { role: 'Reviewer', provider: 'chatgpt', instruction: 'Review, improve and polish the output.' },
        ];
        const context = priorContext(chatId);
        let previousOutput = task;
        const steps = [];
        let idx = 0;
        for (const agent of list) {
            idx++;
            const sig = runSignals.get(chatId);
            if (sig && sig.cancelled) break;
            const who = `${agent.role} · ${core.providerLabel(agent.provider)}`;
            emit('multiai-orch-step', { chatId, status: 'running', role: agent.role, provider: agent.provider, label: who });
            const prompt = `You are a ${agent.role}. ${agent.instruction || ''}\n\nTASK: ${task}${idx === 1 ? context : ''}\n\n` +
                `${previousOutput !== task ? `PREVIOUS AGENT OUTPUT:\n${previousOutput}\n\n` : ''}` +
                `Provide your best work as a ${agent.role}.`;
            const startMs = Date.now();
            try {
                const output = await chat(chatId, agent.provider, prompt);
                previousOutput = output;
                steps.push({ role: agent.role, provider: agent.provider, output, elapsedMs: Date.now() - startMs, ok: true });
                stepMessage(chatId, { who, provider: agent.provider, text: output, round: idx });
            } catch (e) {
                if (e.wasCancelled) {
                    stepMessage(chatId, { who: `${who} (stopped)`, provider: agent.provider, text: 'Stopped before this step finished.', role: 'error', round: idx });
                    break;
                }
                steps.push({ role: agent.role, provider: agent.provider, error: e.message, elapsedMs: Date.now() - startMs, ok: false });
                stepMessage(chatId, { who: `${who} error`, provider: agent.provider, text: e.message, role: 'error', round: idx });
                // A failed role has nothing to hand on; stop rather than feed
                // the next role stale input as if it were this role's work.
                break;
            }
        }
        return { finalOutput: previousOutput, steps };
    }

    async function runWorkflow({ chatId, input, steps: stepDefs }) {
        let previousOutput = input || '';
        const fallback = enabledProviders()[0] || 'chatgpt';
        const context = priorContext(chatId);
        const steps = [];
        for (const [i, def] of stepDefs.entries()) {
            const sig = runSignals.get(chatId);
            if (sig && sig.cancelled) break;
            const provider = def.provider || fallback;
            const who = `Step ${i + 1} · ${core.providerLabel(provider)}`;
            emit('multiai-orch-step', { chatId, status: 'running', step: i + 1, task: def.task, provider, label: who });
            const prompt = `${def.task}${i === 0 ? context : ''}\n\n${previousOutput ? `Input from previous step:\n${previousOutput}` : ''}`;
            const startMs = Date.now();
            try {
                const output = await chat(chatId, provider, prompt);
                previousOutput = output;
                steps.push({ step: i + 1, task: def.task, provider, output, elapsedMs: Date.now() - startMs, ok: true });
                stepMessage(chatId, { who, provider, text: output, round: i + 1 });
            } catch (e) {
                if (e.wasCancelled) {
                    stepMessage(chatId, { who: `${who} (stopped)`, provider, text: 'Stopped before this step finished.', role: 'error', round: i + 1 });
                    break;
                }
                steps.push({ step: i + 1, task: def.task, provider, error: e.message, elapsedMs: Date.now() - startMs, ok: false });
                stepMessage(chatId, { who: `${who} error`, provider, text: e.message, role: 'error', round: i + 1 });
                break;
            }
        }
        return { finalOutput: previousOutput, steps };
    }

    async function runLoop({ chatId, task, provider, reviewProvider, maxTurns }) {
        const primary = provider || enabledProviders()[0] || 'chatgpt';
        const reviewer = reviewProvider || (enabledProviders().find(p => p !== primary) || 'claude');
        const turns = Math.max(1, Math.min(10, maxTurns || 3));
        const context = priorContext(chatId);
        let current = task;
        const iterations = [];
        for (let t = 1; t <= turns; t++) {
            const sig = runSignals.get(chatId);
            if (sig && sig.cancelled) break;
            const genWho = `Turn ${t} · generate · ${core.providerLabel(primary)}`;
            emit('multiai-orch-step', { chatId, status: 'running', turn: t, phase: 'generate', provider: primary, label: genWho });
            const startMs = Date.now();
            let generated;
            try {
                generated = await chat(chatId, primary, t === 1
                    ? `Complete this task:\n\n${task}${context}`
                    : `Revise this work based on the reviewer feedback below.\n\nORIGINAL TASK:\n${task}\n\nPREVIOUS ATTEMPT:\n${current}\n\nREVIEWER FEEDBACK:\n${iterations[iterations.length - 1].feedback}`);
            } catch (e) {
                stepMessage(chatId, { who: e.wasCancelled ? `${genWho} (stopped)` : `${genWho} error`, provider: primary, text: e.wasCancelled ? 'Stopped before this step finished.' : e.message, role: 'error', round: t });
                break;
            }
            current = generated;
            stepMessage(chatId, { who: genWho, provider: primary, text: generated, round: t });
            const revWho = `Turn ${t} · review · ${core.providerLabel(reviewer)}`;
            emit('multiai-orch-step', { chatId, status: 'running', turn: t, phase: 'review', provider: reviewer, label: revWho });
            let feedback = '';
            let converged = false;
            try {
                feedback = await chat(chatId, reviewer,
                    `Review this work against the original task. If it fully satisfies the task, reply with ` +
                    `"CONVERGED" as the first word, otherwise give specific, actionable feedback.\n\n` +
                    `ORIGINAL TASK:\n${task}\n\nWORK TO REVIEW:\n${current}`);
                converged = /^\s*[*_#>\s]*CONVERGED/i.test(feedback);
                stepMessage(chatId, { who: revWho, provider: reviewer, text: feedback, round: t });
            } catch (e) {
                if (e.wasCancelled) {
                    stepMessage(chatId, { who: `${revWho} (stopped)`, provider: reviewer, text: 'Stopped before this step finished.', role: 'error', round: t });
                    break;
                }
                feedback = `(review failed: ${e.message})`;
                stepMessage(chatId, { who: `${revWho} error`, provider: reviewer, text: e.message, role: 'error', round: t });
            }
            iterations.push({ turn: t, output: current, feedback, converged, elapsedMs: Date.now() - startMs });
            if (converged) { note(chatId, `Loop converged at turn ${t}.`); break; }
        }
        return { finalOutput: current, converged: iterations[iterations.length - 1]?.converged || false, iterations };
    }

    // ---- File tools (Orchestrated "Agent" strategy) --------------------
    // A ReAct loop built on our side: the model emits a fenced ```tool {...}```
    // block, we execute it against ONE user-chosen folder (resolveInRoot
    // refuses anything outside it), feed the result back, repeat until it
    // replies with plain text. Reads AND writes/deletes, no confirmation —
    // the folder scope is the only safety boundary, per explicit user choice.

    ipcMain.handle('multiai-tools-pick-folder', async () => {
        const w = win();
        try {
            const result = await dialog.showOpenDialog(w || undefined, {
                title: 'Choose a working folder for Agent (file tools)',
                properties: ['openDirectory', 'createDirectory'],
            });
            if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
            return { success: true, path: result.filePaths[0] };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    function resolveInRoot(root, relPath) {
        const normalizedRoot = path.resolve(root);
        const target = path.resolve(normalizedRoot, relPath || '.');
        if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) {
            throw new Error('That path is outside the working folder — refused.');
        }
        return target;
    }

    function execToolOp(root, op, relPath, content) {
        const target = resolveInRoot(root, relPath);
        switch (op) {
            case 'list': {
                const stat = fs.statSync(target);
                if (!stat.isDirectory()) throw new Error('Not a directory.');
                const entries = fs.readdirSync(target, { withFileTypes: true });
                return entries.map(e => `${e.isDirectory() ? '[dir] ' : '[file]'} ${e.name}`).join('\n') || '(empty)';
            }
            case 'read': {
                let text = fs.readFileSync(target, 'utf-8');
                if (text.length > 50000) text = text.slice(0, 50000) + '\n...(truncated)';
                return text;
            }
            case 'write': {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, content || '', 'utf-8');
                return `Wrote ${Buffer.byteLength(content || '', 'utf-8')} bytes.`;
            }
            case 'append': {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.appendFileSync(target, content || '', 'utf-8');
                return `Appended ${Buffer.byteLength(content || '', 'utf-8')} bytes.`;
            }
            case 'mkdir': {
                fs.mkdirSync(target, { recursive: true });
                return 'Directory created.';
            }
            case 'delete': {
                const normalizedRoot = path.resolve(root);
                if (target === normalizedRoot) throw new Error('Refusing to delete the working folder root itself.');
                fs.rmSync(target, { recursive: true, force: true });
                return 'Deleted.';
            }
            default:
                throw new Error(`Unknown op: ${op}`);
        }
    }

    function buildToolsPreamble() {
        return 'You have access to file tools scoped to one working folder — you cannot reach anything outside it. ' +
            'To use a tool, reply with ONLY a single fenced block like this and nothing else:\n\n' +
            '```tool\n{"op": "list", "path": "."}\n```\n\n' +
            'Available ops (path is always relative to the working folder root; use "." for the root itself):\n' +
            '- list {"path"} — list a directory\'s contents\n' +
            '- read {"path"} — read a text file\n' +
            '- write {"path", "content"} — create or overwrite a text file\n' +
            '- append {"path", "content"} — append to a text file\n' +
            '- mkdir {"path"} — create a directory\n' +
            '- delete {"path"} — delete a file or directory (irreversible)\n\n' +
            'After a tool result comes back, call another tool the same way, or reply with plain text and no tool ' +
            'block once you have your final answer — that plain-text reply ends the run.';
    }

    async function runAgentTools({ chatId, task, provider, root, maxTurns }) {
        if (!root) throw new Error('No working folder chosen.');
        const turns = Math.max(1, Math.min(15, maxTurns || 6));
        let transcript = `${buildToolsPreamble()}\n\nTASK: ${task}`;
        const steps = [];
        const who = `Agent · ${core.providerLabel(provider)}`;
        for (let t = 1; t <= turns; t++) {
            const sig = runSignals.get(chatId);
            if (sig && sig.cancelled) break;
            emit('multiai-orch-step', { chatId, status: 'running', turn: t, provider, label: `${who} · turn ${t}` });
            const startMs = Date.now();
            let reply;
            try {
                reply = await chat(chatId, provider, transcript);
            } catch (e) {
                stepMessage(chatId, { who: e.wasCancelled ? `${who} (stopped)` : `${who} error`, provider, text: e.wasCancelled ? 'Stopped before this step finished.' : e.message, role: 'error', round: t });
                break;
            }

            const toolCall = core.parseToolCall(reply);
            if (!toolCall) {
                steps.push({ turn: t, output: reply, elapsedMs: Date.now() - startMs, ok: true });
                stepMessage(chatId, { who, provider, text: reply, round: t });
                return { finalOutput: reply, steps };
            }

            let resultText;
            try {
                resultText = execToolOp(root, toolCall.op, toolCall.path, toolCall.content);
            } catch (e) {
                resultText = `ERROR: ${e.message}`;
            }
            const shown = `[tool: ${toolCall.op} ${toolCall.path || ''}]\n${resultText}`;
            steps.push({ turn: t, output: shown, elapsedMs: Date.now() - startMs, ok: true });
            stepMessage(chatId, { who: `${who} · tool`, provider, text: shown, round: t });

            transcript += `\n\nASSISTANT: ${reply}\n\nTOOL RESULT (${toolCall.op} ${toolCall.path || ''}):\n${resultText}\n\n` +
                'Continue with another tool call, or give your final answer as plain text with no tool block.';
        }
        return { finalOutput: (steps[steps.length - 1] && steps[steps.length - 1].output) || '(turn limit reached with no final answer)', steps };
    }

    ipcMain.handle('multiai-run-orchestrated', async (event, opts) => {
        const { chatId, strategy } = opts;
        try {
            startSignal(chatId);
        } catch (e) {
            return { success: false, error: e.message };
        }
        try {
            let result;
            if (strategy === 'crew') result = await runCrew(opts);
            else if (strategy === 'workflow') result = await runWorkflow(opts);
            else if (strategy === 'loop') result = await runLoop(opts);
            else if (strategy === 'agent') result = await runAgentTools(opts);
            else throw new Error(`Unknown strategy: ${strategy}`);
            const sig = runSignals.get(chatId);
            if (sig && sig.cancelled) note(chatId, 'Run stopped.');
            endSignal(chatId);
            emit('multiai-orch-done', { chatId });
            return { success: true, ...result };
        } catch (e) {
            endSignal(chatId);
            emit('multiai-orch-done', { chatId });
            return { success: false, error: e.message };
        }
    });

    // ---- REST: local agents read and append ---------------------------
    // Registered on the existing gateway (port 3210+). Same loopback-only and
    // API-key rules as every other /v1 route. All bodies/results are JSON.
    //
    //   GET  /v1/multiai/chats                      → [{id,title,mode,participants,messageCount,...}]
    //   POST /v1/multiai/chats                      {title?, participants?, mode?, topic?} → chat
    //   GET  /v1/multiai/chats/:id[?since=<msgId>]  → chat (messages after `since` if given)
    //   POST /v1/multiai/chats/:id/messages         {who, text, role?, provider?} → message
    //        (appends a turn from an external agent; nothing is sent to providers)
    //   POST /v1/multiai/chats/:id/run              {text?, who?, rounds?, wait?} → {started} | {messages}
    //        (optionally records `text` as a human/agent message, then runs rounds)
    //   POST /v1/multiai/chats/:id/stop
    //   GET  /v1/multiai/running                    → [chatId]
    if (typeof registerRouteExtension === 'function') {
        registerRouteExtension(async (method, url, body, res, { sendJSON, sendError }) => {
            const p = url.pathname;
            if (!p.startsWith('/v1/multiai')) return false;
            const m = /^\/v1\/multiai\/chats\/([^/]+)(?:\/(messages|run|stop))?$/.exec(p);
            try {
                if (method === 'GET' && p === '/v1/multiai/running') { sendJSON(res, 200, { running: Array.from(runSignals.keys()) }); return true; }
                if (method === 'GET' && p === '/v1/multiai/chats') { sendJSON(res, 200, { chats: store.listChats() }); return true; }
                if (method === 'POST' && p === '/v1/multiai/chats') {
                    const fields = {};
                    if (body.title) fields.title = String(body.title).slice(0, 120);
                    if (Array.isArray(body.participants)) fields.participants = body.participants.map(String);
                    if (body.mode === 'classic' || body.mode === 'orchestrated') fields.mode = body.mode;
                    if (body.discussMode === 'discuss' || body.discussMode === 'debate') fields.discussMode = body.discussMode;
                    if (body.brevity) fields.brevity = String(body.brevity);
                    if (body.topic) fields.topic = String(body.topic);
                    const created = store.createChat(fields);
                    if (body.topic) {
                        created.cycle = 1;
                        store.updateChat(created.id, { cycle: 1, title: fields.title || core.localTitle(body.topic) });
                        record(created.id, { who: body.who || 'You', role: 'user', text: String(body.topic), cycle: 1, round: 0 });
                    }
                    emit('multiai-chat-created', { chat: store.getChat(created.id) });
                    sendJSON(res, 201, { chat: store.getChat(created.id) });
                    return true;
                }
                if (!m) { sendError(res, 404, 'Unknown multiai route', 'not_found'); return true; }
                const chatId = decodeURIComponent(m[1]);
                const sub = m[2] || '';
                const chat = store.getChat(chatId);
                if (!chat) { sendError(res, 404, 'Chat not found', 'not_found'); return true; }

                if (method === 'GET' && !sub) {
                    const since = url.searchParams.get('since');
                    let messages = chat.messages || [];
                    if (since) {
                        const i = messages.findIndex(x => x.id === since);
                        messages = i === -1 ? messages : messages.slice(i + 1);
                    }
                    const out = Object.assign({}, chat, { messages: messages.map(x => Object.assign({ label: core.refLabel(x) }, x)) });
                    out.running = isRunning(chatId);
                    sendJSON(res, 200, { chat: out });
                    return true;
                }
                if (method === 'POST' && sub === 'messages') {
                    const text = String(body.text || '').trim();
                    if (!text) { sendError(res, 400, 'text is required'); return true; }
                    const role = ['assistant', 'user', 'summary', 'judge', 'system'].includes(body.role) ? body.role : 'assistant';
                    const provider = String(body.provider || (role === 'user' ? 'human' : 'external')).toLowerCase();
                    const who = String(body.who || (role === 'user' ? 'You' : core.providerLabel(provider))).slice(0, 60);
                    if (role === 'user') {
                        store.updateChat(chatId, { cycle: (chat.cycle || 0) + 1 });
                    }
                    const fresh = store.getChat(chatId);
                    const saved = record(chatId, { who, text, provider, role, cycle: fresh.cycle || 1, round: role === 'user' ? 0 : (body.round != null ? Number(body.round) : 0) });
                    sendJSON(res, 201, { message: Object.assign({ label: core.refLabel(saved) }, saved) });
                    return true;
                }
                if (method === 'POST' && sub === 'run') {
                    if (isRunning(chatId)) { sendError(res, 409, 'A run is already in progress for this chat', 'conflict'); return true; }
                    const text = String(body.text || '').trim();
                    if (text) {
                        store.updateChat(chatId, { cycle: (chat.cycle || 0) + 1, topic: chat.topic || text });
                        const fresh = store.getChat(chatId);
                        record(chatId, { who: String(body.who || 'You').slice(0, 60), text, provider: 'human', role: 'user', cycle: fresh.cycle, round: 0 });
                        if (!chat.messages.length && (chat.title === 'New chat' || !chat.title)) store.updateChat(chatId, { title: core.localTitle(text) });
                    } else if (!(chat.cycle || 0)) {
                        store.updateChat(chatId, { cycle: 1 });
                    }
                    const rounds = body.rounds != null ? Number(body.rounds) : undefined;
                    const runP = runClassic({ chatId, rounds, latestText: text }).catch(e => { console.error('[MultiAI] REST run failed:', e.message); return []; });
                    if (body.wait) {
                        const messages = await runP;
                        sendJSON(res, 200, { messages: messages.map(x => Object.assign({ label: core.refLabel(x) }, x)) });
                    } else {
                        sendJSON(res, 202, { started: true, chatId });
                    }
                    return true;
                }
                if (method === 'POST' && sub === 'stop') {
                    const sig = runSignals.get(chatId);
                    if (sig) { sig.cancelled = true; sig.resolve(); }
                    sendJSON(res, 200, { stopped: !!sig });
                    return true;
                }
                sendError(res, 405, 'Method not allowed', 'method_not_allowed');
                return true;
            } catch (e) {
                sendError(res, 500, e.message);
                return true;
            }
        });
    }
}

module.exports = { registerMultiAiHandlers };
