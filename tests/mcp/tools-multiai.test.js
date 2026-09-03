// Proxima — MCP Multi-AI Chat Tools Tests.
// Verifies the multiai_* tools translate to the right IPC actions and render
// transcripts with labels/ids, using the shared harness with a scripted IPC.

import test from 'node:test';
import assert from 'node:assert';
import { register } from '../../src/mcp/tools-multiai.js';
import { makeHarness, textOf } from '../fixtures/mcp-harness.js';

function harness(reply) {
    const h = makeHarness({ ipcReply: reply });
    register(h.server, h.deps);
    return h;
}

const chat = {
    id: 'chat_1', title: 'Sandwich', mode: 'classic', discussMode: 'debate', contextMode: 'delta', participants: ['chatgpt', 'claude'], cycle: 2, totalMessages: 3, running: false,
    messages: [
        { id: 'm1', label: '0100US', who: 'You', role: 'user', text: 'Design a sandwich' },
        { id: 'm2', label: '0101CG', who: 'ChatGPT', provider: 'chatgpt', role: 'assistant', text: 'Umami melt.' },
        { id: 'm3', label: '0201CX', who: 'Codex', provider: 'codex', role: 'assistant', text: 'VERIFIED: tested in kitchen' },
    ],
};

test('tools-multiai: registers the 7 multiai tools', () => {
    const h = harness();
    assert.deepEqual([...h.tools.keys()].sort(), ['multiai_create_chat', 'multiai_list_chats', 'multiai_post_message', 'multiai_read_chat', 'multiai_run_round', 'multiai_stop', 'multiai_wait_for_run']);
});

test('multiai_list_chats: lists chats with a running marker', async () => {
    const h = harness((action) => action === 'multiaiListChats'
        ? { success: true, chats: [{ id: 'chat_1', title: 'Sandwich', mode: 'classic', participants: ['chatgpt'], messageCount: 3, cycle: 2, updatedAt: 1 }, { id: 'chat_2', title: 'Other', mode: 'orchestrated', strategy: 'crew', participants: [], messageCount: 0, cycle: 0 }] }
        : { success: true, running: ['chat_1'] });
    const out = textOf(await h.tools.get('multiai_list_chats').handler({}));
    assert.match(out, /● chat_1 {2}"Sandwich"/);
    assert.match(out, /chat_2 {2}"Other" {2}\[orchestrated\/crew\]/);
});

test('multiai_read_chat: renders header + labelled messages and forwards since/last', async () => {
    const h = harness(() => ({ success: true, chat }));
    const out = textOf(await h.tools.get('multiai_read_chat').handler({ chatId: 'chat_1', since: 'm1', last: 5 }));
    assert.match(out, /"Sandwich" {2}\[classic, debate, context=delta\]/);
    assert.match(out, /\[0201CX id=m3\] Codex:\nVERIFIED: tested in kitchen/);
    assert.match(out, /idle/);
    assert.deepEqual(h.ipcCalls[0], ['multiaiGetChat', null, { chatId: 'chat_1', since: 'm1', last: 5 }]);
});

test('multiai_post_message: derives the provider from the name and never impersonates a browser AI', async () => {
    const h = harness(() => ({ success: true, message: { id: 'm9', label: '0202CC', who: 'Claude Code' } }));
    await h.tools.get('multiai_post_message').handler({ chatId: 'chat_1', who: 'Claude Code', text: 'UNVERIFIED: hypothesis' });
    assert.equal(h.ipcCalls[0][2].provider, 'claude-code');
    await h.tools.get('multiai_post_message').handler({ chatId: 'chat_1', who: 'Codex', text: 'x' });
    assert.equal(h.ipcCalls[1][2].provider, 'codex');
    await h.tools.get('multiai_post_message').handler({ chatId: 'chat_1', who: 'claude', text: 'x' });
    assert.equal(h.ipcCalls[2][2].provider, 'external', 'a browser participant name maps to external');
    await h.tools.get('multiai_post_message').handler({ chatId: 'chat_1', who: 'Eugene', text: 'do this', role: 'user' });
    assert.equal(h.ipcCalls[3][2].provider, 'human');
});

test('multiai_run_round: returns started by default, messages when waiting; wait tool reports still-running', async () => {
    const h = harness((action, _n, data) => action === 'multiaiRun'
        ? (data.wait ? { success: true, messages: chat.messages.slice(1) } : { success: true, started: true, chatId: data.chatId })
        : { success: true, running: true, messages: [chat.messages[2]] });
    const started = textOf(await h.tools.get('multiai_run_round').handler({ chatId: 'chat_1', text: '@claude kick off', who: 'Codex', rounds: 2 }));
    assert.match(started, /"started": true/);
    assert.equal(h.ipcCalls[0][2].provider, 'codex');
    const done = textOf(await h.tools.get('multiai_run_round').handler({ chatId: 'chat_1', wait: true }));
    assert.match(done, /Run finished/);
    assert.match(done, /Umami melt/);
    const w = textOf(await h.tools.get('multiai_wait_for_run').handler({ chatId: 'chat_1', since: 'm2', maxSeconds: 10 }));
    assert.match(w, /STILL RUNNING/);
    assert.equal(h.ipcCalls[2][2].maxMs, 10000);
});

test('multiai tools: IPC errors surface as tool errors', async () => {
    const h = harness(() => ({ success: false, error: 'Chat not found', status: 404 }));
    const res = await h.tools.get('multiai_stop').handler({ chatId: 'nope' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /Chat not found/);
});
