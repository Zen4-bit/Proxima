// Proxima — Response Evaluator Tests.
// Verifies behavior of response quality evaluation, hallucination risks, and routing recommendations.

import test from 'node:test';
import assert from 'node:assert';
import { ResponseEvaluator } from '../../src/agentic/response-evaluator.js';

test('empty response scores 0 and recommends reroute', () => {
    const ev = new ResponseEvaluator();
    const r = ev.evaluate('', 'how do I sort an array?');
    assert.equal(r.score, 0);
    assert.equal(r.action, 'reroute');
    assert.ok(r.flags.includes('empty-response'));
});

test('whitespace-only response is treated as empty', () => {
    const ev = new ResponseEvaluator();
    const r = ev.evaluate('    \n  ', 'question');
    assert.equal(r.score, 0);
    assert.ok(r.flags.includes('empty-response'));
});

test('a refusal ("I can\'t help") is penalised and flagged', () => {
    const ev = new ResponseEvaluator();

    const r = ev.evaluate("I can't help with that request.", 'write code to parse json');
    assert.ok(r.flags.includes('refusal'));
    assert.ok(r.score < 7, 'penalised below the neutral baseline');
});

test('high-quality answer with a code block scores well and is accepted', () => {
    const ev = new ResponseEvaluator();
    const question = 'how do I sort an array in javascript?';
    const response = [
        'You can sort an array because the built-in method mutates it. For example:',
        '```js',
        'const arr = [3, 1, 2];',
        'arr.sort((a, b) => a - b);',
        'console.log(arr);',
        '```',
        'First define the array, then call sort with a comparator.',
    ].join('\n');
    const r = ev.evaluate(response, question);
    assert.ok(r.flags.includes('has-code'));
    assert.ok(r.score >= 7, `expected strong score, got ${r.score}`);
    assert.equal(r.action, 'accept');
});

test('unsourced "studies show" claim raises hallucination risk and asks to verify', () => {
    const ev = new ResponseEvaluator();
    const question = 'is coffee good for productivity?';

    const response =
        'Coffee and productivity: studies show that caffeine improves focus and productivity ' +
        'for most people because it blocks adenosine. Coffee productivity benefits vary by person.';
    const r = ev.evaluate(response, question);
    assert.ok(r.hallucinationRisk >= 3);
    assert.ok(r.flags.some((f) => f.includes('unsourced-claim')));
    assert.equal(r.action, 'verify');
});

test('off-topic answer is flagged low-relevance', () => {
    const ev = new ResponseEvaluator();
    const r = ev.evaluate(
        'The weather today is sunny with a gentle breeze across the coastal plains.',
        'explain quicksort partitioning recursion pivot',
    );
    assert.ok(r.flags.includes('low-relevance'));
});

test('relevanceRatio is higher for an on-topic response', () => {
    const ev = new ResponseEvaluator();
    const q = 'explain database indexing performance';
    const onTopic = ev.evaluate(
        'Database indexing improves performance because an index avoids scanning every row.',
        q,
    );
    const offTopic = ev.evaluate(
        'Bananas are yellow and grow on trees in tropical regions worldwide.',
        q,
    );
    assert.ok(onTopic.relevanceRatio > offTopic.relevanceRatio);
});

test('score is clamped to the 1..10 range', () => {
    const ev = new ResponseEvaluator();

    const great = ev.evaluate(
        '```js\nconst x=1;\nconst y=2;\n```\nFirst, because of this. For example https://a.b | c | d |',
        'code example',
    );
    assert.ok(great.score <= 10 && great.score >= 1);
});

test('pickBest returns the highest-scoring candidate', () => {
    const ev = new ResponseEvaluator();
    const q = 'how to reverse a string in python';
    const best = ev.pickBest(
        [
            { provider: 'a', response: 'I am not sure, maybe try something.' },
            {
                provider: 'b',
                response: '```python\ns = "abc"\nprint(s[::-1])  # reverse\n```\nThis works because slicing.',
            },
        ],
        q,
    );
    assert.equal(best.provider, 'b');
    assert.ok(best.evaluation.score > 0);
});

test('pickBest handles single and empty candidate lists', () => {
    const ev = new ResponseEvaluator();
    assert.equal(ev.pickBest([], 'q'), null);
    const single = ev.pickBest([{ provider: 'x', response: 'hello there world' }], 'q');
    assert.equal(single.provider, 'x');
    assert.ok(single.evaluation);
});

test('checkConsensus: near-identical texts agree, unrelated texts do not', () => {
    const ev = new ResponseEvaluator();
    const agree = ev.checkConsensus([
        'the quick brown fox jumps over lazy dogs repeatedly today',
        'the quick brown fox jumps over lazy dogs repeatedly today indeed',
    ]);
    assert.ok(agree.agreementScore > 0.3);
    assert.equal(agree.agreementCount, 2);

    const disagree = ev.checkConsensus([
        'photosynthesis converts sunlight into chemical energy inside chloroplasts',
        'quarterly revenue exceeded analyst expectations across every regional market',
    ]);
    assert.ok(disagree.agreementScore <= 0.3);
    assert.equal(disagree.agreementCount, 1);
});

test('checkConsensus: fewer than two responses trivially agree', () => {
    const ev = new ResponseEvaluator();
    assert.deepEqual(ev.checkConsensus(['only one']), { agreementScore: 1, agreementCount: 1 });
});

test('stats accumulate totalEvaluations and reRouteRecommendations', () => {
    const ev = new ResponseEvaluator();
    ev.evaluate('', 'q');                       // reroute (empty)
    ev.evaluate('I do not know anything.', 'q'); // likely reroute
    const stats = ev.getStats();
    assert.equal(stats.totalEvaluations, 2);
    assert.ok(stats.reRouteRecommendations >= 1);
});
