// Proxima — Context7 Middleware Tests.
// Verifies library doc auto-injections, default disabled behavior, network caching, and error resilience.

import test from 'node:test';
import assert from 'node:assert';
import {
    detectLibraries,
    contextMiddleware,
    getContextStats,
    recordContextUse,
} from '../../src/agentic/context7-middleware.js';

const origFetch = global.fetch;
const origEnv = process.env.PROXIMA_CONTEXT7;

test.afterEach(() => {
    global.fetch = origFetch;
    if (origEnv === undefined) delete process.env.PROXIMA_CONTEXT7;
    else process.env.PROXIMA_CONTEXT7 = origEnv;
});

test('detectLibraries finds react and dedupes repeated mentions', () => {
    const libs = detectLibraries('I use react hooks and useState in my react app');
    assert.ok(libs.includes('react'));

    assert.equal(libs.filter((l) => l === 'react').length, 1);
});

test('detectLibraries returns empty array when no library is mentioned', () => {
    assert.deepEqual(detectLibraries('just a plain sentence about cooking dinner'), []);
});

test('contextMiddleware is disabled by default and never calls fetch', async () => {
    delete process.env.PROXIMA_CONTEXT7;
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };

    const res = await contextMiddleware('a long message that mentions react and hooks and useState');
    assert.equal(res.skipped, true);
    assert.deepEqual(res.injected, []);
    assert.equal(res.enhancedMessage, 'a long message that mentions react and hooks and useState');
    assert.equal(fetchCalled, false, 'network must not be touched when disabled');
});

test('contextMiddleware skips very short messages even when enabled', async () => {
    process.env.PROXIMA_CONTEXT7 = '1';
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    const res = await contextMiddleware('react');
    assert.equal(res.skipped, true);
    assert.equal(fetchCalled, false);
});

test('contextMiddleware injects docs when enabled and a library is detected', async () => {
    process.env.PROXIMA_CONTEXT7 = '1';
    let calls = 0;
    global.fetch = async () => {
        calls++;
        return { ok: true, json: async () => ({ context: 'PRISMA_DOCS_BODY' }) };
    };

    const msg = 'How do I define a prisma schema relation for a one-to-many model today?';
    const res = await contextMiddleware(msg, { maxLibraries: 1 });
    assert.equal(res.skipped, false);
    assert.deepEqual(res.injected, ['prisma']);
    assert.match(res.enhancedMessage, /PRISMA_DOCS_BODY/);
    assert.ok(res.enhancedMessage.endsWith(msg), 'original message preserved at the end');

    const before = calls;
    await contextMiddleware(msg, { maxLibraries: 1 });
    assert.equal(calls, before, 'cached lookup avoids a second network call');
});

test('contextMiddleware degrades gracefully when fetch rejects', async () => {
    process.env.PROXIMA_CONTEXT7 = '1';
    global.fetch = async () => { throw new Error('network down'); };
    const res = await contextMiddleware('a question about the django rest framework and drf views please', { maxLibraries: 1 });
    assert.equal(res.skipped, true);
    assert.deepEqual(res.injected, []);
});

test('contextMiddleware degrades when the response is not ok', async () => {
    process.env.PROXIMA_CONTEXT7 = '1';
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    const res = await contextMiddleware('a detailed question about svelte kit routing and load functions', { maxLibraries: 1 });
    assert.equal(res.skipped, true);
});

test('recordContextUse tallies checks, injections, and per-library hits', () => {
    const before = getContextStats();
    recordContextUse(['react', 'vue']);
    recordContextUse([]);
    const after = getContextStats();
    assert.equal(after.totalChecks, before.totalChecks + 2);
    assert.equal(after.totalInjections, before.totalInjections + 1);
    assert.ok(after.libraryHits.react >= 1);
});
