// Proxima — Chat Middleware Pipeline Tests.
// Verifies provider routing, engine extraction, lazy provider resolution via getOrCreateProvider, and success/error recording.

import test from 'node:test';
import assert from 'node:assert';
import { createSmartChat } from '../../src/mcp/pipeline.js';

function makeDeps(overrides = {}) {
    const rec = { chatArgs: null, success: [], errors: [], usage: [] };
    const provider = {
        name: 'claude',
        chat: overrides.chat || (async (msg, useCache, filePath, engine) => {
            rec.chatArgs = { msg, useCache, filePath, engine };
            return 'model response';
        }),
    };
    const allProviders = { claude: provider, gemini: { name: 'gemini', chat: provider.chat } };
    const deps = {
        allProviders,
        getOrCreateProvider: (name) => allProviders[name] || null,
        agentState: { beginRun: () => ({ setState() {}, end() {} }) },
        lifecycle: { fire() {} },
        tracingManager: { startSpan: () => ({ startedAt: Date.now(), duration: 5 }), endSpan() {}, errorSpan() {} },
        smartRouterV2: { recordSuccess: (name, ms) => rec.success.push([name, ms]), recordError: (name, err) => rec.errors.push([name, err.message]) },
        tokenTracker: { logUsage: (u) => rec.usage.push(u) },
        enhancedMemory: { addToSession() {} },
        memoryStore: { addHistory: async () => {} },
        intelligentMemory: { add() {}, harvest() {}, stats: { totalAdded: 1 } },
    };
    return { deps, rec, provider };
}

test('smartChat: resolves a provider by name and returns provider.chat result', async () => {
    const { deps, rec } = makeDeps();
    const smartChat = createSmartChat(deps);
    const out = await smartChat('plain question', 'claude');
    assert.equal(out, 'model response');
    assert.equal(rec.chatArgs.msg, 'plain question');
    assert.equal(rec.chatArgs.useCache, true);
});

test('smartChat: derives the engine from a "provider:engine" name and forwards it to chat', async () => {
    const { deps, rec } = makeDeps();
    const smartChat = createSmartChat(deps);
    await smartChat('hi', 'gemini:3.5-flash');
    assert.equal(rec.chatArgs.engine, '3.5-flash', 'engine sub-model must reach provider.chat');
});

test('smartChat: an explicit options.engine takes precedence and filePath is forwarded', async () => {
    const { deps, rec } = makeDeps();
    const smartChat = createSmartChat(deps);
    await smartChat('hi', 'claude', { engine: 'claude-opus', filePath: '/img.png' });
    assert.equal(rec.chatArgs.engine, 'claude-opus');
    assert.equal(rec.chatArgs.filePath, '/img.png');
});

test('smartChat: accepts a { name, instance } provider object', async () => {
    const { deps } = makeDeps();
    const smartChat = createSmartChat(deps);
    const inst = { name: 'x', chat: async () => 'from-instance' };
    const out = await smartChat('hi', { name: 'x', instance: inst });
    assert.equal(out, 'from-instance');
});

test('smartChat: throws a clear error when the provider cannot be resolved', async () => {
    const { deps } = makeDeps();
    const smartChat = createSmartChat(deps);
    await assert.rejects(() => smartChat('hi', 'nonexistent'), /Provider not found/);
});

test('smartChat: lazily resolves a provider absent from allProviders via getOrCreateProvider', async () => {
    const { deps, rec } = makeDeps();
    const lazyInst = { name: 'deepseek', chat: async (msg) => { rec.chatArgs = { msg }; return 'lazy ok'; } };
    deps.getOrCreateProvider = (name) => (name === 'deepseek' ? lazyInst : null);
    const smartChat = createSmartChat(deps);
    const out = await smartChat('hi', 'deepseek');
    assert.equal(out, 'lazy ok');
    assert.equal(rec.chatArgs.msg, 'hi');
});

test('smartChat: records router success and logs cost with output tokens on success', async () => {
    const { deps, rec } = makeDeps();
    const smartChat = createSmartChat(deps);
    await smartChat('hi', 'claude');
    assert.equal(rec.success.length, 1);
    assert.equal(rec.success[0][0], 'claude');
    const lastUsage = rec.usage[rec.usage.length - 1];
    assert.equal(lastUsage.provider, 'claude');
    assert.ok(lastUsage.completionTokens > 0, 'a successful response logs output tokens');
});

test('smartChat: on provider failure it records the error, logs zero output tokens, and rethrows', async () => {
    const { deps, rec } = makeDeps({
        chat: async () => { const e = new Error('provider exploded'); e.retryable = false; throw e; },
    });
    const smartChat = createSmartChat(deps);
    await assert.rejects(() => smartChat('hi', 'claude'), /provider exploded/);
    assert.equal(rec.errors.length >= 1, true, 'the router must record the provider error');
    const failUsage = rec.usage.find((u) => u.completionTokens === 0);
    assert.ok(failUsage, 'a failed call still logs usage with zero completion tokens');
});
