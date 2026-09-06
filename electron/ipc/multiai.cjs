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
const cli = require('../providers/cli.cjs');
const { createVariants } = require('../providers/variants.cjs');
const workspace = require('../providers/workspace.cjs');
const catalog = require('../providers/catalog.cjs');
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
    // Keep the keyless model catalogue beside the rest of the app's data.
    catalog.setCacheDir(dataDir());

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
    const inFlight = new Map();   // chatId -> Set of "base|sessionId" for sends that have been queued/started

    // Stop = resolve the signal (the run loop stops waiting immediately) AND
    // abort the provider calls that were queued or in flight for this chat.
    // Queued ones are skipped via shouldRun; the active one is aborted inside
    // the BrowserView (engine abort()), so it stops occupying the provider's
    // queue — previously it kept running for up to six minutes.
    function stopChat(chatId) {
        const sig = runSignals.get(chatId);
        if (sig) { sig.cancelled = true; sig.resolve(); }
        const set = inFlight.get(chatId);
        if (set) {
            for (const entry of set) {
                if (entry.kind === 'browser' && typeof sender.abortActive === 'function') {
                    sender.abortActive(entry.base, entry.sessionId).catch(() => { });
                } else if (entry.kind === 'cli' && typeof entry.abort === 'function') {
                    try { entry.abort(); } catch { /* ignore */ }
                }
                // API calls have no cancel hook yet; their result is discarded.
            }
        }
        return !!sig;
    }

    // `startedBy` distinguishes a run the user launched from one a local agent
    // launched over REST or MCP. Without the event below, the renderer only
    // learned a chat was running from a one-shot poll at load: an external run
    // streamed turns into the open chat with no ● and no Stop button, kept
    // running when the chat was deleted, and absorbed the user's next Send
    // (with its cycle bump) into a discussion they could not see.
    function startSignal(chatId, startedBy = 'ui') {
        if (runSignals.has(chatId)) throw new Error('A run is already in progress for this chat.');
        let resolveFn;
        const promise = new Promise((res) => { resolveFn = res; });
        const sig = { cancelled: false, resolve: resolveFn, promise, startedBy, at: Date.now() };
        runSignals.set(chatId, sig);
        emit('multiai-run-started', { chatId, startedBy });
        return sig;
    }

    // Shape kept ahead of the per-agent status strip: `agents` is empty for now
    // and the renderer ignores it, so filling it in later needs no second
    // version of this payload.
    const agentStates = new Map();   // chatId -> Map(agentId -> {state, reason, who})
    function setAgentState(chatId, agent, state, reason) {
        if (!agentStates.has(chatId)) agentStates.set(chatId, new Map());
        const m = agentStates.get(chatId);
        if (state === 'done') m.delete(agent.id); else m.set(agent.id, { state, reason: reason || '', who: agent.name });
        emit('multiai-agent-state', { chatId, agentId: agent.id, who: agent.name, state, reason: reason || '' });
    }
    function clearAgentStates(chatId) { agentStates.delete(chatId); }

    function runningState() {
        return Array.from(runSignals.entries()).map(([chatId, s]) => ({
            chatId,
            startedBy: s.startedBy || 'ui',
            agents: Array.from((agentStates.get(chatId) || new Map()).entries())
                .map(([agentId, v]) => ({ agentId, who: v.who, state: v.state, reason: v.reason })),
        }));
    }

    function endSignal(chatId) {
        runSignals.delete(chatId);
        clearAgentStates(chatId);
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

    // ---- agents & routes ---------------------------------------------------
    // Participants are agents (multiai-core.normalizeAgents): name + route +
    // provider + model + effort. Route resolution is governed by the app's
    // general Settings: when API mode is on there and a key exists for the
    // agent's provider, 'auto' agents go to the API with the model chosen there
    // (or the agent's own); otherwise they go through the browser tab. CLI
    // agents (Claude Code / Codex) always run locally on your subscription.
    const byok = deps.byok || null;

    function agentsOf(chat) {
        return core.normalizeAgents(chat || {});
    }

    // A provider that only exists as an API entry in Settings — a BYOK
    // provider that has no browser tab (deepseek, groq, …) or a custom
    // OpenAI-compatible endpoint such as Ollama / LM Studio. Such seats are
    // api-only: the global API-mode switch decides browser-vs-API for the four
    // browser providers, but for these there is nothing else to fall back to.
    function isApiOnlyProvider(provider) {
        return !core.CLI_PROVIDERS[provider] && !core.KNOWN_PROVIDERS.includes(String(provider || '').split(':')[0]);
    }

    function apiAvailable(provider) {
        try {
            if (!byok || !byok.keys || !byok.keys.hasKey(provider)) return false;
            return isApiOnlyProvider(provider) || byok.keys.isEnabled();
        } catch { return false; }
    }

    function resolveRoute(agent) {
        if (core.CLI_PROVIDERS[agent.provider]) return 'cli';
        if (isApiOnlyProvider(agent.provider)) return 'api';
        if (agent.route === 'browser') return 'browser';
        return apiAvailable(agent.provider) ? 'api' : 'browser';
    }

    // Custom endpoints (Settings → API → local / custom): entry with an
    // endpoint URL. Model lists are fetched from `<base>/models` when asked.
    const _customModels = {};
    function customProviders() {
        const out = {};
        try {
            const store = byok && byok.keys && byok.keys._readStore ? byok.keys._readStore() : {};
            for (const [name, entry] of Object.entries(store || {})) {
                if (name === '_meta' || !entry || !entry.key) continue;
                if (core.KNOWN_PROVIDERS.includes(name)) continue;
                out[name] = { endpoint: entry.endpoint || '', label: entry.displayName || name, custom: !!entry.endpoint };
            }
        } catch { /* no store */ }
        return out;
    }

    async function fetchCustomModels(name, endpoint) {
        if (!endpoint || typeof fetch !== 'function') return [];
        const base = endpoint.replace(/\/chat\/completions\/?$/i, '');
        const url = `${base.replace(/\/$/, '')}/models`;
        try {
            const key = byok.keys.getKey(name);
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 4000);
            const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: ctrl.signal });
            clearTimeout(t);
            if (!res.ok) return [];
            const data = await res.json();
            const list = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []));
            return list.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)))).filter(Boolean);
        } catch { return []; }
    }

    // What the editor needs to offer sensible choices: API mode state and
    // per-provider selected model / model list from Settings, CLI availability,
    // plus any api-only providers (BYOK-only and custom endpoints).
    function routeInfo() {
        const info = { apiMode: false, providers: {}, cli: cli.availability() };
        try {
            info.apiMode = !!(byok && byok.keys && byok.keys.isEnabled());
            const entries = core.KNOWN_PROVIDERS.map(p => [p, null]).concat(Object.entries(customProviders()));
            for (const [p, custom] of entries) {
                let hasKey = false, model = '', models = [];
                try { hasKey = !!(byok && byok.keys.hasKey(p)); } catch { /* ignore */ }
                try { model = (byok && byok.keys.getSelectedModel(p)) || (byok && byok.models && byok.models.DEFAULT_MODELS && byok.models.DEFAULT_MODELS[p]) || ''; } catch { /* ignore */ }
                try { models = ((byok && byok.keys.getModels(p)) || []).filter(m => m.enabled !== false).map(m => m.id); } catch { /* ignore */ }
                if (custom && !models.length && _customModels[p]) models = _customModels[p];
                info.providers[p] = custom
                    ? { hasKey, model, models, apiOnly: true, custom: custom.custom, endpoint: custom.endpoint, label: custom.label }
                    : { hasKey, model, models };
            }
        } catch { /* settings unavailable */ }
        return info;
    }

    // Probe custom endpoints for their model lists (used by ↻ / the
    // background probe after first paint).
    async function probeCustomModels() {
        for (const [name, c] of Object.entries(customProviders())) {
            if (!c.endpoint) continue;
            const models = await fetchCustomModels(name, c.endpoint);
            if (models.length) _customModels[name] = models;
        }
    }

    // Ad-hoc agent from a provider string / agent id / agent object (judge,
    // summary, title, orchestrated steps).
    function agentFrom(chat, ref) {
        if (ref && typeof ref === 'object') return core.normalizeAgents({ agents: [ref] })[0];
        const agents = agentsOf(chat);
        const hit = core.findAgent(agents, ref) || agents.find(a => a.provider === String(ref || '').split(':')[0]);
        if (hit) return hit;
        const base = String(ref || '').split(':')[0];
        const model = String(ref || '').includes(':') && !core.CLI_PROVIDERS[base] ? String(ref) : '';
        return core.normalizeAgents({ agents: [{ provider: base, model }] })[0];
    }

    function sessionState(chat, key) {
        const all = chat.providerSessions || {};
        return all[key] || { gen: 1, turns: 0, lastId: null };
    }

    function contextModeOf(chat) {
        return core.CONTEXT_MODES.includes(chat.contextMode) ? chat.contextMode : core.DEFAULTS.contextMode;
    }

    // Delta needs a provider-side thread; API and CLI turns are one-shot, so
    // they use the self-sufficient bounded prompt (or full, if chosen).
    function contextModeFor(chat, route) {
        const m = contextModeOf(chat);
        if (route !== 'browser' && m === 'delta') return 'bounded';
        return m;
    }

    function resetEveryFor(chat) {
        return contextModeOf(chat) === 'delta' ? core.DEFAULTS.providerResetEveryDelta : core.DEFAULTS.providerResetEvery;
    }

    function sessionIdFor(chat, agent, st) {
        return `${core.sessionFor(chat.id)}:${agent.id}:${st.gen}`;
    }

    // The thread state a turn will use: rotates to a fresh generation when the
    // turn bound is hit. Delta mode needs to know this BEFORE building the
    // prompt (a fresh thread gets a full catch-up instead of a delta).
    function nextSessionState(chat, agent) {
        const st = sessionState(chat, agent.id);
        if (st.turns >= resetEveryFor(chat)) return { gen: st.gen + 1, turns: 0, lastId: null, rotated: true };
        return Object.assign({}, st, { rotated: false });
    }

    function saveSession(chat, key, next) {
        chat.providerSessions = Object.assign({}, chat.providerSessions || {}, { [key]: next });
        if (store.getChat(chat.id)) store.updateChat(chat.id, (c) => { c.providerSessions = Object.assign({}, c.providerSessions || {}, { [key]: next }); });
    }

    function trackInFlight(chatId, entry) {
        if (!inFlight.has(chatId)) inFlight.set(chatId, new Set());
        inFlight.get(chatId).add(entry);
        return () => { const set = inFlight.get(chatId); if (set) { set.delete(entry); if (!set.size) inFlight.delete(chatId); } };
    }

    // Browser route: one provider-side thread per agent per chat.
    async function sendBrowser(chat, agent, prompt, st, lastId) {
        if (!st) st = nextSessionState(chat, agent);
        const sessionId = sessionIdFor(chat, agent, st);
        const providerString = (agent.provider === 'gemini' && agent.model) ? (agent.model.startsWith('gemini:') ? agent.model : `gemini:${agent.model}`) : agent.provider;
        const untrack = trackInFlight(chat.id, { kind: 'browser', base: agent.provider, sessionId });
        const sig = runSignals.get(chat.id);
        const options = { shouldRun: () => !(sig && sig.cancelled) };
        let result;
        try {
            result = await raceProvider(chat.id, sender.sendMessageToProvider(providerString, prompt, null, null, sessionId, options));
        } finally {
            untrack();
        }
        let next = null;
        if (result.ok) {
            next = { gen: st.gen, turns: st.turns + 1, lastId: lastId !== undefined ? lastId : (st.lastId || null) };
        } else if (result.cancelled && contextModeOf(chat) !== 'delta') {
            next = { gen: st.gen, turns: st.turns + 1, lastId: st.lastId || null };
        } else if (contextModeOf(chat) === 'delta') {
            // Delta mode leans on the provider thread's memory, and some engines
            // (Gemini) wipe the thread on any failure. We can't see that from
            // here, so after an error start a new generation: the next turn is
            // a full catch-up instead of a delta into an amnesiac thread.
            next = { gen: st.gen + 1, turns: 0, lastId: null };
        }
        if (next) saveSession(chat, agent.id, next);
        // The seat's configured model means nothing on a browser route, so
        // record what the tab is actually set to and fall back to null
        // rather than labelling the turn with a model it did not use.
        if (result.ok) result.value = { response: result.value.response, model: (sender.readTabModel ? await sender.readTabModel(agent.provider).catch(() => null) : null), route: 'browser' };
        return result;
    }

    // Which model an API call should name. An agent on the `auto` route may
    // carry a browser-side model (a Gemini engine like "3.1-pro") that the API
    // would reject, so on `auto` the agent's model is only used when Settings
    // lists it; otherwise the model selected in Settings applies. An explicit
    // `api` route trusts what was typed.
    function apiModelFor(agent) {
        if (!agent.model) return undefined;
        if (agent.route === 'api') return agent.model;
        try {
            const known = (byok.keys.getModels(agent.provider) || []).map(m => m.id);
            return known.length && !known.includes(agent.model) ? undefined : agent.model;
        } catch { return agent.model; }
    }

    // API route: the provider's API with the key from Settings. Model = the
    // agent's, else the model selected in Settings (resolveModel handles it).
    async function sendApi(chat, agent, prompt) {
        const key = byok.keys.getKey(agent.provider);
        if (!key) return { ok: false, error: new Error(`No API key for ${core.providerLabel(agent.provider)} in Settings${isApiOnlyProvider(agent.provider) ? ' (Settings → API → add the provider / local endpoint)' : ''}`) };
        const untrack = trackInFlight(chat.id, { kind: 'api', base: agent.provider });
        try {
            const p = byok.callProvider(agent.provider, key, [{ role: 'user', content: prompt }], {
                modelId: apiModelFor(agent),
                reasoningEffort: agent.effort || undefined,
            }).then(r => ({ response: r.text, model: r.model || agent.model || null, route: 'api' }));
            return await raceProvider(chat.id, p);
        } finally {
            untrack();
        }
    }

    // The chat's workspace as a CLI seat sees it (null when the chat has none
    // or the seat has no tools).
    function workspaceFor(chat, agent) {
        const root = chat && chat.workspace && chat.workspace.root;
        if (!root || !agent || !core.CLI_PROVIDERS[agent.provider] || !agent.tools || agent.tools === 'none') return null;
        return { root, branch: (chat.workspace && chat.workspace.branch) || workspace.branchFor(chat.id), tools: agent.tools };
    }

    // CLI route: Claude Code / Codex / Gemini CLI on the local machine.
    async function sendCli(chat, agent, prompt) {
        const ws = workspaceFor(chat, agent);
        const handle = cli.run(agent.provider, {
            model: agent.model || undefined, effort: agent.effort || undefined, prompt, cwd: dataDir(), workspace: ws || undefined,
            onState: (st) => setAgentState(chat.id, agent, st === 'queued' ? 'waiting' : 'working', st === 'queued' ? `${core.providerLabel(agent.provider)} slot` : ''),
        });
        const entry = { kind: 'cli', base: agent.provider, abort: handle.abort };
        const untrack = trackInFlight(chat.id, entry);
        try {
            const p = handle.promise.then(r => ({ response: r.text, model: r.model || agent.model || null, route: 'cli', costUsd: r.costUsd }));
            const raced = await raceProvider(chat.id, p);
            // Wait for the process to actually die before returning: the caller
            // may commit the workspace on the very next tick, and a child that
            // is still writing would land half-written files in that commit.
            if (raced.cancelled) await handle.abort();
            return raced;
        } finally {
            untrack();
        }
    }

    async function sendAgent(chat, agent, prompt, extra) {
        const route = resolveRoute(agent);
        if (route === 'api') return sendApi(chat, agent, prompt);
        if (route === 'cli') return sendCli(chat, agent, prompt);
        return sendBrowser(chat, agent, prompt, extra && extra.st, extra && extra.lastId);
    }

    // One-off calls (judge, summary, title) use a per-chat auxiliary thread
    // on the browser route (rotated every few uses so it stays bounded);
    // API/CLI calls are one-shot anyway. `ref` may be an agent, an agent id
    // or a provider string.
    const AUX_RESET_EVERY = 5;
    async function sendAux(chat, ref, prompt) {
        const agent = agentFrom(chat, ref);
        const route = resolveRoute(agent);
        if (route === 'api') {
            const r = await sendApi(chat, agent, prompt);
            if (r.ok) return r.value;
            throw r.error;
        }
        if (route === 'cli') {
            // Aux turns — judge, summary, auto-summary, title — are one-shot
            // and never run through prepareWorkspace, so they get no repo
            // check, no dirty-tree refusal, no branch switch, no writer lock
            // and no commit. A seat reached here must therefore never carry a
            // tools level: with one, its edits land on whatever branch the
            // folder happens to be on and are left for the next writer turn's
            // `git add -A` to claim. Reaching here with tools set is easy —
            // `maybeAutoSummary` falls back to the roster's first seat when no
            // judge is configured, and agent ids collide with provider names.
            const r = await sendCli(chat, { ...agent, tools: 'none' }, prompt);
            if (r.ok) return r.value;
            if (r.cancelled) throw new Error('Cancelled by user');
            throw r.error;
        }
        const key = `aux:${agent.provider}`;
        let st = sessionState(chat, key);
        if (st.turns >= AUX_RESET_EVERY) st = { gen: st.gen + 1, turns: 0 };
        const sessionId = `${core.auxSessionFor(chat.id)}:${st.gen}`;
        const providerString = (agent.provider === 'gemini' && agent.model) ? (agent.model.startsWith('gemini:') ? agent.model : `gemini:${agent.model}`) : agent.provider;
        const result = await sender.sendMessageToProvider(providerString, prompt, null, null, sessionId);
        saveSession(chat, key, { gen: st.gen, turns: st.turns + 1 });
        return { response: result.response, model: (sender.readTabModel ? await sender.readTabModel(agent.provider).catch(() => null) : null), route: 'browser' };
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
    // Route info for the agent editor. `probe` re-runs CLI discovery
    // (version, models, effort levels, login) — slow-ish, so the editor asks
    // for it in the background after first paint, and on ↻; otherwise the
    // cached discovery (or null) rides along.
    ipcMain.handle('multiai-routes', async (event, opts) => {
        const probe = !!(opts && opts.probe);
        if (probe) cli.resetAvailabilityCache();
        if (probe) { try { await probeCustomModels(); } catch { /* offline */ } }
        const info = routeInfo();
        try { info.cliInfo = probe ? await cli.discover({ force: true }) : (cli.discovered() || null); } catch { info.cliInfo = null; }
        return info;
    });
    // Try a model for real, so a seat can be trusted before a run depends on it.
    // Discovery cannot answer this on its own: Claude Code's list is only the
    // aliases in its --help, though it accepts full claude-… ids, and Codex's
    // list comes from a cache written by whichever binary the user last ran.
    // One short turn is the only authority on whether a model actually works.
    ipcMain.handle('multiai-test-variant', async (event, { provider, model, effort } = {}) => {
        const started = Date.now();
        try {
            const r = await askVariant({
                provider, model, effort,
                message: 'Reply with the single word: OK',
                timeoutMs: 90000,
                queueDeadlineMs: 60000,
            });
            return { ok: true, ms: Date.now() - started, model: r.model || model || null, effort: r.effort || null, text: (r.text || '').slice(0, 120) };
        } catch (e) {
            return { ok: false, ms: Date.now() - started, error: e.message || String(e) };
        }
    });

    ipcMain.handle('multiai-running', () => runningState());

    ipcMain.handle('multiai-stop-run', (event, { chatId }) => {
        stopChat(chatId);
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

    function personaFor(chat, agent) {
        if (agent.persona) return agent.persona;
        const p = chat.personas || {};
        return p[agent.id] || p[agent.provider] || null;
    }

    async function takeTurn(chatId, agent, round, opts) {
        const chat = store.getChat(chatId);
        if (!chat) throw new Error('Chat not found');
        const cycle = chat.cycle || 1;
        emit('multiai-thinking', { chatId, provider: agent.provider, agentId: agent.id, who: agent.name });
        setAgentState(chatId, agent, 'working', '');
        const { brief, latest } = core.briefAndLatest(chat.messages, chat.topic);
        const route = resolveRoute(agent);
        const st = route === 'browser' ? nextSessionState(chat, agent) : null;
        const cmode = contextModeFor(chat, route);
        const built = core.buildClassicPromptWithMeta({
            chatTitle: chat.title,
            topic: brief,
            latestUserMessage: latest,
            mode: chat.discussMode,
            brevity: chat.brevity,
            persona: personaFor(chat, agent),
            participants: opts.participants,
            agent,
            provider: agent.provider,
            messages: chat.messages,
            contextOpts: contextOpts(chat),
            stopToken: chat.stopToken || core.DEFAULTS.stopToken,
            independent: opts.independent ? { cycle } : null,
            contextMode: cmode,
            // A fresh/rotated thread has no memory: force the catch-up prompt.
            delta: { sinceId: (!st || st.rotated || st.turns === 0) ? null : st.lastId, provider: agent.provider, agentId: agent.id },
            charter: !!chat.charterMode,
            redTeam: !!(chat.charterMode && opts.redTeam && opts.redTeam.id === agent.id),
            workspace: chat.workspace && chat.workspace.root ? { root: chat.workspace.root, branch: chat.workspace.branch || workspace.branchFor(chat.id) } : null,
        });
        // Writers take turns in the folder one at a time (readers and
        // discussion seats can overlap), so parallel first rounds never race
        // on the same files and every commit belongs to one seat.
        const ws = workspaceFor(chat, agent);
        const writer = !!(ws && (ws.tools === 'write' || ws.tools === 'full'));
        if (writer) setAgentState(chatId, agent, 'waiting', 'workspace turn');
        const releaseWriter = writer ? await acquireWriter(chatId) : null;
        // Waiting for the lock can take a whole CLI turn, and Stop may have
        // landed meanwhile. Without this, a parallel round still spawns
        // writers 2..n as the lock drains — each aborted a moment later, but
        // each having already started and already reached commitAll.
        const turnSig = runSignals.get(chatId);
        if (turnSig && turnSig.cancelled) {
            if (releaseWriter) releaseWriter();
            record(chatId, Object.assign({ who: `${agent.name} (stopped)`, text: 'Stopped before this turn started.', role: 'error' },
                { provider: agent.provider, agentId: agent.id, code: agent.code, route, cycle, round }));
            return { cancelled: true };
        }
        let raced;
        let change = null;
        try {
            // Mark the turn in flight before anything can write, so that if we
            // die here the next prepare() can recognise the leftovers as ours
            // rather than committing the user's work under the app's identity.
            if (writer) setWorkspacePending(chatId, { head: await workspace.head(ws.root), agent: agent.name, at: Date.now() });
            raced = await sendAgent(chat, agent, built.prompt, { st, lastId: cmode === 'delta' ? built.meta.lastId : null });
            if (writer) {
                const label = core.refLabel({ cycle, round, code: agent.code, role: 'assistant' });
                try { change = await workspace.commitAll(ws.root, `${agent.name} [${label}]${raced.ok ? '' : ' (turn ended with an error)'}`); }
                catch (e) { change = { committed: false, error: e.message }; }
            }
        } finally {
            if (writer) setWorkspacePending(chatId, null);
            if (releaseWriter) releaseWriter();
        }
        setAgentState(chatId, agent, 'done');
        const base = { provider: agent.provider, agentId: agent.id, code: agent.code, route, cycle, round };
        const recordChange = () => {
            if (!change) return;
            if (change.committed) {
                // `truncated` was computed and dropped here, so the card could
                // not say the patch was cut — the only sign was a line at the
                // bottom of a fold the reader had to open and scroll first.
                record(chatId, Object.assign({ who: `${agent.name} · changes`, role: 'change', text: workspace.describeChange(agent.name, change), commit: change.hash, files: change.files.map(f => f.path), truncated: change.truncated || undefined, partial: raced.ok ? undefined : true }, base));
            } else if (change.error) {
                note(chatId, `Could not commit ${agent.name}'s changes: ${change.error}`);
            }
        };
        if (raced.cancelled) {
            record(chatId, Object.assign({ who: `${agent.name} (stopped)`, text: 'Stopped before this reply arrived.', role: 'error' }, base));
            recordChange();
            return { cancelled: true };
        }
        if (!raced.ok) {
            record(chatId, Object.assign({ who: `${agent.name} error`, text: raced.error.message, role: 'error' }, base));
            recordChange();
            return { error: raced.error.message };
        }
        const text = raced.value.response || '';
        const model = raced.value.model || undefined;
        if (core.isPass(text)) {
            record(chatId, Object.assign({ who: agent.name, text: 'PASS', role: 'pass', model }, base));
            recordChange();
            return { pass: true };
        }
        record(chatId, Object.assign({ who: agent.name, text, role: 'assistant', model, redTeam: built.meta.redTeam || undefined, toolClaim: claimsTool(agent, text) || undefined }, base));
        recordChange();
        return { ok: true, handoff: chat.charterMode ? core.parseHandoff(text, opts.participants) : null };
    }

    // One writer at a time per *repository*, not per chat. Two chats can point
    // at the same folder — one driven from the UI, one over REST, which is the
    // concurrent-agents case this feature exists to enable — and the working
    // tree is shared: they would check out different multiai/* branches while
    // the other's seats were mid-edit, and each `git add -A` would sweep the
    // other's in-progress work into its own commit.
    const writerLocks = new Map();
    function writerKey(chatId) {
        const chat = store.getChat(chatId);
        const root = chat && chat.workspace && chat.workspace.root;
        return root ? `root:${path.resolve(root).toLowerCase()}` : `chat:${chatId}`;
    }
    function acquireWriter(chatId) {
        const key = writerKey(chatId);
        const prev = writerLocks.get(key) || Promise.resolve();
        let release;
        const next = new Promise(res => { release = res; });
        writerLocks.set(key, prev.then(() => next));
        return prev.then(() => release);
    }

    // Which running chat, if any, already claims this chat's workspace folder.
    // Checked before a run starts so the refusal is synchronous and the caller
    // gets a real status code, rather than surfacing later inside a run whose
    // rejection the fire-and-forget path would swallow.
    function workspaceClaimedBy(chatId) {
        const chat = store.getChat(chatId);
        const root = chat && chat.workspace && chat.workspace.root;
        if (!root) return null;
        const mine = path.resolve(root).toLowerCase();
        for (const otherId of runSignals.keys()) {
            if (otherId === chatId) continue;
            const other = store.getChat(otherId);
            const theirs = other && other.workspace && other.workspace.root;
            if (theirs && path.resolve(theirs).toLowerCase() === mine) return otherId;
        }
        return null;
    }

    // A tool-less CLI seat that emits tool-call syntax is fabricating: the
    // "file contents" or "command output" that follow are invented, and they
    // are recorded as an ordinary assistant turn, fed to every other agent as
    // context, and served over REST/MCP. Flag it so the feed can mark it and a
    // reader is not left treating it as evidence. Only CLI seats without file
    // tools can hit this — a seat with real tools legitimately narrates them.
    const TOOL_CALL_SYNTAX = /<\/?(?:invoke|parameter|function_calls|antml:invoke|antml:parameter)\b/i;
    function claimsTool(agent, text) {
        if (!agent || !core.CLI_PROVIDERS[agent.provider]) return false;
        if (agent.tools && agent.tools !== 'none') return false;
        return TOOL_CALL_SYNTAX.test(String(text || ''));
    }

    // Marks a writer turn as in flight, carrying the HEAD it started from, so
    // that leftovers found by a later prepare() can be told apart from the
    // user's own uncommitted work. Cleared once the turn has committed.
    function setWorkspacePending(chatId, pending) {
        const chat = store.getChat(chatId);
        if (!chat || !chat.workspace) return;
        const ws = Object.assign({}, chat.workspace);
        if (pending) ws.pending = pending; else delete ws.pending;
        store.updateChat(chatId, { workspace: ws });
    }

    // Before a run that has workspace seats: the folder must be a git repo,
    // on the chat's branch, with nothing of the user's uncommitted.
    async function prepareWorkspace(chatId, chat, agents) {
        const root = chat.workspace && chat.workspace.root;
        if (!root) return null;
        const seats = agents.filter(a => workspaceFor(chat, a));
        if (!seats.length) return null;
        const branch = chat.workspace.branch || workspace.branchFor(chat.id);
        const r = await workspace.prepare(root, branch, { pending: chat.workspace.pending || null });
        if (!r.ok) throw new Error(r.error);
        if (chat.workspace.pending) setWorkspacePending(chatId, null);
        if (!chat.workspace.branch) store.updateChat(chatId, { workspace: Object.assign({}, chat.workspace, { branch }) });
        note(chatId, `Workspace ${root} on branch ${branch}${r.created ? ` (created from ${r.from})` : ''}${r.wip ? ' — leftover changes from an interrupted turn were committed as WIP' : ''}. Seats with tools: ${seats.map(a => `${a.name} (${a.tools})`).join(', ')}.`);
        return r;
    }

    // Rolling summary (delta mode's "Topic block"): once more than
    // autoSummaryEvery readable messages have accumulated since the last
    // pinned summary, ask the judge (or the first participant) for a fresh
    // one. Runs between rounds so it never interrupts a turn.
    async function maybeAutoSummary(chatId, agents) {
        const chat = store.getChat(chatId);
        if (!chat) return;
        const every = parseInt(chat.autoSummaryEvery, 10) || 0;
        if (every <= 0) return;
        if (core.messagesSinceSummary(chat.messages).length < every) return;
        const judge = chat.judgeProvider ? agentFrom(chat, chat.judgeProvider) : agents[0];
        if (!judge) return;
        emit('multiai-thinking', { chatId, provider: judge.provider, who: judge.name });
        const { brief } = core.briefAndLatest(chat.messages, chat.topic);
        try {
            const result = await sendAux(chat, judge, core.buildSummaryPrompt({ topic: brief, messages: chat.messages }));
            record(chatId, { who: `State summary · ${judge.name} (auto)`, text: result.response, provider: judge.provider, agentId: judge.id, role: 'summary', cycle: chat.cycle || 1, round: 0 });
        } catch (e) {
            note(chatId, `Auto-summary failed: ${e.message}`);
        }
    }

    // Runs `rounds` rounds on a chat using its stored settings. `latestText`
    // is the human message that triggered this cycle (already recorded by the
    // caller) — used only for @mention parsing.
    async function runClassic({ chatId, rounds, latestText, startedBy }) {
        const chat0 = store.getChat(chatId);
        if (!chat0) throw new Error('Chat not found');
        const claimed = workspaceClaimedBy(chatId);
        if (claimed) {
            const other = store.getChat(claimed);
            throw new Error(`Workspace ${chat0.workspace.root} is in use by "${(other && other.title) || claimed}". Wait for that run to finish, or stop it.`);
        }
        const sig = startSignal(chatId, startedBy || 'ui');
        try {
            const enabled = enabledProviders();
            const all = agentsOf(chat0);
            // Browser-route agents need their provider tab enabled in Settings;
            // API and CLI agents don't.
            let agents = all.filter(a => resolveRoute(a) !== 'browser' || enabled.includes(a.provider));
            // Say so in the transcript: the roster still ticks these seats and
            // the composer hint still names them, so dropping them silently is
            // the one way a configured capability can fail with no trace.
            const dropped = all.filter(a => !agents.includes(a));
            if (dropped.length && agents.length) {
                note(chatId, `${dropped.map(a => a.name).join(', ')} ${dropped.length === 1 ? 'is' : 'are'} sitting out — ${dropped.length === 1 ? 'its' : 'their'} provider tab is switched off in Settings.`);
            }
            if (!agents.length) {
                if (all.length) note(chatId, 'No provider tabs are enabled in Settings, so every seat is running on its own route.');
                agents = all.slice();
            }
            if (!agents.length) throw new Error('No participants selected.');
            try { await prepareWorkspace(chatId, chat0, agents); }
            catch (e) {
                // Leave the reason in the transcript, not just a toast.
                record(chatId, { who: 'Workspace', role: 'error', text: e.message, cycle: chat0.cycle || 1, round: 0 });
                throw e;
            }
            const mentions = core.parseMentions(latestText || '', agents);
            const order = mentions.order;
            if (mentions.mentioned.length) {
                note(chatId, `Directed turn: ${mentions.only ? 'only ' : ''}${mentions.mentioned.map(a => a.name).join(', ')}${mentions.only ? '' : ' first'}.`);
            }
            const n = Math.max(1, Math.min(30, rounds || chat0.rounds || 1));
            const token = chat0.stopToken || core.DEFAULTS.stopToken;
            const cycle = chat0.cycle || 1;
            const stopEarly = chat0.stopWhenAllAgree !== false;
            // An agent that fails twice in a row (Perplexity's HTTP 500s, a
            // logged-out tab, a CLI that can't start) is benched for the rest
            // of this run rather than burning a slot — and an error message —
            // every round.
            const failures = {};
            const benched = new Set();
            const noteFailure = (agent, res) => {
                if (res && res.error) {
                    failures[agent.id] = (failures[agent.id] || 0) + 1;
                    if (failures[agent.id] >= 2 && !benched.has(agent.id)) {
                        benched.add(agent.id);
                        note(chatId, `${agent.name} failed twice in a row — skipping it for the rest of this run.`);
                    }
                } else if (res && (res.ok || res.pass)) {
                    failures[agent.id] = 0;
                }
            };
            const active = () => order.filter(a => !benched.has(a.id));
            // Charter mode: a HANDOFF → trailer can pull the named participant
            // forward — next within this round if they haven't spoken yet,
            // otherwise first in the next round.
            let nextFirst = null;
            // A HANDOFF → in the message that triggered this run (the human's,
            // or a local agent's posted via REST/MCP) picks who speaks first.
            if (chat0.charterMode) {
                const readableMsgs = core.readable(chat0.messages);
                const lastMsg = readableMsgs[readableMsgs.length - 1];
                const target = lastMsg ? core.parseHandoff(lastMsg.text, order) : null;
                if (target) nextFirst = target;
            }

            outer:
            for (let r = 1; r <= n; r++) {
                if (sig.cancelled) break;
                emit('multiai-round-start', { chatId, round: r, of: n });
                let turnOrder = active();
                if (!turnOrder.length) { note(chatId, 'No participants left to take a turn.'); break; }
                if (nextFirst && turnOrder.includes(nextFirst)) turnOrder = [nextFirst].concat(turnOrder.filter(a => a !== nextFirst));
                nextFirst = null;
                // Seat rotates over the stable participant order, not the
                // handoff-reordered turn order, so everyone gets it in turn.
                const redTeam = chat0.charterMode ? core.redTeamFor(active(), r) : null;
                if (redTeam) note(chatId, `Round ${r}: ${redTeam.name} holds the red-team seat.`);
                const independent = r === 1 && !!chat0.independentFirstRound && turnOrder.length > 1;
                if (independent) {
                    const results = await Promise.all(turnOrder.map(a => takeTurn(chatId, a, r, { participants: order, independent: true, redTeam })
                        .catch(e => ({ error: e.message }))));
                    results.forEach((res, i) => noteFailure(turnOrder[i], res));
                    if (results.some(x => x && x.cancelled) || sig.cancelled) break outer;
                    const lastHandoff = results.map(x => x && x.handoff).filter(Boolean).pop();
                    if (lastHandoff) nextFirst = lastHandoff;
                } else {
                    const remaining = turnOrder.slice();
                    while (remaining.length) {
                        if (sig.cancelled) break outer;
                        const agent = remaining.shift();
                        const res = await takeTurn(chatId, agent, r, { participants: order, redTeam }).catch(e => ({ error: e.message }));
                        noteFailure(agent, res);
                        if (res && res.cancelled) break outer;
                        if (res && res.handoff) {
                            const target = res.handoff;
                            if (remaining.includes(target)) {
                                remaining.splice(remaining.indexOf(target), 1);
                                remaining.unshift(target);
                                note(chatId, `${agent.name} handed off to ${target.name} — they go next.`);
                            } else if (target !== agent) {
                                nextFirst = target;
                            }
                        }
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
        const judge = agentFrom(chat, judgeProvider);
        emit('multiai-thinking', { chatId, provider: judge.provider, who: judge.name });
        const { brief } = core.briefAndLatest(chat.messages, chat.topic);
        const prompt = core.buildJudgePrompt({ topic: brief, messages: scopedMessages(chat, scope || chat.judgeScope || 'all') });
        try {
            const result = await sendAux(chat, judge, prompt);
            const msg = record(chatId, { who: `Judge · ${judge.name}`, text: result.response, provider: judge.provider, agentId: judge.id, model: result.model || undefined, role: 'judge', cycle: chat.cycle || 1, round: 0 });
            emit('multiai-done', { chatId });
            return { success: true, message: msg };
        } catch (e) {
            record(chatId, { who: 'Judge error', text: e.message, provider: judge.provider, role: 'error', cycle: chat.cycle || 1, round: 0 });
            emit('multiai-done', { chatId });
            return { success: false, error: e.message };
        }
    });

    // Pinned state summary: becomes the compaction point for every later prompt.
    ipcMain.handle('multiai-summarize', async (event, { chatId, provider }) => {
        const chat = store.getChat(chatId);
        if (!chat) return { success: false, error: 'Chat not found' };
        const judge = agentFrom(chat, provider);
        emit('multiai-thinking', { chatId, provider: judge.provider, who: judge.name });
        const { brief } = core.briefAndLatest(chat.messages, chat.topic);
        const prompt = core.buildSummaryPrompt({ topic: brief, messages: chat.messages });
        try {
            const result = await sendAux(chat, judge, prompt);
            const msg = record(chatId, { who: `State summary · ${judge.name}`, text: result.response, provider: judge.provider, agentId: judge.id, role: 'summary', cycle: chat.cycle || 1, round: 0 });
            emit('multiai-done', { chatId });
            return { success: true, message: msg };
        } catch (e) {
            record(chatId, { who: 'Summary error', text: e.message, provider: judge.provider, role: 'error', cycle: chat.cycle || 1, round: 0 });
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
        // Orchestrated steps never run prepareWorkspace, and the Workspace tab
        // is hidden in this mode — so the user cannot see the attached folder,
        // the tools levels, or clear the workspace, while workspaceFor would
        // still honour chat.workspace on every step. Pin every step to
        // tools:'none' rather than let file access run where nothing shows it.
        const raced = await sendAgent(c, { ...agentFrom(c, provider), tools: 'none' }, prompt);
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

    // What the Workspace tab shows for a folder before any run: repo or not,
    // current branch, dirty, and where this chat's branch would start.
    ipcMain.handle('multiai-workspace-info', async (event, { root, chatId } = {}) => {
        try {
            const branch = chatId ? workspace.branchFor(chatId) : null;
            return await workspace.inspect(root, branch);
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('multiai-tools-pick-folder', async () => {
        const w = win();
        try {
            const result = await dialog.showOpenDialog(w || undefined, {
                title: 'Choose a working folder',
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

    // ---- Programmatic API (REST + MCP) ---------------------------------
    // One implementation behind two doors: the REST routes below (for
    // Codex / Claude Code / scripts via HTTP) and the MCP server's
    // multiai_* tools (for Claude Desktop and any MCP client, via the IPC
    // bridge — see handleMCPRequest in main-v2.cjs). Errors carry `status`.
    function apiError(status, message) {
        const e = new Error(message);
        e.status = status;
        return e;
    }

    // Agents as shown to REST/MCP clients: resolved route, no persona text.
    function publicAgents(chat) {
        return agentsOf(chat).map(a => ({ id: a.id, name: a.name, code: a.code, route: resolveRoute(a), provider: a.provider, model: a.model, effort: a.effort, tools: a.tools || 'none' }));
    }

    function withLabels(messages) {
        return (messages || []).map(x => Object.assign({ label: core.refLabel(x) }, x));
    }

    // ---- Variants: model × effort seats on the local CLIs ------------------
    // Shared implementation (electron/providers/variants.cjs); the library is
    // the Multi-AI agent library, CLI routes only.
    const variantsApi = createVariants({
        cli, core, dataDir,
        loadLibrary: () => { const data = store.load(); return data && data.uiPrefs && Array.isArray(data.uiPrefs.agentLibrary) ? data.uiPrefs.agentLibrary : []; },
    });
    const { variants, askVariant, askVariants, variantModels, isVariantModel, completionFor, fromChatBody } = variantsApi;

    const api = {
        running() { return Array.from(runSignals.keys()); },

        listChats() { return store.listChats(); },

        variants,
        askVariant,
        askVariants,
        variantModels,
        isVariantModel,

        createChat(body) {
            body = body || {};
            const fields = {};
            if (body.title) fields.title = String(body.title).slice(0, 120);
            if (Array.isArray(body.participants)) fields.participants = body.participants.map(String);
            if (body.mode === 'classic' || body.mode === 'orchestrated') fields.mode = body.mode;
            if (body.discussMode === 'discuss' || body.discussMode === 'debate') fields.discussMode = body.discussMode;
            if (body.brevity) fields.brevity = String(body.brevity);
            if (core.CONTEXT_MODES.includes(body.contextMode)) fields.contextMode = body.contextMode;
            if (body.charterMode != null) fields.charterMode = !!body.charterMode;
            if (body.independentFirstRound != null) fields.independentFirstRound = !!body.independentFirstRound;
            if (body.stopWhenAllAgree != null) fields.stopWhenAllAgree = !!body.stopWhenAllAgree;
            if (body.stopToken) fields.stopToken = String(body.stopToken).trim().split(/\s+/)[0].slice(0, 20);
            if (body.rounds != null) fields.rounds = Math.max(1, Math.min(30, parseInt(body.rounds, 10) || 1));
            if (body.contextWindow != null) fields.contextWindow = Math.max(0, parseInt(body.contextWindow, 10) || 0);
            if (body.autoSummaryEvery != null) fields.autoSummaryEvery = Math.max(0, parseInt(body.autoSummaryEvery, 10) || 0);
            if (body.engines && typeof body.engines === 'object') fields.engines = body.engines;
            if (Array.isArray(body.agents) && body.agents.length) fields.agents = core.normalizeAgents({ agents: body.agents }, { includeDisabled: true }).map(a => ({ id: a.id, name: a.name, route: a.route, provider: a.provider, model: a.model, effort: a.effort, persona: a.persona || '', enabled: a.enabled !== false, tools: a.tools || 'none' }));
            if (body.workspace && typeof body.workspace === 'object' && body.workspace.root) fields.workspace = { root: String(body.workspace.root) };
            if (body.topic) fields.topic = String(body.topic);
            const created = store.createChat(fields);
            if (body.topic) {
                store.updateChat(created.id, { cycle: 1, title: fields.title || core.localTitle(body.topic) });
                record(created.id, { who: body.who || 'You', role: 'user', text: String(body.topic), cycle: 1, round: 0 });
            }
            const chat = store.getChat(created.id);
            emit('multiai-chat-created', { chat });
            return Object.assign({}, chat, { agents: publicAgents(chat) });
        },

        getChat(chatId, { since, last } = {}) {
            const chat = store.getChat(chatId);
            if (!chat) throw apiError(404, 'Chat not found');
            let messages = chat.messages || [];
            if (since) {
                const i = messages.findIndex(x => x.id === since);
                messages = i === -1 ? messages : messages.slice(i + 1);
            }
            if (last && Number(last) > 0) messages = messages.slice(-Number(last));
            return Object.assign({}, chat, { messages: withLabels(messages), agents: publicAgents(chat), running: isRunning(chatId), totalMessages: (chat.messages || []).length });
        },

        appendMessage(chatId, body) {
            body = body || {};
            const chat = store.getChat(chatId);
            if (!chat) throw apiError(404, 'Chat not found');
            const text = String(body.text || '').trim();
            if (!text) throw apiError(400, 'text is required');
            const role = ['assistant', 'user', 'summary', 'judge', 'system'].includes(body.role) ? body.role : 'assistant';
            const provider = String(body.provider || (role === 'user' ? 'human' : 'external')).toLowerCase();
            const who = String(body.who || (role === 'user' ? 'You' : core.providerLabel(provider))).slice(0, 60);
            if (role === 'user') store.updateChat(chatId, { cycle: (chat.cycle || 0) + 1 });
            const fresh = store.getChat(chatId);
            const saved = record(chatId, { who, text, provider, role, cycle: fresh.cycle || 1, round: role === 'user' ? 0 : (body.round != null ? Number(body.round) : 0) });
            return Object.assign({ label: core.refLabel(saved) }, saved);
        },

        // Optionally records `text` as a message from `who`, then runs rounds.
        // Resolves immediately with {started:true} unless wait:true, in which
        // case it resolves with the messages produced by this cycle.
        async run(chatId, body) {
            body = body || {};
            const chat = store.getChat(chatId);
            if (!chat) throw apiError(404, 'Chat not found');
            if (isRunning(chatId)) throw apiError(409, 'A run is already in progress for this chat');
            // Checked here, synchronously, for the same reason the line above
            // is: the run itself is fire-and-forget without wait:true, so a
            // conflict discovered inside it would come back as {started:true}
            // and the caller would poll /wait forever.
            const claimed = workspaceClaimedBy(chatId);
            if (claimed) throw apiError(409, `Workspace ${chat.workspace.root} is in use by chat ${claimed}`);
            const text = String(body.text || '').trim();
            if (text) {
                store.updateChat(chatId, { cycle: (chat.cycle || 0) + 1, topic: chat.topic || text });
                const fresh = store.getChat(chatId);
                record(chatId, { who: String(body.who || 'You').slice(0, 60), text, provider: body.provider ? String(body.provider).toLowerCase() : 'human', role: 'user', cycle: fresh.cycle, round: 0 });
                if (!chat.messages.length && (chat.title === 'New chat' || !chat.title)) store.updateChat(chatId, { title: core.localTitle(text) });
            } else if (!(chat.cycle || 0)) {
                store.updateChat(chatId, { cycle: 1 });
            }
            const rounds = body.rounds != null ? Number(body.rounds) : undefined;
            // A run that fails before producing anything — the dirty-tree
            // refusal is the realistic case, and it is the feature's headline
            // safety check — used to come back as 200 {messages:[]} with
            // wait:true and 202 {started:true} without, with the reason only in
            // the Electron console. A caller could not tell "the workspace
            // refused" from "the panel had nothing to say".
            let runErr = null;
            const runP = runClassic({ chatId, rounds, latestText: text, startedBy: 'agent' })
                .catch(e => { runErr = e; console.error('[MultiAI] API run failed:', e.message); return []; });
            if (body.wait) {
                const messages = withLabels(await runP);
                if (runErr) throw apiError(runErr.status || 409, runErr.message);
                return { messages };
            }
            // Give a synchronous failure (thrown before the first await inside
            // runClassic) a tick to land, so an immediately-doomed run is not
            // reported as started.
            await Promise.resolve();
            if (runErr) throw apiError(runErr.status || 409, runErr.message);
            return { started: true, chatId };
        },

        stop(chatId) {
            if (!store.getChat(chatId)) throw apiError(404, 'Chat not found');
            return { stopped: stopChat(chatId) };
        },

        // Blocks until the chat's run finishes or `maxMs` elapses; returns the
        // messages after `since` either way plus whether it is still running.
        async waitForRun(chatId, { since, maxMs } = {}) {
            const chat = store.getChat(chatId);
            if (!chat) throw apiError(404, 'Chat not found');
            const deadline = Date.now() + Math.max(1000, Math.min(Number(maxMs) || 45000, 120000));
            while (isRunning(chatId) && Date.now() < deadline) {
                const sig = runSignals.get(chatId);
                await Promise.race([sig ? sig.promise : Promise.resolve(), new Promise(r => setTimeout(r, 500))]);
            }
            const out = api.getChat(chatId, { since });
            return { running: out.running, messages: out.messages };
        },
    };

    // ---- REST: local agents read and append ---------------------------
    // Registered on the existing gateway (port 3210+). Same loopback-only and
    // API-key rules as every other /v1 route. All bodies/results are JSON.
    //
    //   GET  /v1/multiai/chats                      → {chats:[{id,title,mode,agents:[name],participants,messageCount,...}]}
    //   POST /v1/multiai/chats                      {title?, agents?|participants?, mode?, contextMode?, topic?, who?} → {chat}
    //        (agents: [{name?, provider, route?, model?, effort?, persona?}]; participants: legacy provider list)
    //   GET  /v1/multiai/chats/:id[?since=<msgId>&last=<n>]  → {chat} (messages after `since` / only the last n)
    //   POST /v1/multiai/chats/:id/messages         {who, text, role?, provider?} → {message}
    //        (appends a turn from an external agent; nothing is sent to providers)
    //   POST /v1/multiai/chats/:id/run              {text?, who?, rounds?, wait?} → {started} | {messages}
    //   POST /v1/multiai/chats/:id/wait             {since?, maxMs?} → {running, messages}
    //   POST /v1/multiai/chats/:id/stop             → {stopped}
    // A CLI turn can run for twenty minutes. If the caller hangs up, finishing
    // it just burns one of the two slots for that CLI — which chat turns share
    // — on an answer nobody will read, so the turn is aborted with the socket.
    function abortOnDisconnect(res, body) {
        const req = res && res.req;
        return Object.assign({}, body, {
            onStart(handle) {
                if (!req || typeof req.on !== 'function') return;
                const stop = () => { if (!res.writableEnded) { try { handle.abort(); } catch { /* already gone */ } } };
                req.on('aborted', stop);
                req.on('close', stop);
            },
        });
    }

    //   GET  /v1/multiai/running                    → {running:[chatId]}
    if (typeof registerRouteExtension === 'function') {
        registerRouteExtension(async (method, url, body, res, { sendJSON, sendError }) => {
            const p = url.pathname;
            const isCompletionsForVariant = method === 'POST' && p === '/v1/chat/completions' && body && isVariantModel(body.model);
            if (!p.startsWith('/v1/multiai') && !isCompletionsForVariant) return false;
            const m = /^\/v1\/multiai\/chats\/([^/]+)(?:\/(messages|run|stop|wait))?$/.exec(p);
            try {
                if (method === 'GET' && p === '/v1/multiai/running') { sendJSON(res, 200, { running: api.running() }); return true; }
                // ---- variants: local CLI seats over REST ----
                if (method === 'GET' && p === '/v1/multiai/variants') { sendJSON(res, 200, await variants({ probe: url.searchParams.get('probe') === '1' })); return true; }
                if (method === 'POST' && p === '/v1/multiai/variants/ask') { sendJSON(res, 200, await askVariant(abortOnDisconnect(res, body))); return true; }
                if (method === 'POST' && p === '/v1/multiai/variants/ask-many') { sendJSON(res, 200, await askVariants(body)); return true; }
                // OpenAI-compatible: model "cli:opus:max" / "cli:gpt-5.5:high" / a library seat's name → the CLI seat.
                if (isCompletionsForVariant) {
                    const { message, system } = fromChatBody(body);
                    const r = await askVariant(abortOnDisconnect(res, { variant: String(body.model), message, system: body.system || system }));
                    const completion = completionFor(r, String(body.model));
                    if (body.stream === true) {
                        // askVariant above can take many minutes, so the client
                        // is quite likely gone by now; the pre-existing chunked
                        // path guards every write for the same reason.
                        if (res.writableEnded || res.destroyed) return true;
                        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...(res._proximaCors || {}) });
                        const base = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model };
                        res.write(`data: ${JSON.stringify(Object.assign({}, base, { choices: [{ index: 0, delta: { role: 'assistant', content: r.text }, finish_reason: null }] }))}\n\n`);
                        res.write(`data: ${JSON.stringify(Object.assign({}, base, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else sendJSON(res, 200, completion);
                    return true;
                }
                if (method === 'GET' && p === '/v1/multiai/chats') { sendJSON(res, 200, { chats: api.listChats() }); return true; }
                if (method === 'POST' && p === '/v1/multiai/chats') { sendJSON(res, 201, { chat: api.createChat(body) }); return true; }
                if (!m) { sendError(res, 404, 'Unknown multiai route', 'not_found'); return true; }
                const chatId = decodeURIComponent(m[1]);
                const sub = m[2] || '';
                if (method === 'GET' && !sub) {
                    sendJSON(res, 200, { chat: api.getChat(chatId, { since: url.searchParams.get('since'), last: url.searchParams.get('last') }) });
                    return true;
                }
                if (method === 'POST' && sub === 'messages') { sendJSON(res, 201, { message: api.appendMessage(chatId, body) }); return true; }
                if (method === 'POST' && sub === 'run') {
                    const r = await api.run(chatId, body);
                    sendJSON(res, r.started ? 202 : 200, r);
                    return true;
                }
                if (method === 'POST' && sub === 'wait') { sendJSON(res, 200, await api.waitForRun(chatId, body)); return true; }
                if (method === 'POST' && sub === 'stop') { sendJSON(res, 200, api.stop(chatId)); return true; }
                sendError(res, 405, 'Method not allowed', 'method_not_allowed');
                return true;
            } catch (e) {
                sendError(res, e.status || 500, e.message, e.status === 404 ? 'not_found' : e.status === 409 ? 'conflict' : 'api_error');
                return true;
            }
        });
    }

    return api;
}

module.exports = { registerMultiAiHandlers };
