// Proxima — Multi-AI core tests.
// Covers the store's atomic/backup/merge semantics and the bounded-context
// prompt builder, stances, mentions, stop-token detection and parsers.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../../electron/ipc/multiai-core.cjs');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'multiai-core-'));
}

function msg(over) {
    return Object.assign({ id: core.genMsgId(), role: 'assistant', provider: 'claude', who: 'claude', text: 'x', ts: Date.now(), cycle: 1, round: 1 }, over);
}

// ---- store ---------------------------------------------------------------

test('store: save is atomic and rotates a backup; load prefers the live file', () => {
    const dir = tmpDir();
    const store = core.createStore({ dir, fs, path });
    const chat = store.createChat({ title: 'A' });
    assert.ok(fs.existsSync(store.file()));
    store.appendMessage(chat.id, msg({ text: 'first' }));
    assert.ok(fs.existsSync(store.backupFile()), 'second save must leave a backup of the previous version');
    assert.ok(!fs.existsSync(path.join(dir, 'chats.json.tmp')), 'tmp file must not linger');
    const loaded = store.load();
    assert.equal(loaded.projects[0].chats[0].messages.length, 1);
});

test('store: a corrupt chats.json is parked, not overwritten, and the backup is restored', () => {
    const dir = tmpDir();
    const store = core.createStore({ dir, fs, path });
    const chat = store.createChat({ title: 'keep me' });
    store.appendMessage(chat.id, msg({ text: 'survives' }));   // rotates a good backup
    fs.writeFileSync(store.file(), '{ this is not json', 'utf-8');
    const loaded = store.load();
    assert.equal(loaded.projects[0].chats[0].title, 'keep me');
    const parked = fs.readdirSync(dir).filter(f => f.startsWith('chats.corrupt-'));
    assert.equal(parked.length, 1, 'corrupt file is parked under a dated name');
});

test('store: load recovers from backup when only the backup exists (crash between renames)', () => {
    const dir = tmpDir();
    const store = core.createStore({ dir, fs, path });
    store.createChat({ title: 'B' });
    fs.renameSync(store.file(), store.backupFile());
    assert.equal(store.load().projects[0].chats[0].title, 'B');
});

test('store: saveSnapshot merges messages appended by main since the renderer loaded', () => {
    const dir = tmpDir();
    const store = core.createStore({ dir, fs, path });
    const chat = store.createChat({ title: 'race' });
    const rendererSnapshot = store.load();               // renderer loads
    const appended = store.appendMessage(chat.id, msg({ text: 'from REST', ts: 5 }));  // main appends
    rendererSnapshot.projects[0].chats[0].messages.push(msg({ text: 'from UI', ts: 6 }));
    const merged = store.saveSnapshot(rendererSnapshot); // renderer saves stale snapshot
    const msgs = merged.projects[0].chats[0].messages;
    assert.equal(msgs.length, 2);
    assert.ok(msgs.some(m => m.id === appended.id), 'the REST message must survive the snapshot save');
});

test('store: snapshot saves never delete chats; deleteChat does', () => {
    const dir = tmpDir();
    const store = core.createStore({ dir, fs, path });
    const a = store.createChat({ title: 'a' });
    const b = store.createChat({ title: 'b' });
    const snap = store.load();
    snap.projects[0].chats = snap.projects[0].chats.filter(c => c.id !== b.id);
    store.saveSnapshot(snap);
    assert.equal(store.load().projects[0].chats.length, 2, 'missing chat in a snapshot is not a delete');
    assert.equal(store.deleteChat(b.id), true);
    assert.equal(store.load().projects[0].chats.length, 1);
    assert.equal(store.load().projects[0].chats[0].id, a.id);
});

test('store: appendMessage is idempotent on id and fills ts/cycle', () => {
    const dir = tmpDir();
    const store = core.createStore({ dir, fs, path });
    const chat = store.createChat({ cycle: 3 });
    const m = store.appendMessage(chat.id, { id: 'fixed', role: 'assistant', text: 'hi' });
    store.appendMessage(chat.id, { id: 'fixed', role: 'assistant', text: 'hi again' });
    const got = store.getChat(chat.id);
    assert.equal(got.messages.length, 1);
    assert.equal(m.cycle, 3);
    assert.ok(m.ts > 0);
});

// ---- context / prompts ----------------------------------------------------

test('buildContext: recent window verbatim, older condensed, errors and passes excluded', () => {
    const messages = [];
    messages.push(msg({ role: 'user', who: 'You', text: 'Brief: design a widget', round: 0 }));
    for (let i = 0; i < 14; i++) messages.push(msg({ text: `reply ${i} ` + 'lorem '.repeat(200), round: i + 1 }));
    messages.push(msg({ role: 'error', who: 'gemini error', text: 'API failed: 500' }));
    messages.push(msg({ role: 'pass', who: 'claude', text: 'PASS' }));
    const ctx = core.buildContext(messages, { contextWindow: 4, digestCharsPerMessage: 100 });
    assert.equal(ctx.recentCount, 4);
    assert.equal(ctx.digestCount, 11);
    assert.ok(!ctx.text.includes('API failed'), 'errors must not be fed back to participants');
    assert.ok(!/\bPASS\b/.test(ctx.text), 'passes must not be fed back');
    assert.ok(ctx.text.includes('Brief: design a widget'));
    const verbatimCount = (ctx.text.match(/reply \d+ (lorem ){199}lorem/g) || []).length;
    assert.equal(verbatimCount, 4, 'only the window is verbatim');
});

test('buildContext: a pinned summary replaces everything before it', () => {
    const messages = [
        msg({ role: 'user', who: 'You', text: 'old brief', round: 0 }),
        msg({ text: 'ancient argument' }),
        msg({ role: 'summary', text: 'DECISIONS: use X. OPEN: Y.' }),
        msg({ text: 'post-summary point' }),
    ];
    const ctx = core.buildContext(messages, { contextWindow: 10 });
    assert.ok(ctx.text.includes('State summary'));
    assert.ok(ctx.text.includes('DECISIONS: use X'));
    assert.ok(!ctx.text.includes('ancient argument'));
    assert.ok(ctx.text.includes('post-summary point'));
});

test('buildContext: digest budget trims oldest lines but keeps the opening brief', () => {
    const messages = [msg({ role: 'user', who: 'You', text: 'THE BRIEF', round: 0 })];
    for (let i = 0; i < 50; i++) messages.push(msg({ text: `point ${i} ` + 'x'.repeat(500) }));
    const ctx = core.buildContext(messages, { contextWindow: 2, digestCharsPerMessage: 400, digestMaxChars: 3000 });
    assert.ok(ctx.text.includes('THE BRIEF'));
    assert.ok(ctx.dropped > 0);
    assert.ok(ctx.text.length < 3000 + 4000, 'prompt stays bounded');
});

test('buildClassicPrompt: mentions others, assigns debate stances for 3+, includes PASS/DONE rules', () => {
    const participants = ['chatgpt', 'claude', 'gemini'];
    const p = core.buildClassicPrompt({
        topic: 'Should we ship?', mode: 'debate', brevity: 'max 4 sentences', persona: null,
        participants, provider: 'gemini', messages: [], stopToken: 'DONE',
    });
    assert.ok(p.includes('You are Gemini'));
    assert.ok(p.includes('ChatGPT') && p.includes('Claude'));
    assert.ok(p.includes('critical evaluator'), 'third debater gets the evaluator stance');
    assert.ok(p.includes('reply with exactly: PASS'));
    assert.ok(p.includes('single word DONE'));
});

test('buildClassicPrompt: independent first round hides same-cycle replies from others', () => {
    const messages = [
        msg({ role: 'user', who: 'You', text: 'Q', cycle: 2, round: 0 }),
        msg({ provider: 'chatgpt', who: 'chatgpt', text: 'CHATGPT-SAME-CYCLE', cycle: 2, round: 1 }),
        msg({ provider: 'chatgpt', who: 'chatgpt', text: 'CHATGPT-OLD-CYCLE', cycle: 1, round: 1 }),
    ];
    const p = core.buildClassicPrompt({ topic: 'Q', mode: 'discuss', participants: ['chatgpt', 'claude'], provider: 'claude', messages, independent: { cycle: 2 } });
    assert.ok(!p.includes('CHATGPT-SAME-CYCLE'));
    assert.ok(p.includes('CHATGPT-OLD-CYCLE'));
    assert.ok(p.includes('independent first round'));
});

test('parseMentions: directed order, "only" restriction, label aliases', () => {
    const parts = ['chatgpt', 'perplexity', 'gemini', 'claude'];
    assert.deepEqual(core.parseMentions('@claude kick off, others review', parts).order, ['claude', 'chatgpt', 'perplexity', 'gemini']);
    assert.deepEqual(core.parseMentions('only @gemini and @ChatGPT reply', parts).order, ['gemini', 'chatgpt']);
    assert.equal(core.parseMentions('no mentions here', parts).mentioned.length, 0);
    assert.equal(core.parseMentions('email me at a@b.com', parts).mentioned.length, 0, 'emails are not mentions');
});

test('stop-token & PASS detection, round outcome', () => {
    assert.ok(core.startsWithToken('DONE — final position: ship it', 'DONE'));
    assert.ok(core.startsWithToken('**DONE** ship it', 'DONE'));
    assert.ok(!core.startsWithToken('We are not DONE yet', 'DONE'));
    assert.ok(core.isPass(' PASS '));
    assert.ok(core.isPass('**PASS**'));
    assert.ok(!core.isPass('PASS the salt'));
    const conv = core.roundOutcome([msg({ text: 'DONE agreed' }), msg({ role: 'pass', text: 'PASS' })], 'DONE');
    assert.equal(conv.converged, true);
    const notConv = core.roundOutcome([msg({ text: 'DONE agreed' }), msg({ text: 'I disagree' })], 'DONE');
    assert.equal(notConv.converged, false);
    const allPass = core.roundOutcome([msg({ role: 'pass' }), msg({ role: 'pass' })], 'DONE');
    assert.equal(allPass.allPassed, true);
    assert.equal(allPass.converged, false);
});

test('parseWorkflowLine: only real provider prefixes are providers', () => {
    assert.deepEqual(core.parseWorkflowLine('claude: outline it'), { provider: 'claude', task: 'outline it' });
    assert.deepEqual(core.parseWorkflowLine('gemini:3.1-pro: deep dive'), { provider: 'gemini:3.1-pro', task: 'deep dive' });
    assert.deepEqual(core.parseWorkflowLine('Summarize: the key points'), { task: 'Summarize: the key points' });
});

test('titles: local title is short and clean; cleanTitle strips quotes/punctuation', () => {
    assert.equal(core.localTitle('work together to create a novel sandwich. first propose one, then critique'), 'work together to create a novel sandwich. first');
    assert.equal(core.cleanTitle('"Koji Porchetta Design Session."\nextra'), 'Koji Porchetta Design Session');
    assert.equal(core.localTitle('@gemini kick off: design a novel sandwich'), 'kick off: design a novel sandwich');
});

test('refLabel & provider codes cover external agents', () => {
    assert.equal(core.refLabel({ cycle: 1, round: 3, role: 'assistant', provider: 'chatgpt' }), '0103CG');
    assert.equal(core.refLabel({ cycle: 2, round: 0, role: 'user' }), '0200US');
    assert.equal(core.refLabel({ cycle: 2, round: 1, role: 'assistant', provider: 'codex' }), '0201CX');
    assert.equal(core.refLabel({ cycle: 1, round: 0, role: 'summary' }), '0100SM');
});

test('context modes: full sends everything; delta sends only unseen messages from others, with a rolling summary', () => {
    const messages = [
        msg({ id: 'u1', role: 'user', who: 'You', text: 'THE BRIEF', round: 0 }),
        msg({ id: 'a1', provider: 'chatgpt', who: 'chatgpt', text: 'CHATGPT ONE' }),
        msg({ id: 'b1', provider: 'claude', who: 'claude', text: 'CLAUDE ONE' }),
        msg({ id: 's1', role: 'summary', text: 'SUMMARY: agreed on X' }),
        msg({ id: 'a2', provider: 'chatgpt', who: 'chatgpt', text: 'CHATGPT TWO' }),
        msg({ id: 'b2', provider: 'claude', who: 'claude', text: 'CLAUDE TWO' }),
    ];
    const full = core.buildContextByMode(messages, { mode: 'full' });
    assert.ok(full.text.includes('CHATGPT ONE') && full.text.includes('CLAUDE TWO') && full.text.includes('complete'));

    // claude last saw up to a1: it should get s1, a2 (not its own b1/b2), plus the summary block
    const delta = core.buildContextByMode(messages, { mode: 'delta', delta: { sinceId: 'a1', provider: 'claude' } });
    assert.equal(delta.catchUp, false);
    assert.ok(delta.text.includes('CHATGPT TWO'));
    assert.ok(!delta.text.includes('CLAUDE TWO'), 'own replies are not re-sent');
    assert.ok(!delta.text.includes('CHATGPT ONE'), 'already-seen messages are not re-sent');
    assert.ok(delta.text.includes('Rolling state summary') && delta.text.includes('agreed on X'));
    assert.equal(delta.lastId, 'b2');

    // no anchor → catch-up with the bounded context
    const catchUp = core.buildContextByMode(messages, { mode: 'delta', delta: { sinceId: null, provider: 'claude' } });
    assert.equal(catchUp.catchUp, true);
    assert.ok(catchUp.text.includes('State summary'));

    const withMeta = core.buildClassicPromptWithMeta({ topic: 'T', mode: 'discuss', participants: ['chatgpt', 'claude'], provider: 'claude', messages, contextMode: 'delta', delta: { sinceId: 'a1' } });
    assert.equal(withMeta.meta.contextMode, 'delta');
    assert.ok(withMeta.prompt.includes('continuing an ongoing thread'));
    assert.equal(core.messagesSinceSummary(messages).length, 2);
});
