// Proxima — MCP Chat Tools Tests.
// Verifies tool registration schemas, and handlers for ask_claude, ask_model, ask_all_ais, smart_query, and new_conversation.

import test from 'node:test';
import assert from 'node:assert';
import { register } from '../../src/mcp/tools-chat.js';
import { registerModule, textOf } from '../fixtures/mcp-harness.js';

test('tools-chat: registers exactly the 8 documented chat tools with schemas', () => {
    const { tools } = registerModule(register);
    assert.deepEqual(
        [...tools.keys()].sort(),
        ['ask_all_ais', 'ask_chatgpt', 'ask_claude', 'ask_gemini', 'ask_model', 'new_conversation', 'smart_query'].sort()
            .concat('ask_perplexity').sort(),
    );
    // Every tool exposes a non-empty description and an inputSchema object.
    for (const [, { meta }] of tools) {
        assert.ok(meta.description && meta.description.length > 10);
        assert.equal(typeof meta.inputSchema, 'object');
    }
});

test('ask_claude: enabled provider → routes the message to smartChat and returns its reply', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('ask_claude').handler({ message: 'hello' });
    assert.equal(textOf(res), 'reply:claude');
    assert.equal(h.smartChatCalls.length, 1);
    assert.equal(h.smartChatCalls[0].provider, 'claude');
    assert.deepEqual(h.smartChatCalls[0].opts, { filePath: null });
});

test('ask_claude: disabled provider → returns the disabled message, no model call', async () => {
    const h = registerModule(register, { enabled: ['chatgpt'] });
    const res = await h.tools.get('ask_claude').handler({ message: 'hello' });
    assert.match(textOf(res), /claude is disabled/i);
    assert.equal(h.smartChatCalls.length, 0);
});

test('ask_claude: a smartChat failure is returned as an isError toolError', async () => {
    const h = registerModule(register, { smartChat: async () => { throw new Error('provider down'); } });
    const res = await h.tools.get('ask_claude').handler({ message: 'hi' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /provider down/);
});

test('ask_model: normalizes provider case and forwards the model override as engine', async () => {
    const h = registerModule(register);
    await h.tools.get('ask_model').handler({ provider: 'Claude', message: 'hi', model: 'claude-x' });
    assert.equal(h.smartChatCalls[0].provider, 'claude');
    assert.equal(h.smartChatCalls[0].opts.engine, 'claude-x');
});

test('ask_model: a disabled/unknown provider short-circuits with the disabled message', async () => {
    const h = registerModule(register, { enabled: ['claude'] });
    const res = await h.tools.get('ask_model').handler({ provider: 'groq', message: 'hi' });
    assert.match(textOf(res), /groq is disabled/i);
    assert.equal(h.smartChatCalls.length, 0);
});

test('ask_all_ais: with no enabled providers returns a clear error', async () => {
    const h = registerModule(register, { enabled: [] });
    const res = await h.tools.get('ask_all_ais').handler({ message: 'hi' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /No enabled providers/);
});

test('ask_all_ais: aggregates a single requested provider response under its heading', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('ask_all_ais').handler({ message: 'hi', providers: ['claude'] });
    assert.match(textOf(res), /1 Provider Responded/);
    assert.match(textOf(res), /### Claude/);
    assert.match(textOf(res), /reply:claude/);
});

test('ask_all_ais: a failing provider is reported inline as an Error, not thrown', async () => {
    const h = registerModule(register, { smartChat: async () => { throw new Error('rate limited'); } });
    const res = await h.tools.get('ask_all_ais').handler({ message: 'hi', providers: ['claude'] });
    assert.match(textOf(res), /### Claude/);
    assert.match(textOf(res), /Error:.*rate limited/);
});

test('smart_query: runs the agentic executor and appends the strategy/quality footer', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('smart_query').handler({ message: 'do it', mode: 'verify' });
    assert.match(textOf(res), /executor answer/);
    assert.match(textOf(res), /strategy: direct/);
    assert.match(textOf(res), /quality: 9\/10/);
});

test('smart_query: an executor error result becomes a toolError', async () => {
    const h = registerModule(register, { initAgenticExecutor: () => ({ execute: async () => ({ error: 'no providers' }) }) });
    const res = await h.tools.get('smart_query').handler({ message: 'x' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /no providers/);
});

test('new_conversation: named provider resets only that provider', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('new_conversation').handler({ provider: 'gemini' });
    assert.match(textOf(res), /Started new gemini conversation/);
    assert.deepEqual(h.ipcCalls, [['newConversation', 'gemini']]);
});

test('new_conversation: an unknown provider returns success:false without resetting', async () => {
    const h = registerModule(register, { enabled: ['claude'] });
    const res = await h.tools.get('new_conversation').handler({ provider: 'gemini' });
    assert.match(textOf(res), /not enabled/);
    assert.equal(h.ipcCalls.length, 0);
});

test('new_conversation: with no provider resets every enabled provider', async () => {
    const h = registerModule(register, { enabled: ['claude', 'gemini'] });
    const res = await h.tools.get('new_conversation').handler({});
    assert.match(textOf(res), /claude/);
    assert.match(textOf(res), /gemini/);
    const resetNames = h.ipcCalls.map((c) => c[1]).sort();
    assert.deepEqual(resetNames, ['claude', 'gemini']);
});
