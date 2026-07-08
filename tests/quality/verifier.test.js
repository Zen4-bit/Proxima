// Proxima — Quality Verifier Tests.
// Verifies raw and fenced JSON rubric parsing, fail-open behavior, prompt builder replacements, best-of-N selection, and fact checking.

import test from 'node:test';
import assert from 'node:assert';
import { QualityVerifier } from '../../src/quality/verifier.js';

const rubric = (o) => JSON.stringify({
    accuracy: o, completeness: o, relevance: o, clarity: o, overall: o, issues: 'none',
});

test('verify parses a raw JSON rubric and marks verified when overall >= minScore', async () => {
    const v = new QualityVerifier({ sendToModel: async () => rubric(8), minScore: 6 });
    const res = await v.verify('q', 'response text', 'gemini');
    assert.equal(res.scores.overall, 8);
    assert.equal(res.verified, true);
    assert.equal(res.recommendation, 'EXCELLENT');
    assert.equal(res.evaluator, 'gemini');
});

test('verify parses a rubric wrapped in a ```json``` code block', async () => {
    const fenced = '```json\n' + rubric(6) + '\n```';
    const v = new QualityVerifier({ sendToModel: async () => fenced });
    const res = await v.verify('q', 'r');
    assert.equal(res.scores.overall, 6);
    assert.equal(res.recommendation, 'ACCEPTABLE');
});

test('verify marks not-verified and REJECT for a low overall', async () => {
    const v = new QualityVerifier({ sendToModel: async () => rubric(3), minScore: 6 });
    const res = await v.verify('q', 'r');
    assert.equal(res.verified, false);
    assert.equal(res.recommendation, 'REJECT');
});

test('verify falls back to all-5 scores when output is not JSON', async () => {
    const v = new QualityVerifier({ sendToModel: async () => 'totally not json at all' });
    const res = await v.verify('q', 'r');
    assert.equal(res.scores.overall, 5);
    assert.equal(res.scores.issues, 'parse_error');
});

test('verify is fail-open when sendToModel throws', async () => {
    const v = new QualityVerifier({ sendToModel: async () => { throw new Error('provider offline'); } });
    const res = await v.verify('q', 'r');
    assert.equal(res.verified, true);
    assert.equal(res.scores, null);
    assert.equal(res.recommendation, 'VERIFICATION_FAILED');
    assert.match(res.error, /provider offline/);
});

test('verify builds the prompt correctly when the query contains a literal {response}', async () => {

    let captured = '';
    const v = new QualityVerifier({ sendToModel: async (_m, prompt) => { captured = prompt; return rubric(7); } });
    await v.verify('what does {response} mean?', 'THE_ANSWER_TEXT', 'gemini');
    assert.match(captured, /what does \{response\} mean\?/, 'query preserved verbatim, not overwritten');
    assert.match(captured, /THE_ANSWER_TEXT/, 'answer inserted');
    assert.doesNotMatch(captured, /AI RESPONSE TO EVALUATE:\s*\{response\}/, 'response slot must be filled');
});

test('bestOfN returns the candidate with the highest overall score', async () => {
    const sendToModel = async (model, prompt) => {
        if (/quality evaluator/i.test(prompt)) {
            const o = /answer-claude/.test(prompt) ? 9 : 5;
            return rubric(o);
        }
        return `answer-${model}`;
    };
    const v = new QualityVerifier({ sendToModel });
    const out = await v.bestOfN('q', ['chatgpt', 'claude']);
    assert.equal(out.best.model, 'claude');
    assert.equal(out.method, 'best-of-2');
    assert.equal(out.all.length, 2);
});

test('bestOfN records an error entry when a model fails', async () => {
    const sendToModel = async (model, prompt) => {
        if (model === 'chatgpt' && !/quality evaluator/i.test(prompt)) throw new Error('chatgpt down');
        if (/quality evaluator/i.test(prompt)) return rubric(7);
        return `answer-${model}`;
    };
    const v = new QualityVerifier({ sendToModel });
    const out = await v.bestOfN('q', ['claude', 'chatgpt']);
    const failed = out.all.find((r) => r.model === 'chatgpt');
    assert.equal(failed.response, null);
    assert.match(failed.error, /chatgpt down/);
});

test('factCheck returns parsed verdict plus the checker model', async () => {
    const sendToModel = async () => '{"accurate": false, "correction": "it is 8 not 7", "confidence": 9}';
    const v = new QualityVerifier({ sendToModel, evaluatorModel: 'gemini' });
    const res = await v.factCheck('7 is even');
    assert.equal(res.accurate, false);
    assert.equal(res.confidence, 9);
    assert.equal(res.checker, 'gemini');
});

test('factCheck degrades gracefully when the model throws', async () => {
    const v = new QualityVerifier({ sendToModel: async () => { throw new Error('boom'); } });
    const res = await v.factCheck('some claim', 'claude');
    assert.equal(res.accurate, null);
    assert.match(res.error, /boom/);
    assert.equal(res.checker, 'claude');
});
