// Proxima — Multi-AI IPC handler tests.
// Drives electron/ipc/multiai.cjs with a fake `electron` and a fake provider
// sender, so the run loop, session routing, convergence, cancellation and the
// REST extension are exercised end-to-end without a BrowserView.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// ---- fakes ----------------------------------------------------------------

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'multiai-handlers-'));
const handlers = new Map();
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const sent = [];          // every webContents.send(channel, payload)
const providerCalls = []; // every sendMessageToProvider(provider, prompt, ..., sessionId)
let replyFn = async (provider, prompt) => `reply from ${provider}`;

const fakeElectron = {
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    app: { getPath: (k) => (k === 'userData' ? userData : userData) },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    shell: { openPath: () => { } },
};
const fakeSender = {
    sendMessageToProvider(provider, message, attachments, onChunk, conversationId) {
        const call = { provider, message, conversationId, at: Date.now() };
        providerCalls.push(call);
        return Promise.resolve().then(async () => {
            const r = await replyFn(provider, message, conversationId);
            call.done = Date.now();
            return { response: r };
        });
    },
};

// Fake local CLIs (Claude Code / Codex) and a fake BYOK subsystem.
const cliCalls = [];
let cliReplyFn = async (provider, opts) => `${provider} says ${opts.model || 'default'}/${opts.effort || 'none'}`;
const fakeCli = {
    availability: () => ({ claude: true, codex: true, gemini: false }),
    resetAvailabilityCache() { },
    discovered: () => null,
    discover: async () => ({ claude: { available: true, version: '2.1.259', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: [{ id: 'opus' }, { id: 'sonnet' }] }, codex: { available: true, version: '0.142.5', models: [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }], defaultModel: 'gpt-5.6-sol', defaultModelListed: false }, gemini: { available: false } }),
    run(provider, opts) {
        const call = { provider, opts, aborted: false };
        cliCalls.push(call);
        let rejectFn;
        const promise = new Promise((resolve, reject) => {
            rejectFn = reject;
            Promise.resolve().then(() => cliReplyFn(provider, opts)).then(text => resolve({ text, model: opts.model || null }), reject);
        });
        return { promise, abort() { call.aborted = true; rejectFn(Object.assign(new Error('Cancelled by user'), { cancelled: true })); } };
    },
};
const byokState = { enabled: false, keys: { chatgpt: 'sk-openai', claude: 'sk-ant' }, selected: { chatgpt: 'gpt-5.5', claude: 'claude-sonnet-5' } };
const byokCalls = [];
const fakeByok = {
    keys: {
        isEnabled: () => byokState.enabled,
        hasKey: (p) => !!byokState.keys[p],
        getKey: (p) => byokState.keys[p] || null,
        getSelectedModel: (p) => byokState.selected[p] || null,
        getModels: (p) => (byokState.selected[p] ? [{ id: byokState.selected[p], enabled: true }] : []),
        // custom endpoints live in the store alongside the keys
        _readStore: () => { const st = { _meta: { enabled: byokState.enabled } }; for (const [k, v] of Object.entries(byokState.keys)) st[k] = Object.assign({ key: v }, byokState.custom && byokState.custom[k] ? byokState.custom[k] : {}); return st; },
    },
    models: { DEFAULT_MODELS: { chatgpt: 'gpt-5.5', claude: 'claude-sonnet-5' } },
    async callProvider(provider, key, messages, options) {
        byokCalls.push({ provider, key, messages, options });
        await delay(5);
        return { text: `${provider} api says ${options.modelId || 'selected'}/${options.reasoningEffort || 'none'}`, model: options.modelId || byokState.selected[provider] };
    },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request.endsWith('providers/sender.cjs')) return fakeSender;
    if (request.endsWith('providers/cli.cjs')) return fakeCli;
    return origLoad.apply(this, arguments);
};
const { registerMultiAiHandlers } = require('../../../electron/ipc/multiai.cjs');
Module._load = origLoad;

const routeExtensions = [];
const multiaiApi = registerMultiAiHandlers({
    mainWindow: () => ({ isDestroyed: () => false, webContents: { send: (ch, p) => sent.push({ ch, p }) } }),
    loadSettings: () => ({ providers: { chatgpt: { enabled: true }, claude: { enabled: true }, gemini: { enabled: true }, perplexity: { enabled: false } } }),
    registerRouteExtension: (fn) => routeExtensions.push(fn),
    byok: fakeByok,
});

const invoke = (ch, payload) => handlers.get(ch)({}, payload);
const core = require('../../../electron/ipc/multiai-core.cjs');
const store = core.createStore({ dir: path.join(userData, 'multiai'), fs, path });

function newChat(fields) {
    return store.createChat(Object.assign({ participants: ['chatgpt', 'claude'], discussMode: 'discuss', brevity: 'max 4 sentences', rounds: 1, cycle: 1 }, fields || {}));
}

function userMsg(chatId, text, cycle = 1) {
    return store.appendMessage(chatId, { who: 'You', role: 'user', text, cycle, round: 0 });
}

function messagesOf(chatId) { return store.getChat(chatId).messages; }

// ---- tests -----------------------------------------------------------------

test('run-round: records one turn per participant per round, on per-chat session ids, and emits them', async () => {
    providerCalls.length = 0; sent.length = 0;
    replyFn = async (p) => `${p} says hi`;
    const chat = newChat({ rounds: 2 });
    userMsg(chat.id, 'Design a widget');
    const r = await invoke('multiai-run-round', { chatId: chat.id, rounds: 2, latestText: 'Design a widget' });
    assert.equal(r.success, true);
    const turns = messagesOf(chat.id).filter(m => m.role === 'assistant');
    assert.equal(turns.length, 4);
    assert.deepEqual(turns.map(t => t.round), [1, 1, 2, 2]);
    assert.ok(providerCalls.every(c => c.conversationId === `multiai:${chat.id}:${c.provider}:1`), 'every call rides the chat- and agent-specific thread');
    assert.ok(sent.filter(e => e.ch === 'multiai-message').length >= 4, 'renderer is notified of each turn');
    assert.ok(sent.some(e => e.ch === 'multiai-done' && e.p.chatId === chat.id));
    // second turn of a participant sees the first round in its prompt
    const claudeR2 = providerCalls.filter(c => c.provider === 'claude')[1];
    assert.ok(claudeR2.message.includes('chatgpt says hi'));
    assert.ok(!claudeR2.message.includes('API failed'), 'errors are never in prompts');
});

test('run-round: stop token from everyone ends the run early; passes are excluded from context', async () => {
    providerCalls.length = 0; sent.length = 0;
    let n = 0;
    replyFn = async (p) => { n++; return n <= 2 ? `${p}: point ${n}` : (p === 'chatgpt' ? 'DONE — ship it' : 'PASS'); };
    const chat = newChat({ rounds: 5 });
    userMsg(chat.id, 'Should we ship?');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 5 });
    const msgs = messagesOf(chat.id);
    assert.equal(msgs.filter(m => m.role === 'assistant').length, 3, 'round 1 (2 turns) + chatgpt DONE in round 2');
    assert.equal(msgs.filter(m => m.role === 'pass').length, 1);
    assert.ok(msgs.some(m => m.role === 'system' && /Converged after round 2/.test(m.text)));
    assert.equal(providerCalls.length, 4, 'no round 3');
});

test('run-round: independent first round runs participants in parallel and blind', async () => {
    providerCalls.length = 0;
    replyFn = async (p) => { await delay(60); return `${p} independent view`; };
    const chat = newChat({ participants: ['chatgpt', 'claude', 'gemini'], independentFirstRound: true, rounds: 2, stopWhenAllAgree: false });
    userMsg(chat.id, 'Positions please');
    const t0 = Date.now();
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 2 });
    const r1 = providerCalls.slice(0, 3);
    assert.ok(Math.max(...r1.map(c => c.at)) - Math.min(...r1.map(c => c.at)) < 40, 'round 1 calls start together');
    assert.ok(r1.every(c => c.message.includes('independent first round')));
    assert.ok(r1.every(c => !c.message.includes('independent view')), 'round 1 prompts contain no same-cycle replies');
    const r2 = providerCalls.slice(3);
    assert.equal(r2.length, 3);
    assert.ok(r2[0].message.includes('claude independent view'), 'round 2 sees round 1');
    assert.ok(Date.now() - t0 < 60 * 6 + 200, 'parallel round is faster than 6 serial calls');
});

test('run-round: @mentions set order and "only" restricts the round', async () => {
    providerCalls.length = 0;
    replyFn = async (p) => `${p} ok`;
    const chat = newChat({ participants: ['chatgpt', 'claude', 'gemini'], rounds: 1, stopWhenAllAgree: false });
    userMsg(chat.id, '@gemini kick off, others react');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1, latestText: '@gemini kick off, others react' });
    assert.deepEqual(providerCalls.map(c => c.provider), ['gemini', 'chatgpt', 'claude']);
    providerCalls.length = 0;
    userMsg(chat.id, 'only @claude answer this', 2);
    store.updateChat(chat.id, { cycle: 2 });
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1, latestText: 'only @claude answer this' });
    assert.deepEqual(providerCalls.map(c => c.provider), ['claude']);
});

test('run-round: engine choice is applied to the provider string (gemini:3.1-pro)', async () => {
    providerCalls.length = 0;
    replyFn = async (p) => `${p} ok`;
    const chat = newChat({ participants: ['gemini'], engines: { gemini: 'gemini:3.1-pro' }, stopWhenAllAgree: false });
    userMsg(chat.id, 'hi');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.equal(providerCalls[0].provider, 'gemini:3.1-pro');
    assert.equal(messagesOf(chat.id).find(m => m.role === 'assistant').provider, 'gemini', 'stored provider is the base name');
});

test('run-round: provider threads rotate after providerResetEvery turns', async () => {
    providerCalls.length = 0;
    replyFn = async (p) => `${p} ok`;
    const chat = newChat({ participants: ['chatgpt'], stopWhenAllAgree: false });
    userMsg(chat.id, 'go');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: core.DEFAULTS.providerResetEvery + 2 });
    const ids = providerCalls.map(c => c.conversationId);
    assert.equal(new Set(ids).size, 2, 'exactly one rotation');
    assert.equal(ids[0], `multiai:${chat.id}:chatgpt:1`);
    assert.equal(ids[ids.length - 1], `multiai:${chat.id}:chatgpt:2`);
});

test('run-round: a provider error is recorded as an error message and the round continues', async () => {
    providerCalls.length = 0;
    replyFn = async (p) => { if (p === 'chatgpt') throw new Error('API failed: HTTP 500'); return `${p} ok`; };
    const chat = newChat({ stopWhenAllAgree: false });
    userMsg(chat.id, 'go');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    const msgs = messagesOf(chat.id);
    assert.ok(msgs.some(m => m.role === 'error' && /HTTP 500/.test(m.text)));
    assert.ok(msgs.some(m => m.role === 'assistant' && m.provider === 'claude'));
    const claudePrompt = providerCalls.find(c => c.provider === 'claude').message;
    assert.ok(!claudePrompt.includes('HTTP 500'));
});

test('run-round: refuses a second concurrent run on the same chat; stop cancels', async () => {
    providerCalls.length = 0;
    let release;
    replyFn = () => new Promise(r => { release = r; });
    const chat = newChat({ stopWhenAllAgree: false });
    userMsg(chat.id, 'slow');
    const running = invoke('multiai-run-round', { chatId: chat.id, rounds: 3 });
    await delay(20);
    const second = await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.equal(second.success, false);
    assert.match(second.error, /already in progress/);
    assert.deepEqual(await invoke('multiai-running'), [chat.id]);
    await invoke('multiai-stop-run', { chatId: chat.id });
    const r = await running;
    assert.equal(r.success, true);
    const msgs = messagesOf(chat.id);
    assert.ok(msgs.some(m => m.role === 'error' && /stopped/i.test(m.who)));
    assert.ok(msgs.some(m => m.role === 'system' && /Run stopped/.test(m.text)));
    assert.deepEqual(await invoke('multiai-running'), []);
    release('late reply');   // the abandoned provider call resolving later must not add a message
    await delay(10);
    assert.equal(messagesOf(chat.id).filter(m => m.role === 'assistant').length, 0);
});

test('judge: scope "round" uses the last round of the current cycle, not a round number across cycles', async () => {
    providerCalls.length = 0;
    replyFn = async () => 'verdict';
    const chat = newChat({ cycle: 2 });
    store.appendMessage(chat.id, { who: 'You', role: 'user', text: 'c1', cycle: 1, round: 0 });
    for (let r = 1; r <= 5; r++) store.appendMessage(chat.id, { who: 'chatgpt', provider: 'chatgpt', role: 'assistant', text: `cycle1 round${r}`, cycle: 1, round: r });
    store.appendMessage(chat.id, { who: 'You', role: 'user', text: 'c2', cycle: 2, round: 0 });
    store.appendMessage(chat.id, { who: 'claude', provider: 'claude', role: 'assistant', text: 'cycle2 round1 ONLY', cycle: 2, round: 1 });
    await invoke('multiai-judge', { chatId: chat.id, judgeProvider: 'claude', scope: 'round' });
    const prompt = providerCalls[0].message;
    assert.ok(prompt.includes('cycle2 round1 ONLY'));
    assert.ok(!prompt.includes('cycle1 round5'));
    assert.ok(providerCalls[0].conversationId.startsWith(`multiai:${chat.id}:aux:`), 'judge uses a fresh aux thread');
    assert.ok(messagesOf(chat.id).some(m => m.role === 'judge' && m.text === 'verdict'));
});

test('summarize: stores a summary message that later prompts start from', async () => {
    providerCalls.length = 0;
    replyFn = async (p, prompt) => prompt.includes('note-taker') ? 'DECISIONS: use koji.' : `${p} after summary`;
    const chat = newChat({ stopWhenAllAgree: false });
    userMsg(chat.id, 'the brief');
    store.appendMessage(chat.id, { who: 'chatgpt', provider: 'chatgpt', role: 'assistant', text: 'ANCIENT ARGUMENT', cycle: 1, round: 1 });
    const s = await invoke('multiai-summarize', { chatId: chat.id, provider: 'claude' });
    assert.equal(s.success, true);
    assert.ok(messagesOf(chat.id).some(m => m.role === 'summary' && /koji/.test(m.text)));
    providerCalls.length = 0;
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    const prompt = providerCalls[0].message;
    assert.ok(prompt.includes('DECISIONS: use koji'));
    assert.ok(!prompt.includes('ANCIENT ARGUMENT'), 'pre-summary transcript is compacted away');
});

test('orchestrated crew: steps are recorded as messages and a failed role stops the pipeline', async () => {
    providerCalls.length = 0;
    replyFn = async (p) => { if (p === 'claude') throw new Error('timed out'); return `${p} output`; };
    const chat = newChat({ mode: 'orchestrated', strategy: 'crew' });
    userMsg(chat.id, 'write a brief');
    const r = await invoke('multiai-run-orchestrated', {
        chatId: chat.id, strategy: 'crew', task: 'write a brief',
        agents: [{ role: 'Researcher', provider: 'chatgpt', instruction: 'research' }, { role: 'Writer', provider: 'claude', instruction: 'write' }, { role: 'Reviewer', provider: 'gemini', instruction: 'review' }],
    });
    assert.equal(r.success, true);
    const msgs = messagesOf(chat.id);
    assert.ok(msgs.some(m => m.role === 'assistant' && /Researcher/.test(m.who) && m.round === 1));
    assert.ok(msgs.some(m => m.role === 'error' && /Writer/.test(m.who) && /timed out/.test(m.text)));
    assert.ok(!msgs.some(m => /Reviewer/.test(m.who)), 'reviewer never ran on stale input');
    assert.equal(providerCalls.length, 2);
});

test('REST: list, create, append, read since, run (wait) and stop', async () => {
    providerCalls.length = 0;
    replyFn = async (p) => `${p} via rest`;
    const ext = routeExtensions[0];
    assert.equal(typeof ext, 'function');
    const calls = [];
    const res = {};
    const helpers = { sendJSON: (r, code, data) => calls.push({ code, data }), sendError: (r, code, msg) => calls.push({ code, error: msg }) };
    const url = (p, q) => Object.assign(new URL(`http://127.0.0.1:3210${p}`), q ? { search: q } : {});

    assert.equal(await ext('GET', url('/v1/chat/completions'), {}, res, helpers), false, 'non-multiai routes fall through');

    await ext('POST', url('/v1/multiai/chats'), { title: 'from codex', participants: ['chatgpt'], topic: 'Codex opens the floor', who: 'Codex' }, res, helpers);
    const created = calls.pop();
    assert.equal(created.code, 201);
    const id = created.data.chat.id;
    assert.equal(created.data.chat.messages[0].role, 'user');

    await ext('GET', url('/v1/multiai/chats'), {}, res, helpers);
    assert.ok(calls.pop().data.chats.some(c => c.id === id));

    await ext('POST', url(`/v1/multiai/chats/${id}/messages`), { who: 'Codex', provider: 'codex', text: 'I ran the backtest: VERIFIED path=results.csv' }, res, helpers);
    const appended = calls.pop();
    assert.equal(appended.code, 201);
    assert.equal(appended.data.message.label.slice(-2), 'CX');

    await ext('POST', url(`/v1/multiai/chats/${id}/run`), { rounds: 1, wait: true }, res, helpers);
    const ran = calls.pop();
    assert.equal(ran.code, 200);
    assert.equal(ran.data.messages.filter(m => m.role === 'assistant').length, 1);
    assert.ok(providerCalls[0].message.includes('VERIFIED path=results.csv'), 'the browser AI sees the local agent\'s turn');

    await ext('GET', url(`/v1/multiai/chats/${id}`, `?since=${appended.data.message.id}`), {}, res, helpers);
    const since = calls.pop();
    assert.equal(since.code, 200);
    assert.ok(since.data.chat.messages.every(m => m.id !== appended.data.message.id));
    assert.equal(since.data.chat.running, false);

    await ext('POST', url(`/v1/multiai/chats/nope/stop`), {}, res, helpers);
    assert.equal(calls.pop().code, 404);
    await ext('POST', url(`/v1/multiai/chats/${id}/stop`), {}, res, helpers);
    assert.equal(calls.pop().data.stopped, false);
});

test('delete-chat removes it; snapshot save afterwards does not resurrect it', async () => {
    const chat = newChat();
    const snapshot = store.load();
    const r = await invoke('multiai-delete-chat', { chatId: chat.id });
    assert.equal(r.success, true);
    await invoke('multiai-save', snapshot);
    assert.equal(store.getChat(chat.id), null, 'tombstone keeps a stale snapshot from resurrecting the chat');
});

test('delta mode: first turn is a full catch-up, later turns carry only unseen messages; rotation re-sends a catch-up', async () => {
    providerCalls.length = 0;
    let k = 0;
    replyFn = async (p) => `${p} reply ${++k}`;
    const chat = newChat({ contextMode: 'delta', stopWhenAllAgree: false });
    userMsg(chat.id, 'Delta brief');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 2 });
    const cg = providerCalls.filter(c => c.provider === 'chatgpt');
    assert.equal(cg.length, 2);
    assert.ok(cg[0].message.includes('Recent messages (verbatim)'), 'first turn on a fresh thread is a catch-up');
    assert.ok(cg[1].message.includes('New messages since your last turn'));
    assert.ok(cg[1].message.includes('claude reply 2'), 'sees the other participant\'s round-1 reply');
    assert.ok(!cg[1].message.includes('chatgpt reply 1'), 'does not get its own reply back');
    assert.ok(!cg[1].message.includes('Delta brief\n') || !cg[1].message.includes('Recent messages'), 'no full transcript on a delta turn');
    const st = store.getChat(chat.id).providerSessions.chatgpt;
    assert.ok(st.lastId, 'anchor stored');

    // force a rotation: pretend the thread hit its bound
    store.updateChat(chat.id, (c) => { c.providerSessions.chatgpt.turns = core.DEFAULTS.providerResetEveryDelta; });
    providerCalls.length = 0;
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    const rot = providerCalls.find(c => c.provider === 'chatgpt');
    assert.ok(rot.conversationId.endsWith(':2'), 'new provider thread');
    assert.ok(rot.message.includes('Recent messages (verbatim)'), 'catch-up after rotation');
});

test('full mode: the entire transcript is sent every turn', async () => {
    providerCalls.length = 0;
    replyFn = async (p) => `${p} full reply`;
    const chat = newChat({ contextMode: 'full', stopWhenAllAgree: false, contextWindow: 1 });
    userMsg(chat.id, 'Full brief');
    for (let i = 0; i < 6; i++) store.appendMessage(chat.id, { who: 'claude', provider: 'claude', role: 'assistant', text: `OLD MESSAGE ${i}`, cycle: 1, round: 1 });
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    const p = providerCalls[0].message;
    assert.ok(p.includes('Conversation so far (complete)'));
    for (let i = 0; i < 6; i++) assert.ok(p.includes(`OLD MESSAGE ${i}`), 'nothing condensed in full mode');
});

test('delta mode: rolling auto-summary is refreshed after enough new messages', async () => {
    providerCalls.length = 0;
    replyFn = async (p, prompt) => prompt.includes('note-taker') ? 'AUTO SUMMARY TEXT' : `${p} chat`;
    const chat = newChat({ contextMode: 'delta', autoSummaryEvery: 3, stopWhenAllAgree: false, judgeProvider: 'gemini' });
    userMsg(chat.id, 'brief');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 2 });
    const msgs = messagesOf(chat.id);
    const summaries = msgs.filter(m => m.role === 'summary');
    assert.ok(summaries.length >= 1, 'a summary was pinned automatically');
    assert.ok(summaries[0].who.includes('auto'));
    assert.ok(providerCalls.some(c => c.provider === 'gemini' && c.conversationId.includes(':aux:')), 'summary used the judge provider on an aux thread');
    const lastTurn = providerCalls.filter(c => c.provider !== 'gemini').pop();
    assert.ok(lastTurn.message.includes('AUTO SUMMARY TEXT'), 'later turns carry the rolling summary');
});

test('delta mode: a provider error forces a fresh generation and a catch-up next turn', async () => {
    providerCalls.length = 0;
    let fail = true;
    replyFn = async (p) => { if (p === 'gemini' && fail) { fail = false; throw new Error('Gemini API error (500)'); } return `${p} ok`; };
    const chat = newChat({ participants: ['gemini', 'claude'], contextMode: 'delta', stopWhenAllAgree: false });
    userMsg(chat.id, 'delta after error');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 2 });
    const gm = providerCalls.filter(c => c.provider === 'gemini');
    assert.equal(gm.length, 2);
    assert.ok(gm[0].conversationId.endsWith(':1') && gm[1].conversationId.endsWith(':2'), 'new thread after the error');
    assert.ok(gm[1].message.includes('Recent messages (verbatim)'), 'catch-up, not a delta, into the new thread');
});

test('aux thread is reused across judge/summary calls and rotated after a few uses', async () => {
    providerCalls.length = 0;
    replyFn = async (p, prompt) => prompt.includes('note-taker') ? 'S' : 'V';
    const chat = newChat({ stopWhenAllAgree: false });
    userMsg(chat.id, 'x');
    store.appendMessage(chat.id, { who: 'claude', provider: 'claude', role: 'assistant', text: 'point', cycle: 1, round: 1 });
    for (let i = 0; i < 7; i++) await invoke('multiai-summarize', { chatId: chat.id, provider: 'chatgpt' });
    const ids = providerCalls.map(c => c.conversationId);
    assert.equal(new Set(ids).size, 2, 'one rotation in seven aux calls');
    assert.ok(ids.every(id => id.includes(':aux:')));
});

test('a participant failing twice in a row is benched for the rest of the run', async () => {
    providerCalls.length = 0;
    replyFn = async (p) => { if (p === 'chatgpt') throw new Error('HTTP Error 500'); return `${p} fine`; };
    const chat = newChat({ participants: ['chatgpt', 'claude'], stopWhenAllAgree: false });
    userMsg(chat.id, 'bench test');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 4 });
    assert.equal(providerCalls.filter(c => c.provider === 'chatgpt').length, 2, 'not called after the second failure');
    assert.equal(providerCalls.filter(c => c.provider === 'claude').length, 4);
    const msgs = messagesOf(chat.id);
    assert.ok(msgs.some(m => m.role === 'system' && /ChatGPT failed twice in a row/.test(m.text)));
});

test('stop: aborts the in-flight provider call and skips queued ones', async () => {
    providerCalls.length = 0;
    fakeSender.abortActive = async (base, sessionId) => { fakeSender.aborted = (fakeSender.aborted || []).concat([`${base}|${sessionId}`]); return true; };
    let release;
    replyFn = () => new Promise(r => { release = r; });
    const chat = newChat({ participants: ['chatgpt', 'claude'], stopWhenAllAgree: false });
    userMsg(chat.id, 'abort me');
    const running = invoke('multiai-run-round', { chatId: chat.id, rounds: 2 });
    await delay(20);
    await invoke('multiai-stop-run', { chatId: chat.id });
    await running;
    assert.deepEqual(fakeSender.aborted, [`chatgpt|multiai:${chat.id}:chatgpt:1`], 'exactly the active call was aborted, by its session id');
    assert.equal(providerCalls.length, 1, 'no further participant was called after Stop');
    release('late');
    delete fakeSender.abortActive; delete fakeSender.aborted;
});

test('charter mode: HANDOFF → reorders the round, carries into the next round, and the red-team seat rotates', async () => {
    providerCalls.length = 0;
    replyFn = async (p, prompt) => {
        if (p === 'chatgpt' && !prompt.includes('gemini said')) return 'Proposal X. UNVERIFIED.\n\nHANDOFF → Gemini: check it';
        if (p === 'gemini') return 'gemini said: checked, VERIFIED [ran test].\n\nHANDOFF → Claude: your view';
        if (p === 'claude') return 'claude view.\n\nHANDOFF → Gemini: verify again';
        return `${p} view.\n\nOPEN → next?`;
    };
    const chat = newChat({ participants: ['chatgpt', 'claude', 'gemini'], charterMode: true, stopWhenAllAgree: false });
    userMsg(chat.id, 'charter test');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 2 });
    const order = providerCalls.map(c => c.provider);
    assert.deepEqual(order.slice(0, 3), ['chatgpt', 'gemini', 'claude'], 'gemini pulled forward by the handoff');
    assert.deepEqual(order.slice(3), ['gemini', 'claude', 'chatgpt'], 'round 2 starts with the participant handed off to at the end of round 1 (who had already spoken)');
    const msgs = messagesOf(chat.id);
    assert.ok(msgs.some(m => m.role === 'system' && /handed off to Gemini/.test(m.text)));
    assert.ok(msgs.some(m => m.role === 'system' && /Round 1: ChatGPT holds the red-team seat/.test(m.text)));
    assert.ok(msgs.some(m => m.role === 'system' && /Round 2: Claude holds the red-team seat/.test(m.text)));
    const redTeamPrompts = providerCalls.filter(c => c.message.includes('RED-TEAM seat'));
    assert.equal(redTeamPrompts.length, 2, 'exactly one red-team prompt per round');
    assert.ok(providerCalls.every(c => c.message.includes('VERIFIED [who/how/path]')));
});

test('charter mode: a HANDOFF → in a local agent\'s posted message picks who speaks first', async () => {
    providerCalls.length = 0;
    replyFn = async (p) => `${p} reply.\n\nOPEN → next?`;
    const chat = newChat({ participants: ['chatgpt', 'claude', 'gemini'], charterMode: true, stopWhenAllAgree: false });
    userMsg(chat.id, 'brief');
    store.appendMessage(chat.id, { who: 'Codex', provider: 'codex', role: 'assistant', text: 'VERIFIED [ran it]: numbers attached.\n\nHANDOFF → Gemini: sanity-check them', cycle: 1, round: 0 });
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.deepEqual(providerCalls.map(c => c.provider), ['gemini', 'chatgpt', 'claude']);
});


test('agents: same provider twice with different models/efforts, API route when Settings has API mode on', async () => {
    providerCalls.length = 0; byokCalls.length = 0;
    byokState.enabled = true;
    const chat = newChat({
        participants: [],
        agents: [
            { name: 'GPT high', provider: 'chatgpt', model: 'gpt-5.5', effort: 'high' },
            { name: 'GPT low', provider: 'chatgpt', model: 'gpt-5.5', effort: 'low' },
            { name: 'Claude tab', provider: 'claude', route: 'browser' },
        ],
        stopWhenAllAgree: false,
    });
    userMsg(chat.id, '@gpt-low you start');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1, latestText: '@gpt-low you start' });
    assert.equal(byokCalls.length, 2, 'both GPT agents went through the API');
    assert.deepEqual(byokCalls.map(c => c.options.reasoningEffort), ['low', 'high'], 'mention put GPT low first; efforts are per agent');
    assert.ok(byokCalls.every(c => c.provider === 'chatgpt' && c.key === 'sk-openai' && c.options.modelId === 'gpt-5.5'));
    assert.equal(providerCalls.length, 1, 'the explicit browser-route agent used the tab');
    assert.equal(providerCalls[0].provider, 'claude');
    const msgs = messagesOf(chat.id).filter(m => m.role === 'assistant');
    assert.deepEqual(msgs.map(m => m.who), ['GPT low', 'GPT high', 'Claude tab']);
    assert.deepEqual(msgs.map(m => m.code), ['GL', 'GH', 'CL']);
    assert.ok(msgs[0].agentId && msgs[0].route === 'api' && msgs[2].route === 'browser');
    assert.ok(byokCalls[1].messages[0].content.includes('GPT low'), 'the second agent sees the first by name');
    byokState.enabled = false;
});

test('agents: on the auto route a browser-only model (Gemini engine) is not sent to the API; an explicit api route trusts the typed model', async () => {
    providerCalls.length = 0; byokCalls.length = 0;
    byokState.enabled = true;
    byokState.keys.gemini = 'AIza'; byokState.selected.gemini = 'gemini-3.1-pro';
    const chat = newChat({ participants: [], agents: [
        { name: 'Gem auto', provider: 'gemini', model: '3.1-pro' },
        { name: 'Gem api', provider: 'gemini', route: 'api', model: 'gemini-3.1-flash' },
        { name: 'GPT listed', provider: 'chatgpt', model: 'gpt-5.5' },
    ], stopWhenAllAgree: false });
    userMsg(chat.id, 'go');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.deepEqual(byokCalls.map(c => c.options.modelId), [undefined, 'gemini-3.1-flash', 'gpt-5.5']);
    delete byokState.keys.gemini; delete byokState.selected.gemini;
    byokState.enabled = false;
});

test('agents: a roster agent switched off takes no turn, is not listed to the others, and is hidden from REST/MCP readers', async () => {
    providerCalls.length = 0; byokCalls.length = 0;
    const chat = newChat({ participants: [], agents: [
        { name: 'Bull', provider: 'chatgpt' }, { name: 'Bear', provider: 'chatgpt', enabled: false }, { name: 'Ref', provider: 'claude' },
    ], stopWhenAllAgree: false });
    userMsg(chat.id, '@bear you first');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.deepEqual(providerCalls.map(c => c.provider), ['chatgpt', 'claude'], 'only enabled agents took turns; the @bear mention was ignored');
    assert.ok(!providerCalls[0].message.includes('Bear'), 'the disabled agent is not introduced as a participant');
    const calls = [];
    const helpers = { sendJSON: (r, code, data) => calls.push({ code, data }), sendError: (r, code, msg) => calls.push({ code, error: msg }) };
    await routeExtensions[0]('GET', new URL(`http://127.0.0.1:3210/v1/multiai/chats/${chat.id}`), {}, {}, helpers);
    assert.deepEqual(calls.pop().data.chat.agents.map(a => a.id), ['bull', 'ref'], 'REST/MCP readers see the active roster');
    await routeExtensions[0]('POST', new URL('http://127.0.0.1:3210/v1/multiai/chats'), { agents: [{ provider: 'chatgpt', name: 'On' }, { provider: 'claude', name: 'Off', enabled: false }] }, {}, helpers);
    const created = calls.pop().data.chat;
    assert.deepEqual(created.agents.map(a => a.id), ['on'], 'a disabled agent can be created via REST and stays off');
    assert.equal(store.getChat(created.id).agents.length, 2, 'but it is kept in the stored roster');
});

test('agents: with API mode off in Settings, auto agents fall back to the browser tab; model becomes the Gemini engine', async () => {
    providerCalls.length = 0; byokCalls.length = 0;
    byokState.enabled = false;
    const chat = newChat({ participants: [], agents: [{ name: 'GPT', provider: 'chatgpt', effort: 'high' }, { name: 'Gem pro', provider: 'gemini', model: '3.1-pro' }], stopWhenAllAgree: false });
    userMsg(chat.id, 'go');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.equal(byokCalls.length, 0);
    assert.deepEqual(providerCalls.map(c => c.provider), ['chatgpt', 'gemini:3.1-pro']);
    assert.ok(providerCalls[0].conversationId.includes(':gpt:'));
});

test('agents: CLI agents run through the local CLI with model + effort; Stop kills the process', async () => {
    cliCalls.length = 0;
    cliReplyFn = async (p, o) => `${p} ${o.model}/${o.effort}`;
    const chat = newChat({ participants: [], agents: [{ name: 'Opus · high', provider: 'claude-cli', model: 'opus', effort: 'high' }, { name: 'Codex 5.5', provider: 'codex-cli', model: 'gpt-5.5', effort: 'medium' }], stopWhenAllAgree: false });
    userMsg(chat.id, 'cli test');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.deepEqual(cliCalls.map(c => [c.provider, c.opts.model, c.opts.effort]), [['claude-cli', 'opus', 'high'], ['codex-cli', 'gpt-5.5', 'medium']]);
    const msgs = messagesOf(chat.id).filter(m => m.role === 'assistant');
    assert.deepEqual(msgs.map(m => m.who), ['Opus · high', 'Codex 5.5']);
    assert.deepEqual(msgs.map(m => m.code), ['OH', 'CX']);
    assert.ok(cliCalls[1].opts.prompt.includes('Opus · high'), 'second CLI agent sees the first');

    // Stop mid-call
    cliCalls.length = 0;
    let release;
    cliReplyFn = () => new Promise(r => { release = r; });
    store.updateChat(chat.id, { cycle: 2 });
    userMsg(chat.id, 'again', 2);
    const running = invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    await delay(20);
    await invoke('multiai-stop-run', { chatId: chat.id });
    await running;
    assert.equal(cliCalls[0].aborted, true, 'the in-flight CLI process was killed');
    assert.equal(cliCalls.length, 1, 'the queued agent never started');
    release && release('late');
});

test('routes: multiai-routes reports Settings API mode, selected models and CLI availability', async () => {
    byokState.enabled = true;
    const r = await invoke('multiai-routes', { probe: true });
    assert.equal(r.apiMode, true);
    assert.equal(r.providers.chatgpt.hasKey, true);
    assert.equal(r.providers.chatgpt.model, 'gpt-5.5');
    assert.equal(r.providers.gemini.hasKey, false);
    assert.deepEqual(r.cli, { claude: true, codex: true, gemini: false });
    assert.equal(r.cliInfo.codex.version, '0.142.5', 'discovery (versions, models, efforts) rides along for the editor');
    assert.deepEqual(r.cliInfo.codex.models.map(m => m.id), ['gpt-5.5']);
    byokState.enabled = false;
});

test('agents: a gemini-cli agent runs through the Gemini CLI kind with no effort', async () => {
    cliCalls.length = 0;
    cliReplyFn = async (p, o) => `${p} ${o.model}`;
    const chat = newChat({ participants: [], agents: [{ name: 'Gem CLI', provider: 'gemini-cli', model: 'gemini-3.1-pro', effort: 'high' }], stopWhenAllAgree: false });
    userMsg(chat.id, 'go');
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.equal(cliCalls.length, 1);
    assert.equal(cliCalls[0].provider, 'gemini-cli');
    assert.equal(cliCalls[0].opts.model, 'gemini-3.1-pro');
    const m = messagesOf(chat.id).filter(x => x.role === 'assistant')[0];
    assert.deepEqual([m.who, m.code, m.route], ['Gem CLI', 'GC', 'cli']);
});

test('legacy participants still work and judge can be an agent id', async () => {
    providerCalls.length = 0;
    replyFn = async () => 'verdict';
    const chat = newChat({ participants: ['chatgpt', 'claude'], judgeProvider: 'claude' });
    userMsg(chat.id, 'x');
    await invoke('multiai-judge', { chatId: chat.id, judgeProvider: 'claude', scope: 'all' });
    const j = messagesOf(chat.id).find(m => m.role === 'judge');
    assert.ok(j && j.who === 'Judge · Claude');
});

test('variants: library CLI agents + discovery; askVariant resolves names, shorthand and overrides, and runs one-shot through the CLI', async () => {
    cliCalls.length = 0;
    cliReplyFn = async (p, o) => `${p} ${o.model || 'default'}/${o.effort || 'none'}`;
    // seed a library with one CLI agent and one browser agent
    const data = store.load();
    data.uiPrefs = { agentLibrary: [
        { uid: 'u1', name: 'Opus max', provider: 'claude-cli', model: 'opus', effort: 'max', persona: 'Be terse.' },
        { uid: 'u2', name: 'Claude tab', provider: 'claude', route: 'browser' },
    ] };
    store.save(data);
    const v = await multiaiApi.variants();
    assert.deepEqual(v.library.map(x => [x.id, x.provider, x.model, x.effort, x.persona]), [['opus-max', 'claude-cli', 'opus', 'max', true]], 'only CLI agents are variants');
    assert.equal(v.cli.codex.version, '0.142.5');

    const byName = await multiaiApi.askVariant({ variant: 'Opus max', message: 'hi' });
    assert.deepEqual([byName.variant, byName.provider, byName.model, byName.effort], ['Opus max', 'claude-cli', 'opus', 'max']);
    assert.ok(cliCalls[0].opts.systemPrompt.includes('[Persona]') && cliCalls[0].opts.systemPrompt.includes('Be terse.'), 'the library persona rides along as system prompt');
    assert.equal(cliCalls[0].opts.prompt, 'hi');

    const short = await multiaiApi.askVariant({ variant: 'gpt-5.5:high', message: 'hi' });
    assert.deepEqual([short.provider, short.model, short.effort], ['codex-cli', 'gpt-5.5', 'high'], 'gpt* shorthand → Codex');
    await assert.rejects(multiaiApi.askVariant({ variant: 'gemini-3.1-pro', message: 'hi' }), /Gemini CLI is not installed/, 'gemini* shorthand → Gemini CLI, which this harness reports as absent');
    const over = await multiaiApi.askVariant({ variant: 'sonnet:low', effort: 'xhigh', system: 'Custom system.', message: 'hi' });
    assert.deepEqual([over.provider, over.model, over.effort], ['claude-cli', 'sonnet', 'xhigh'], 'explicit effort overrides the shorthand');
    assert.ok(cliCalls[cliCalls.length - 1].opts.systemPrompt.includes('Custom system.'), 'the caller system prompt is kept');
    assert.ok(/never emit tool-call syntax/i.test(cliCalls[cliCalls.length - 1].opts.systemPrompt), 'the no-tools clause survives a caller override');
    const plain = await multiaiApi.askVariant({ provider: 'codex-cli', model: 'gpt-5.4', message: 'hi' });
    assert.equal(plain.model, 'gpt-5.4');

    await assert.rejects(multiaiApi.askVariant({ variant: 'nope such thing', message: 'hi' }), /Unknown variant/);
    await assert.rejects(multiaiApi.askVariant({ provider: 'chatgpt', message: 'hi' }), /provider must be/);
    await assert.rejects(multiaiApi.askVariant({ variant: 'opus', message: '' }), /message is required/);
});

test('REST: variants list, ask, ask-many, and OpenAI-compatible /v1/chat/completions with a cli: model (json + SSE)', async () => {
    cliCalls.length = 0;
    cliReplyFn = async (p, o) => `${p} ${o.model || 'default'}/${o.effort || 'none'}`;
    const data = store.load();
    data.uiPrefs = { agentLibrary: [{ uid: 'u1', name: 'Opus max', provider: 'claude-cli', model: 'opus', effort: 'max' }] };
    store.save(data);
    const ext = routeExtensions[0];
    const calls = [];
    const helpers = { sendJSON: (r, code, d) => calls.push({ code, data: d }), sendError: (r, code, msg) => calls.push({ code, error: msg }) };
    const url = (p, q) => Object.assign(new URL(`http://127.0.0.1:3210${p}`), q ? { search: q } : {});

    assert.equal(await ext('GET', url('/v1/multiai/variants'), {}, {}, helpers), true);
    let r = calls.pop();
    assert.equal(r.code, 200);
    assert.deepEqual(r.data.library.map(v => v.id), ['opus-max']);
    assert.equal(r.data.cli.codex.version, '0.142.5');

    await ext('POST', url('/v1/multiai/variants/ask'), { variant: 'gpt-5.5:high', message: 'hi' }, {}, helpers);
    r = calls.pop();
    assert.deepEqual([r.code, r.data.provider, r.data.model, r.data.effort, r.data.text], [200, 'codex-cli', 'gpt-5.5', 'high', 'codex-cli gpt-5.5/high']);

    await ext('POST', url('/v1/multiai/variants/ask-many'), { variants: ['Opus max', 'gemini-2.5-flash'], message: 'hi' }, {}, helpers);
    r = calls.pop();
    assert.deepEqual(r.data.results.map(x => x.ok), [true, false]);

    // OpenAI-compatible: a "cli:" model is claimed by the extension; other models fall through
    assert.equal(await ext('POST', url('/v1/chat/completions'), { model: 'gemini:3.1-pro', messages: [{ role: 'user', content: 'hi' }] }, {}, helpers), false, 'browser-route models are not ours');
    assert.equal(await ext('POST', url('/v1/chat/completions'), { model: 'cli:opus:max', messages: [{ role: 'system', content: 'Terse.' }, { role: 'user', content: 'why?' }] }, {}, helpers), true);
    r = calls.pop();
    assert.equal(r.data.object, 'chat.completion');
    assert.equal(r.data.model, 'cli:opus:max');
    assert.equal(r.data.choices[0].message.content, 'claude-cli opus/max');
    assert.ok(cliCalls[cliCalls.length - 1].opts.systemPrompt.includes('Terse.'), 'system messages are folded into the system prompt');
    assert.ok(/never emit tool-call syntax/i.test(cliCalls[cliCalls.length - 1].opts.systemPrompt), 'the no-tools clause survives an OpenAI-style system message');
    assert.equal(cliCalls[cliCalls.length - 1].opts.prompt, 'why?');
    assert.equal(await ext('POST', url('/v1/chat/completions'), { model: 'Opus max', messages: [{ role: 'user', content: 'hi' }] }, {}, helpers), true, 'a library seat name works as the model');
    calls.pop();

    // streaming: a single content chunk, a stop chunk, [DONE]
    const written = [];
    const res = { writeHead: (code, headers) => written.push({ code, headers }), write: (s) => written.push(s), end: () => written.push('END') };
    assert.equal(await ext('POST', url('/v1/chat/completions'), { model: 'cli:gpt-5.5:low', stream: true, messages: [{ role: 'user', content: 'hi' }] }, res, helpers), true);
    assert.equal(written[0].code, 200);
    assert.match(written[0].headers['Content-Type'], /text\/event-stream/);
    assert.match(written[1], /"delta":\{"role":"assistant","content":"codex-cli gpt-5\.5\/low"\}/);
    assert.match(written[2], /"finish_reason":"stop"/);
    assert.equal(written[3], 'data: [DONE]\n\n');
    assert.equal(written[4], 'END');

    // variantModels for GET /v1/models
    const models = multiaiApi.variantModels();
    assert.ok(models.some(m => m.id === 'cli:opus-max' && m.provider === 'claude-cli'));
});

test('local-model seats: a custom OpenAI-compatible endpoint is an api-only seat, works with API mode off, needs a model', async () => {
    byokCalls.length = 0; providerCalls.length = 0;
    byokState.enabled = false;
    byokState.keys.ollama = 'local-no-key';
    byokState.custom = { ollama: { endpoint: 'http://127.0.0.1:11434/v1/chat/completions', displayName: 'Ollama' } };
    try {
        const r = await invoke('multiai-routes', {});
        assert.deepEqual([r.providers.ollama.apiOnly, r.providers.ollama.custom, r.providers.ollama.label, r.providers.ollama.hasKey], [true, true, 'Ollama', true]);
        assert.equal(r.providers.chatgpt.apiOnly, undefined, 'browser providers are not api-only');

        const chat = newChat({ participants: [], agents: [
            { name: 'Llama', provider: 'ollama', model: 'llama3.2' },
            { name: 'GPT tab', provider: 'chatgpt' },
        ], stopWhenAllAgree: false });
        userMsg(chat.id, 'go');
        await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
        assert.equal(byokCalls.length, 1, 'the local seat went through the API even though API mode is off');
        assert.deepEqual([byokCalls[0].provider, byokCalls[0].key, byokCalls[0].options.modelId], ['ollama', 'local-no-key', 'llama3.2']);
        assert.deepEqual(providerCalls.map(c => c.provider), ['chatgpt'], 'the browser seat still used its tab');
        const msgs = messagesOf(chat.id).filter(m => m.role === 'assistant');
        assert.deepEqual(msgs.map(m => [m.who, m.route]), [['Llama', 'api'], ['GPT tab', 'browser']]);
        const got = multiaiApi.getChat(chat.id);
        assert.equal(got.agents.find(a => a.id === 'llama').route, 'api', 'readers see the resolved api route');

        // no key/endpoint → a clear error, not a browser fallback
        delete byokState.keys.ollama;
        const chat2 = newChat({ participants: [], agents: [{ name: 'Llama', provider: 'ollama', model: 'llama3.2' }], stopWhenAllAgree: false });
        userMsg(chat2.id, 'go');
        await invoke('multiai-run-round', { chatId: chat2.id, rounds: 1 });
        const err = messagesOf(chat2.id).find(m => m.role === 'error');
        assert.match(err.text, /No API key for ollama in Settings/);
        assert.equal(providerCalls.length, 1, 'no browser attempt for an api-only seat');
    } finally {
        delete byokState.keys.ollama; delete byokState.custom;
    }
});

// ---- workspace seats --------------------------------------------------------

import { execFileSync } from 'node:child_process';
const gitOk = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const gitIn = (root, args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function tempRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiai-wsrun-'));
    gitIn(root, ['init', '-q']); gitIn(root, ['checkout', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    gitIn(root, ['add', '-A']); gitIn(root, ['commit', '-q', '-m', 'initial', '--no-verify']);
    return root;
}
const wsmod = require('../../../electron/providers/workspace.cjs');

test('workspace seats: tool seats get the folder + branch, writer turns are committed on the chat branch and recorded as change messages the others read', { skip: !gitOk && 'git not installed' }, async () => {
    cliCalls.length = 0; sent.length = 0;
    const root = tempRepo();
    const mainHead = gitIn(root, ['rev-parse', 'main']);
    cliReplyFn = async (p, o) => {
        if (o.workspace && o.workspace.tools === 'write') { fs.appendFileSync(path.join(o.workspace.root, 'README.md'), `${p} was here\n`); return 'I appended a line to README.md.'; }
        return `${p} (${o.workspace ? o.workspace.tools : 'no tools'}) read the diff`;
    };
    const chat = newChat({ participants: [], agents: [
        { name: 'Writer', provider: 'claude-cli', model: 'sonnet', tools: 'write' },
        { name: 'Reader', provider: 'codex-cli', model: 'gpt-5.5', tools: 'read' },
        { name: 'Talker', provider: 'claude-cli', model: 'haiku' },
        { name: 'Tab', provider: 'chatgpt', tools: 'full' },   // tools are meaningless off the CLI route
    ], workspace: { root }, stopWhenAllAgree: false });
    userMsg(chat.id, 'improve the readme');
    const r = await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.equal(r.success, true, r.error);

    const branch = wsmod.branchFor(chat.id);
    assert.deepEqual(cliCalls.map(c => c.opts.workspace ? c.opts.workspace.tools : null), ['write', 'read', null], 'only tool seats are given the workspace');
    assert.deepEqual([cliCalls[0].opts.workspace.root, cliCalls[0].opts.workspace.branch], [root, branch]);
    assert.ok(cliCalls[0].opts.prompt.includes('Workspace:') && cliCalls[0].opts.prompt.includes('file tools'), 'the writer is told about its tools in the prompt');
    assert.ok(cliCalls[1].opts.prompt.includes('read-only'), 'the reader is told it is read-only');
    assert.ok(cliCalls[2].opts.prompt.includes('Workspace:') && cliCalls[2].opts.prompt.includes('Review them') && !cliCalls[2].opts.prompt.includes('You have file tools'), 'a seat without tools is asked to review the diffs, not to edit');

    const msgs = messagesOf(chat.id);
    const change = msgs.find(m => m.role === 'change');
    assert.ok(change, 'a change message was recorded');
    assert.deepEqual([change.who, change.files, change.provider, change.agentId, change.round], ['Writer · changes', ['README.md'], 'claude-cli', 'writer', 1]);
    assert.match(change.text, /^Writer changed 1 file \(commit [0-9a-f]{8}\):/);
    assert.ok(change.text.includes('```diff') && change.text.includes('+claude-cli was here'));
    assert.equal(change.commit, gitIn(root, ['rev-parse', 'HEAD']));
    assert.equal(msgs.indexOf(change), msgs.findIndex(m => m.who === 'Writer') + 1, 'the change follows the writer\'s own reply');
    assert.ok(cliCalls[1].opts.prompt.includes('+claude-cli was here'), 'the next seat sees the diff in its context');
    assert.ok(msgs.some(m => m.role === 'system' && m.text.includes(`on branch ${branch}`) && m.text.includes('Writer (write)') && m.text.includes('Reader (read)') && !m.text.includes('Tab')), 'the run notes the branch and the tool seats');
    assert.equal(core.normalizeAgents(store.getChat(chat.id))[3].tools, 'none', 'tools on a non-CLI seat are dropped');

    assert.equal(gitIn(root, ['rev-parse', '--abbrev-ref', 'HEAD']), branch);
    assert.match(gitIn(root, ['log', '-1', '--format=%an %s']), /^Proxima Multi-AI Writer \[0101WR\]$/);
    assert.equal(gitIn(root, ['rev-parse', 'main']), mainHead, 'main is untouched');
    assert.equal(store.getChat(chat.id).workspace.branch, branch, 'the branch is remembered on the chat');
    assert.equal(multiaiApi.getChat(chat.id).messages.find(m => m.role === 'change').label, '0101CH', 'change messages carry their own label code');

    // a writer turn that changes nothing records no change message
    cliCalls.length = 0;
    cliReplyFn = async () => 'Nothing to change.';
    store.updateChat(chat.id, { cycle: 2 });
    userMsg(chat.id, 'anything else?', 2);
    await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.equal(messagesOf(chat.id).filter(m => m.role === 'change').length, 1);
});

test('workspace seats: writers are serialised even in a parallel first round; readers overlap', { skip: !gitOk && 'git not installed' }, async () => {
    cliCalls.length = 0;
    const root = tempRepo();
    const timeline = [];
    cliReplyFn = async (p, o) => {
        const name = o.workspace ? o.workspace.tools : 'talk';
        timeline.push({ name, at: 'start', t: Date.now() });
        await delay(40);
        if (o.workspace && (o.workspace.tools === 'write' || o.workspace.tools === 'full')) fs.appendFileSync(path.join(o.workspace.root, 'README.md'), `${o.model}\n`);
        timeline.push({ name, at: 'end', t: Date.now() });
        return `${o.model} done`;
    };
    const chat = newChat({ participants: [], agents: [
        { name: 'W1', provider: 'claude-cli', model: 'w1', tools: 'write' },
        { name: 'W2', provider: 'codex-cli', model: 'w2', tools: 'full' },
        { name: 'R1', provider: 'claude-cli', model: 'r1', tools: 'read' },
    ], workspace: { root }, independentFirstRound: true, stopWhenAllAgree: false });
    userMsg(chat.id, 'go');
    const r = await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.equal(r.success, true, r.error);
    const starts = (n) => timeline.filter(e => e.name === n && e.at === 'start').map(e => e.t);
    const ends = (n) => timeline.filter(e => e.name === n && e.at === 'end').map(e => e.t);
    const [wA, wB] = [['write', 'full'], ['full', 'write']].find(([a]) => starts(a)[0] <= starts(['write', 'full'].find(x => x !== a))[0]);
    assert.ok(starts(wB)[0] >= ends(wA)[0], 'the second writer started only after the first finished');
    assert.ok(starts('read')[0] < ends(wA)[0], 'the reader ran alongside the first writer');
    assert.equal(messagesOf(chat.id).filter(m => m.role === 'change').length, 2, 'each writer produced its own commit');
    assert.equal(gitIn(root, ['rev-list', '--count', 'main..HEAD']), '2');
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf-8'), 'hello\nw1\nw2\n'.replace('w1\nw2', wA === 'write' ? 'w1\nw2' : 'w2\nw1'));
});

test('workspace seats: a non-repo folder or uncommitted work on another branch stops the run before any seat speaks', { skip: !gitOk && 'git not installed' }, async () => {
    cliCalls.length = 0;
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'multiai-plain-'));
    const chat = newChat({ participants: [], agents: [{ name: 'W', provider: 'claude-cli', model: 'sonnet', tools: 'write' }], workspace: { root: plain } });
    userMsg(chat.id, 'go');
    const r = await invoke('multiai-run-round', { chatId: chat.id, rounds: 1 });
    assert.equal(r.success, false);
    assert.match(r.error, /git repository/);
    assert.equal(cliCalls.length, 0);
    const err = messagesOf(chat.id).find(m => m.role === 'error');
    assert.ok(err && err.who === 'Workspace' && /git repository/.test(err.text), 'the refusal is in the transcript');

    const root = tempRepo();
    fs.writeFileSync(path.join(root, 'mine.txt'), 'uncommitted\n');
    const chat2 = newChat({ participants: [], agents: [{ name: 'W', provider: 'claude-cli', model: 'sonnet', tools: 'write' }], workspace: { root } });
    userMsg(chat2.id, 'go');
    const r2 = await invoke('multiai-run-round', { chatId: chat2.id, rounds: 1 });
    assert.equal(r2.success, false);
    assert.match(r2.error, /uncommitted changes on branch "main"/);
    assert.equal(gitIn(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(cliCalls.length, 0);

    // a chat with a workspace but no tool seats never touches git
    const chat3 = newChat({ participants: [], agents: [{ name: 'T', provider: 'claude-cli', model: 'sonnet' }], workspace: { root }, stopWhenAllAgree: false });
    userMsg(chat3.id, 'go');
    cliReplyFn = async () => 'talk';
    const r3 = await invoke('multiai-run-round', { chatId: chat3.id, rounds: 1 });
    assert.equal(r3.success, true);
    assert.equal(cliCalls.length, 1);
    assert.equal(cliCalls[0].opts.workspace, undefined);
});

test('REST/MCP: create-chat accepts workspace + per-agent tools and readers see them', async () => {
    const ext = routeExtensions[0];
    const calls = [];
    const helpers = { sendJSON: (r, code, d) => calls.push({ code, data: d }), sendError: (r, code, msg) => calls.push({ code, error: msg }) };
    const url = (p) => new URL(`http://127.0.0.1:3210${p}`);
    await ext('POST', url('/v1/multiai/chats'), { title: 'ws', agents: [{ name: 'W', provider: 'codex-cli', model: 'gpt-5.5', tools: 'write' }, { name: 'T', provider: 'chatgpt', tools: 'write' }], workspace: { root: 'C:\\repo' } }, {}, helpers);
    const r = calls.pop();
    assert.equal(r.code, 201, JSON.stringify(r));
    assert.deepEqual(r.data.chat.workspace, { root: 'C:\\repo' });
    assert.deepEqual(r.data.chat.agents.map(a => [a.id, a.tools]), [['w', 'write'], ['t', 'none']]);
    const got = multiaiApi.getChat(r.data.chat.id);
    assert.deepEqual(got.agents.map(a => a.tools), ['write', 'none']);
    assert.deepEqual(got.workspace, { root: 'C:\\repo' });
});

test('workspace seats: a second chat on the same folder starts fresh from the base branch; multiai-workspace-info previews it', { skip: !gitOk && 'git not installed' }, async () => {
    cliCalls.length = 0;
    const root = tempRepo();
    cliReplyFn = async (p, o) => { if (o.workspace && o.workspace.tools === 'write') fs.writeFileSync(path.join(o.workspace.root, `${o.model}.txt`), `${o.model}\n`); return `${o.model} wrote a file`; };
    const a = newChat({ participants: [], agents: [{ name: 'A', provider: 'claude-cli', model: 'alpha', tools: 'write' }], workspace: { root }, stopWhenAllAgree: false });
    userMsg(a.id, 'go');
    assert.equal((await invoke('multiai-run-round', { chatId: a.id, rounds: 1 })).success, true);
    assert.ok(fs.existsSync(path.join(root, 'alpha.txt')));
    assert.equal(gitIn(root, ['rev-parse', '--abbrev-ref', 'HEAD']), wsmod.branchFor(a.id), 'the folder is left on chat A\'s branch');

    const b = newChat({ participants: [], agents: [{ name: 'B', provider: 'claude-cli', model: 'beta', tools: 'write' }], workspace: { root }, stopWhenAllAgree: false });
    const info = await invoke('multiai-workspace-info', { root, chatId: b.id });
    assert.deepEqual([info.ok, info.branch, info.dirty, info.chatBranchExists, info.base], [true, wsmod.branchFor(a.id), false, false, 'main']);
    userMsg(b.id, 'go');
    assert.equal((await invoke('multiai-run-round', { chatId: b.id, rounds: 1 })).success, true);
    assert.equal(gitIn(root, ['rev-parse', '--abbrev-ref', 'HEAD']), wsmod.branchFor(b.id));
    assert.equal(fs.existsSync(path.join(root, 'alpha.txt')), false, 'chat B does not see chat A\'s file');
    assert.ok(fs.existsSync(path.join(root, 'beta.txt')));
    assert.equal(gitIn(root, ['merge-base', wsmod.branchFor(b.id), 'main']), gitIn(root, ['rev-parse', 'main']), 'B branched from main');
    assert.ok(messagesOf(b.id).some(m => m.role === 'system' && m.text.includes('(created from main)')));
    assert.equal(gitIn(root, ['rev-list', '--count', 'main']), '1', 'main itself never moves');

    const bad = await invoke('multiai-workspace-info', { root: path.join(os.tmpdir(), 'nope-' + Date.now()), chatId: b.id });
    assert.equal(bad.ok, false);
});
