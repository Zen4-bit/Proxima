// Proxima — MCP Shared Prompt Runner Tests.
// Verifies prompt runner initialization, provider resolution, direct short-circuiting, and build/chat error mappings.

import test from 'node:test';
import assert from 'node:assert';
import { createPromptRunner } from '../../src/mcp/_shared.js';
import { toolResponse, toolError } from '../../src/mcp/helpers.js';

function makeRunner(overrides = {}) {
    const deps = { resolveProvider: () => ({ name: 'claude' }), smartChat: async () => 'model reply', toolResponse, toolError, ...overrides };
    return createPromptRunner(deps);
}

test('createPromptRunner: throws when a required dependency is missing', () => {
    assert.throws(() => createPromptRunner({}), /missing required dependency/);
    assert.throws(() => createPromptRunner({ resolveProvider: () => {}, smartChat: () => {}, toolResponse }), /missing required dependency/);
});

test('runPrompt: returns "No providers enabled" when no provider resolves', async () => {
    const run = makeRunner({ resolveProvider: () => null });
    const res = await run(null, 'coding', () => 'prompt');
    assert.equal(res.content[0].text, 'No providers enabled');
});

test('runPrompt: a string from build is sent to smartChat and its reply is returned', async () => {
    let received;
    const run = makeRunner({ smartChat: async (prompt, provider) => { received = { prompt, provider }; return 'answer'; } });
    const res = await run('claude', 'coding', () => 'my prompt');
    assert.equal(received.prompt, 'my prompt');
    assert.equal(received.provider.name, 'claude');
    assert.equal(res.content[0].text, 'answer');
});

test('runPrompt: a { direct } result short-circuits and never calls smartChat', async () => {
    let called = false;
    const run = makeRunner({ smartChat: async () => { called = true; return 'x'; } });
    const res = await run(null, 'coding', () => ({ direct: 'file not found' }));
    assert.equal(res.content[0].text, 'file not found');
    assert.equal(called, false, 'direct results must not trigger a model call');
});

test('runPrompt: an error thrown in build is converted to a toolError', async () => {
    const run = makeRunner();
    const res = await run(null, 'coding', () => { throw new Error('build failed'); });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /build failed/);
});

test('runPrompt: an error thrown by smartChat is converted to a toolError', async () => {
    const run = makeRunner({ smartChat: async () => { throw new Error('provider down'); } });
    const res = await run('claude', 'coding', () => 'prompt');
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /provider down/);
});
