// Proxima — Run Loop Tests.
// Verifies iterative generate-and-review loops, score extraction, convergence checks, and statistics.

import test from 'node:test';
import assert from 'node:assert';
import { RunLoop } from '../../src/agentic/run-loop.js';

const isReviewPrompt = (p) => /OUTPUT TO REVIEW/.test(p);

test('converges on turn 1 when the reviewer approves', async () => {
    const loop = new RunLoop();
    const chatFn = async (provider, prompt) => {
        if (isReviewPrompt(prompt)) return 'Great work. SCORE: 10/10\nAPPROVED';
        return 'the generated solution';
    };
    const res = await loop.execute({
        task: 'write a function',
        provider: 'chatgpt',
        reviewProvider: 'claude',
        chatFn,
        enabledProviders: new Set(['chatgpt', 'claude']),
    });
    assert.equal(res.converged, true);
    assert.equal(res.iterations.length, 1);
    assert.equal(res.summary.finalScore, 10);
    assert.equal(loop.getStats().convergedEarly, 1);
});

test('runs to maxTurns when the reviewer keeps scoring low', async () => {
    const loop = new RunLoop();
    const chatFn = async (provider, prompt) => {
        if (isReviewPrompt(prompt)) return 'Needs work. SCORE: 4/10\nISSUES:\n- more detail';

        return `output ${Math.random()}`;
    };
    const res = await loop.execute({
        task: 'improve this',
        provider: 'chatgpt',
        reviewProvider: 'claude',
        maxTurns: 3,
        chatFn,
        enabledProviders: new Set(['chatgpt', 'claude']),
    });
    assert.equal(res.converged, false);
    assert.equal(res.iterations.length, 3);
    assert.equal(loop.getStats().maxTurnsHit, 1);
});

test('auto-routes the primary provider via SmartRouter when none given', async () => {
    const smartRouter = {
        route: () => ({ provider: 'gemini', reason: 'picked' }),
        recordSuccess() {}, recordError() {},
    };
    const loop = new RunLoop({ smartRouter });
    const chatFn = async (provider, prompt) => {
        if (isReviewPrompt(prompt)) return 'SCORE: 9/10 APPROVED';
        return 'gen';
    };
    const res = await loop.execute({
        task: 'do something',
        chatFn,
        enabledProviders: new Set(['gemini', 'claude']),
    });
    assert.equal(res.summary.primaryProvider, 'gemini');
    assert.notEqual(res.summary.reviewProvider, 'gemini');
});

test('_extractScore parses the various documented formats', () => {
    const loop = new RunLoop();
    assert.equal(loop._extractScore('SCORE: 7/10'), 7);
    assert.equal(loop._extractScore('I would rate this 8/10 overall'), 8);
    assert.equal(loop._extractScore('score: 6 for this'), 6);
    assert.equal(loop._extractScore('This is APPROVED'), 9);
    assert.equal(loop._extractScore('no number here'), 5);
});

test('_similarity returns 1 for identical text and <1 for divergent text', () => {
    const loop = new RunLoop();
    assert.equal(loop._similarity('the quick brown fox', 'the quick brown fox'), 1);
    const partial = loop._similarity('the quick brown fox', 'the slow green turtle');
    assert.ok(partial > 0 && partial < 1);
});

test('converges early via high similarity between consecutive outputs', async () => {
    const loop = new RunLoop();

    const chatFn = async (provider, prompt) => {
        if (isReviewPrompt(prompt)) return 'SCORE: 6/10\nISSUES:\n- minor';
        return 'identical stable output that does not change between turns at all';
    };
    const res = await loop.execute({
        task: 't', provider: 'chatgpt', reviewProvider: 'claude', maxTurns: 5,
        chatFn, enabledProviders: new Set(['chatgpt', 'claude']),
    });
    assert.equal(res.converged, true);
    assert.ok(res.iterations.length <= 2, 'converged by similarity on the 2nd turn');
});
