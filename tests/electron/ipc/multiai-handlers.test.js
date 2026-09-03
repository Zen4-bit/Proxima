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

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request.endsWith('providers/sender.cjs')) return fakeSender;
    return origLoad.apply(this, arguments);
};
const { registerMultiAiHandlers } = require('../../../electron/ipc/multiai.cjs');
Module._load = origLoad;

const routeExtensions = [];
registerMultiAiHandlers({
    mainWindow: () => ({ isDestroyed: () => false, webContents: { send: (ch, p) => sent.push({ ch, p }) } }),
    loadSettings: () => ({ providers: { chatgpt: { enabled: true }, claude: { enabled: true }, gemini: { enabled: true }, perplexity: { enabled: false } } }),
    registerRouteExtension: (fn) => routeExtensions.push(fn),
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

const delay = (ms) => new Promise(r => setTimeout(r, ms));

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
    assert.ok(providerCalls.every(c => c.conversationId === `multiai:${chat.id}:1`), 'every call rides the chat-specific thread');
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
    assert.equal(ids[0], `multiai:${chat.id}:1`);
    assert.equal(ids[ids.length - 1], `multiai:${chat.id}:2`);
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
