// Proxima — BYOK Providers Connectors Tests.
// Verifies response validation, role alternation normalization, Google safety blocking, Perplexity tool call structures, and fatal key short-circuiting.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const httpPath = require.resolve('../../electron/api/byok/providers/_http.cjs');
const stub = { resolve: null, error: null, last: null, calls: 0 };
require.cache[httpPath] = {
    id: httpPath,
    filename: httpPath,
    loaded: true,
    exports: {
        postJson: async (endpoint, headers, body, label, opts) => {
            stub.calls++;
            stub.last = { endpoint, headers, body: JSON.parse(body), label, opts };
            if (stub.error) throw stub.error;
            return stub.resolve;
        },
        DEFAULT_TIMEOUT_MS: 120000,
        MAX_RESPONSE_BYTES: 25 * 1024 * 1024,
    },
};

const openai = require('../../electron/api/byok/providers/openai.cjs');
const anthropic = require('../../electron/api/byok/providers/anthropic.cjs');
const google = require('../../electron/api/byok/providers/google.cjs');
const perplexity = require('../../electron/api/byok/providers/perplexity.cjs');
const compatible = require('../../electron/api/byok/providers/openai-compatible.cjs');

function reset() { stub.resolve = null; stub.error = null; stub.last = null; stub.calls = 0; }


test('openai returns text + null toolCalls on success', async () => {
    reset();
    stub.resolve = { choices: [{ message: { content: 'hello' } }], model: 'gpt-5.5' };
    const r = await openai.call('sk-x', 'hi', {});
    assert.equal(r.text, 'hello');
    assert.equal(r.toolCalls, null);
});

test('openai THROWS on empty response (no content, no tool calls)', async () => {
    reset();
    stub.resolve = { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] };
    await assert.rejects(() => openai.call('sk-x', 'hi', {}), /no content/i);
});

test('openai does NOT throw when content empty but tool_calls present', async () => {
    reset();
    stub.resolve = { choices: [{ message: { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] } }] };
    const r = await openai.call('sk-x', 'hi', {});
    assert.equal(r.text, '');
    assert.ok(Array.isArray(r.toolCalls) && r.toolCalls.length === 1);
});


test('perplexity returns uniform { toolCalls: null } shape', async () => {
    reset();
    stub.resolve = { choices: [{ message: { content: 'pong' } }], model: 'sonar-pro' };
    const r = await perplexity.call('pplx-x', 'ping', {});
    assert.equal(r.text, 'pong');
    assert.ok('toolCalls' in r, 'response MUST include toolCalls key');
    assert.equal(r.toolCalls, null);
});

test('perplexity THROWS on empty response', async () => {
    reset();
    stub.resolve = { choices: [{ message: { content: '' } }] };
    await assert.rejects(() => perplexity.call('pplx-x', 'ping', {}), /no content/i);
});


test('anthropic merges consecutive same-role messages + extracts system', async () => {
    reset();
    stub.resolve = { content: [{ type: 'text', text: 'ok' }], model: 'claude-x' };
    await anthropic.call('sk-ant', [
        { role: 'system', content: 'sys-prompt' },
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
    ], {});
    const sent = stub.last.body;
    assert.equal(sent.system, 'sys-prompt', 'system must be lifted out');
    assert.equal(sent.messages.length, 1, 'two consecutive user turns must merge into one');
    assert.equal(sent.messages[0].role, 'user');
    assert.ok(Array.isArray(sent.messages[0].content), 'merged content becomes a block array');
    assert.equal(sent.messages[0].content.length, 2);
});

test('anthropic THROWS on empty response', async () => {
    reset();
    stub.resolve = { content: [], model: 'claude-x' };
    await assert.rejects(() => anthropic.call('sk-ant', 'hi', {}), /no content/i);
});


test('google URL-encodes the model id in the request path', async () => {
    reset();
    stub.resolve = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
    // A model id containing a slash must NOT be able to alter the URL path.
    await google.call('AIza', 'hi', { modelId: 'evil/../x' });
    assert.match(stub.last.endpoint, /evil%2F\.\.%2Fx/, 'slash must be percent-encoded');
    assert.ok(!stub.last.endpoint.includes('evil/../x'), 'raw path traversal must not appear');
});

test('google THROWS on safety block (no fake "[Blocked]" text)', async () => {
    reset();
    stub.resolve = { promptFeedback: { blockReason: 'SAFETY' } };
    await assert.rejects(() => google.call('AIza', 'hi', {}), /blocked/i);
});

test('google returns text on success', async () => {
    reset();
    stub.resolve = { candidates: [{ content: { parts: [{ text: 'gem-hi' }] } }] };
    const r = await google.call('AIza', 'hi', {});
    assert.equal(r.text, 'gem-hi');
});


test('openai-compatible returns text on success', async () => {
    reset();
    stub.resolve = { choices: [{ message: { content: 'compat-ok' } }], model: 'deepseek-chat' };
    const r = await compatible.call('key', 'hi', { provider: 'deepseek' });
    assert.equal(r.text, 'compat-ok');
});

test('openai-compatible aborts immediately on fatal 401 (no model fan-out)', async () => {
    reset();
    const e = new Error('invalid key');
    e.statusCode = 401;
    stub.error = e;
    await assert.rejects(() => compatible.call('key', 'hi', { provider: 'deepseek' }), /invalid key|401/i);
    assert.equal(stub.calls, 1, 'a 401 must abort after ONE attempt (no retry, no model fallback)');
});
