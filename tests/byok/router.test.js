// Proxima — BYOK Dispatch Router Tests.
// Verifies routing to native/extended connectors, history forwarding, unknown provider rejections, and missing key/message validation.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const router = require('../../electron/api/byok/router.cjs');
const openai = require('../../electron/api/byok/providers/openai.cjs');
const anthropic = require('../../electron/api/byok/providers/anthropic.cjs');
const compatible = require('../../electron/api/byok/providers/openai-compatible.cjs');

const originals = new Map();
function stub(mod, impl) {
    if (!originals.has(mod)) originals.set(mod, mod.call);
    mod.call = impl;
}
test.afterEach(() => {
    for (const [mod, orig] of originals) mod.call = orig;
    originals.clear();
});

test('callProvider: routes a core provider to its native connector with provider injected', async () => {
    let captured;
    stub(openai, async (key, msg, opts) => { captured = { key, msg, opts }; return { text: 'hi', toolCalls: null, model: 'gpt-5.5', responseTimeMs: 5 }; });
    const res = await router.callProvider('chatgpt', 'sk-key', 'hello');
    assert.equal(res.text, 'hi');
    assert.equal(captured.key, 'sk-key');
    assert.equal(captured.msg, 'hello');
    assert.equal(captured.opts.provider, 'chatgpt', 'provider name must be injected for the connector');
});

test('callProvider: routes claude to the anthropic connector', async () => {
    let hit = false;
    stub(anthropic, async () => { hit = true; return { text: 'x', toolCalls: null, model: 'm', responseTimeMs: 1 }; });
    await router.callProvider('claude', 'sk', 'hi');
    assert.ok(hit);
});

test('callProvider: routes custom provider with endpoint to compatible connector', async () => {
    let capturedOpts;
    stub(compatible, async (key, msg, opts) => { capturedOpts = opts; return { text: 'x', toolCalls: null, model: 'm', responseTimeMs: 1 }; });
    await router.callProvider('deepseek', 'sk', 'hi');
    assert.equal(capturedOpts.provider, 'deepseek');
});

test('callProvider: forwards message arrays intact to the connector', async () => {
    let captured;
    stub(openai, async (key, msg) => { captured = msg; return { text: 'x', toolCalls: null, model: 'm', responseTimeMs: 1 }; });
    const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    await router.callProvider('chatgpt', 'sk', history);
    assert.deepEqual(captured, history);
});

test('callProvider: throws a helpful error for an unknown provider with no custom endpoint', async () => {
    await assert.rejects(() => router.callProvider('nonexistent', 'sk', 'hi'), /Unknown provider: "nonexistent"/);
});

test('callProvider: throws when the API key is missing or not a string', async () => {
    await assert.rejects(() => router.callProvider('chatgpt', '', 'hi'), /No API key/);
    await assert.rejects(() => router.callProvider('chatgpt', null, 'hi'), /No API key/);
});

test('callProvider: throws when no message/history is provided', async () => {
    await assert.rejects(() => router.callProvider('chatgpt', 'sk', null), /No message or history/);
    await assert.rejects(() => router.callProvider('chatgpt', 'sk', 123), /No message or history/);
});

test('callProvider: retries other fallback models if the first model fails with 404/503', async () => {
    let attemptedModels = [];
    stub(openai, async (key, msg, opts) => {
        attemptedModels.push(opts.modelId);
        if (opts.modelId === 'gpt-5.5') {
            const err = new Error('Model retired');
            err.statusCode = 404;
            throw err;
        }
        return { text: 'fallback-success', toolCalls: null, model: opts.modelId, responseTimeMs: 5 };
    });

    const res = await router.callProvider('chatgpt', 'sk-key', 'hello', { modelId: 'auto' });
    assert.equal(res.text, 'fallback-success');
    assert.equal(res.model, 'gpt-4o');
    assert.deepEqual(attemptedModels, ['gpt-5.5', 'gpt-4o']);
});

test('callProvider: does NOT retry fallback models if auth fails (401)', async () => {
    let attemptedModels = [];
    stub(openai, async (key, msg, opts) => {
        attemptedModels.push(opts.modelId);
        const err = new Error('Invalid API key');
        err.statusCode = 401;
        throw err;
    });

    await assert.rejects(
        () => router.callProvider('chatgpt', 'sk-key', 'hello', { modelId: 'auto' }),
        /Invalid API key/
    );
    assert.deepEqual(attemptedModels, ['gpt-5.5']);
});
