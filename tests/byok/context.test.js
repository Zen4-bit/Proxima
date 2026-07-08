// Proxima — Context Pipeline Tests.
// Verifies token estimation heuristics, old tool output pruning, LLM-based turn condensing, and two-stage budget orchestration.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tokens = require('../../electron/api/byok/context/tokens.cjs');
const pruner = require('../../electron/api/byok/context/pruner.cjs');
const condenser = require('../../electron/api/byok/context/condenser.cjs');
const context = require('../../electron/api/byok/context/index.cjs');



test('tokens.estimate uses the chars/4 heuristic and handles non-strings', () => {
    assert.equal(tokens.estimate('12345678'), 2);
    assert.equal(tokens.estimate(''), 0);
    assert.ok(tokens.estimate({ a: 1 }) > 0);
});

test('tokens.forMessage adds per-message overhead and counts images flat', () => {
    const textMsg = { role: 'user', content: 'abcd' };
    assert.equal(tokens.forMessage(textMsg), 5);
    const imgMsg = { role: 'user', content: [{ type: 'image_url', image_url: {} }] };
    assert.equal(tokens.forMessage(imgMsg), tokens.IMAGE_TOKENS + 4);
});

test('tokens.forMessage includes tool_calls payload size', () => {
    const msg = { role: 'assistant', content: null, tool_calls: [{ function: { name: 'x', arguments: '{"k":"v"}' } }] };
    assert.ok(tokens.forMessage(msg) > 4, 'tool_calls contribute tokens');
});

test('tokens.forAll and perMessage aggregate correctly', () => {
    const msgs = [{ role: 'user', content: 'abcd' }, { role: 'assistant', content: 'abcd' }];
    assert.deepEqual(tokens.perMessage(msgs), [5, 5]);
    assert.equal(tokens.forAll(msgs), 10);
});



test('pruner summarizes an old, long tool result outside the protected tail', () => {
    const longOutput = 'x'.repeat(1000);
    const messages = [
        { role: 'tool', name: 'read_file', content: longOutput },
        { role: 'assistant', content: 'y'.repeat(100) },
    ];
    const { pruned, count } = pruner.prune(messages, 10); // tiny tail budget
    assert.equal(count, 1);
    assert.match(pruned[0].content, /\[read_file\]/);
    assert.ok(pruned[0].content.length < longOutput.length);
    assert.equal(messages[0].content.length, 1000);
});

test('pruner truncates bloated tool_call argument blobs', () => {
    const bigArgs = JSON.stringify({ code: 'a'.repeat(1000) });
    const messages = [
        { role: 'assistant', tool_calls: [{ function: { name: 'execute', arguments: bigArgs } }] },
        { role: 'assistant', content: 'recent tail'.repeat(50) },
    ];
    const { pruned, count } = pruner.prune(messages, 10);
    assert.equal(count, 1);
    assert.ok(pruned[0].tool_calls[0].function.arguments.length < bigArgs.length);
});

test('pruner protects the tail and leaves short messages alone', () => {
    const messages = [
        { role: 'user', content: 'short' },
        { role: 'assistant', content: 'also short' },
    ];
    const { pruned, count } = pruner.prune(messages, 8000);
    assert.equal(count, 0);
    assert.deepEqual(pruned, messages);
});

test('pruner handles an empty history', () => {
    assert.deepEqual(pruner.prune([]), { pruned: [], count: 0 });
});



test('condenser.isCondensed detects the condensed tag', () => {
    assert.equal(condenser.isCondensed({ content: `${condenser.CONDENSED_TAG} stuff` }), true);
    assert.equal(condenser.isCondensed({ content: 'normal message' }), false);
});

test('condense does nothing when there is no compressible middle', async () => {
    const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const out = await condenser.condense(messages, { callFn: async () => 'SUM', tailBudget: 8000 });
    assert.equal(out.condensed, false);
    assert.equal(out.result, messages);
});

test('condense summarizes the middle and replaces it with one message', async () => {
    const messages = [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'middle-1' },
        { role: 'assistant', content: 'middle-2' },
        { role: 'user', content: 'recent' },
    ];
    const out = await condenser.condense(messages, {
        callFn: async () => 'brief summary of the middle',
        headCount: 2,
        tailBudget: 1,
    });
    assert.equal(out.condensed, true);
    assert.ok(out.result.some((m) => typeof m.content === 'string' && m.content.startsWith(condenser.CONDENSED_TAG)));
});

test('condense inserts a deterministic fallback when the LLM call throws', async () => {
    const messages = [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'middle' },
        { role: 'assistant', content: 'more middle' },
        { role: 'user', content: 'recent' },
    ];
    const out = await condenser.condense(messages, {
        callFn: async () => { throw new Error('LLM down'); },
        headCount: 2,
        tailBudget: 1,
    });
    assert.equal(out.condensed, true);
    const summary = out.result.find((m) => typeof m.content === 'string' && m.content.startsWith(condenser.CONDENSED_TAG));
    assert.match(summary.content, /Summarization unavailable/);
});



test('context.process returns history unchanged when under the token budget', async () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const out = await context.process(messages, { threshold: 10_000_000 });
    assert.strictEqual(out, messages);
});

test('context.process condenses when over budget and a callFn is provided', async () => {
    const messages = [
        { role: 'user', content: 'a'.repeat(400) },
        { role: 'assistant', content: 'b'.repeat(400) },
        { role: 'user', content: 'c'.repeat(400) },
        { role: 'assistant', content: 'd'.repeat(400) },
        { role: 'user', content: 'e'.repeat(400) },
        { role: 'assistant', content: 'f'.repeat(400) },
    ];
    const out = await context.process(messages, {
        threshold: 100,
        tailBudget: 50,
        callFn: async () => 'the condensed summary',
    });
    assert.ok(out.length < messages.length, 'history was compressed');
    assert.ok(out.some((m) => typeof m.content === 'string' && m.content.includes('condensed summary')));
});

test('context.process hard-truncates when over budget and no callFn is available', async () => {
    const messages = Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i} `.repeat(40),
    }));
    const out = await context.process(messages, { threshold: 100, tailBudget: 50 });
    assert.ok(out.length < messages.length, 'middle messages dropped');
    assert.ok(out.some((m) => /earlier messages were removed/i.test(m.content || '')));
});
