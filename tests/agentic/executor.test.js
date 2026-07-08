// Proxima — Agentic Executor Tests.
// Verifies agent execution strategies (direct, verify, consensus, collaborate) and statistics aggregation.

import test from 'node:test';
import assert from 'node:assert';
import { AgenticExecutor } from '../../src/agentic/executor.js';


const EXCELLENT = [
    'You can do this because the approach is well understood. For example:',
    '```js',
    'function solve(input) {',
    '  return input.map((x) => x * 2);',
    '}',
    '```',
    'First, define the function. Second, call it with your data. Finally, inspect the result.',
    'See https://example.com/docs for more detail on the reasoning behind this.',
].join('\n');

const MEDIOCRE = 'The topic has a long background and several relevant aspects worth considering here.';

function makeExecutor(chatFn, providers) {
    return new AgenticExecutor({
        chatFn,
        getEnabledProviders: () => new Set(providers),
    });
}

test('constructor requires chatFn and getEnabledProviders', () => {
    assert.throws(() => new AgenticExecutor({}), /chatFn/);
    assert.throws(() => new AgenticExecutor({ chatFn: () => {} }), /getEnabledProviders/);
});

test('execute returns an error when no providers are enabled', async () => {
    const ex = makeExecutor(async () => 'x', []);
    const res = await ex.execute('hello');
    assert.equal(res.error, 'No providers enabled');
    assert.equal(res.response, null);
});

test('DIRECT strategy returns the response with an evaluation', async () => {
    const ex = makeExecutor(async () => EXCELLENT, ['chatgpt']);
    const res = await ex.execute('write a doubling function');
    assert.equal(res.response, EXCELLENT);
    assert.equal(res.primaryProvider, 'chatgpt');
    assert.deepEqual(res.providersUsed, ['chatgpt']);
    assert.ok(res.evaluation.score >= 8);
    assert.equal(res.plan.strategy, 'direct');
});

test('VERIFY skips the second call when the primary answer is excellent', async () => {
    let evalCalls = 0;
    const chatFn = async (provider, prompt) => {
        if (/quality evaluator/i.test(prompt)) { evalCalls++; return '{"overall":9}'; }
        return EXCELLENT;
    };
    const ex = makeExecutor(chatFn, ['claude', 'gemini']);
    const res = await ex.execute('produce the solution', { forceVerify: true });
    assert.equal(res.verified, false);
    assert.equal(evalCalls, 0);
    assert.equal(res.providersUsed.length, 1);
});

test('VERIFY combines primary + positive cross-check into an annotated answer', async () => {
    const chatFn = async (provider, prompt) => {
        if (/quality evaluator/i.test(prompt)) {
            return JSON.stringify({ accuracy: 7, completeness: 7, relevance: 7, clarity: 7, overall: 7, issues: 'none' });
        }
        return MEDIOCRE;
    };
    const ex = makeExecutor(chatFn, ['claude', 'gemini']);
    const res = await ex.execute('give a mediocre-ish answer', { forceVerify: true });
    assert.equal(res.verified, true);
    assert.match(res.response, /Cross-model verification/);
    assert.equal(res.providersUsed.length, 2);
    assert.equal(res.crossScore, 7);
});

test('VERIFY switches to the verifier redo when the cross-check is negative', async () => {
    const chatFn = async (provider, prompt) => {
        if (/quality evaluator/i.test(prompt)) {
            return JSON.stringify({ accuracy: 3, completeness: 3, relevance: 3, clarity: 3, overall: 3, issues: 'weak' });
        }
        if (/VERIFY the following/i.test(prompt)) return 'the verifier redo answer';
        return MEDIOCRE;
    };
    const ex = makeExecutor(chatFn, ['claude', 'gemini']);
    const res = await ex.execute('answer this task', { forceVerify: true });
    assert.equal(res.switchedProvider, true);
    assert.equal(res.response, 'the verifier redo answer');
    assert.equal(res.crossScore, 3);
});

test('CONSENSUS asks all voters and picks the best response', async () => {
    const chatFn = async (provider) => (provider === 'claude' ? EXCELLENT : 'I am not sure about this.');
    const ex = makeExecutor(chatFn, ['claude', 'chatgpt']);
    const res = await ex.execute('what is the answer', { forceConsensus: true });
    assert.equal(res.primaryProvider, 'claude');
    assert.ok(res.consensus);
    assert.equal(res.providersUsed.length, 2);
});

test('COLLABORATE runs role-ordered contributions and returns the final output', async () => {
    const chatFn = async (provider, prompt) => `output-from-${provider}`;
    const ex = makeExecutor(chatFn, ['perplexity', 'claude', 'chatgpt']);
    const res = await ex.execute('research then build then explain this', { forceCollaborate: true });
    assert.ok(res.collaborationSteps.length >= 2);
    assert.match(res.response, /^output-from-/);
    assert.ok(res.providersUsed.length >= 2);
});

test('getStats aggregates orchestrator, evaluator and fact stats', async () => {
    const ex = makeExecutor(async () => EXCELLENT, ['chatgpt']);
    await ex.execute('write code');
    const stats = ex.getStats();
    assert.equal(stats.totalExecutions, 1);
    assert.ok(stats.orchestrator);
    assert.ok(stats.evaluator);
    assert.equal(typeof stats.facts, 'number');
});
