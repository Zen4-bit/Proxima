// Proxima — Fact Extractor Tests.
// Verifies behavior of FactStore (deduplication, performance tracking, routing) and FactExtractor (fact extraction and performance classification).

import test from 'node:test';
import assert from 'node:assert';
import { FactExtractor, FactStore } from '../../src/agentic/fact-extractor.js';



test('FactStore.addFact stores and dedupes case-insensitively', () => {
    const s = new FactStore();
    s.addFact('tech-stack', 'PostgreSQL');
    s.addFact('tech-stack', 'postgresql');
    assert.equal(s.getFacts('tech-stack').length, 1);
    assert.equal(s.totalFacts, 1);
});

test('FactStore.addFact rejects content shorter than 3 chars', () => {
    const s = new FactStore();
    s.addFact('preference', 'ab');
    s.addFact('preference', '   ');
    assert.equal(s.totalFacts, 0);
});

test('FactStore.recordPerformance tracks calls and rolling average latency', () => {
    const s = new FactStore();
    s.recordPerformance('chatgpt', 'accurate', 100);
    s.recordPerformance('chatgpt', 'accurate', 300);
    const perf = s.getPerformance('chatgpt');
    assert.equal(perf.totalCalls, 2);
    assert.equal(perf.avgResponseTime, 200);
    assert.equal(perf.scores.accurate, 2);
});

test('FactStore.getBestProvider picks the highest metric score', () => {
    const s = new FactStore();
    s.recordPerformance('a', 'accurate', 100);
    s.recordPerformance('b', 'accurate', 100);
    s.recordPerformance('b', 'accurate', 100);
    assert.equal(s.getBestProvider('accurate'), 'b');
});

test('FactStore.getBestProvider("fast") favours lower latency', () => {
    const s = new FactStore();
    s.recordPerformance('slow', 'accurate', 5000);
    s.recordPerformance('fast', 'accurate', 100);
    assert.equal(s.getBestProvider('fast'), 'fast');
});

test('FactStore.getAllFacts returns category → content[]', () => {
    const s = new FactStore();
    s.addFact('preference', 'Vue.js');
    const all = s.getAllFacts();
    assert.deepEqual(all.preference, ['Vue.js']);
});



test('extract pulls a preference fact from the user message', () => {
    const ex = new FactExtractor();
    const facts = ex.extract('I prefer Vue.js for frontend work', 'sure, Vue is great');
    assert.ok(facts.some((f) => /preference/.test(f) && /vue/i.test(f)));
    assert.ok(ex.getStore().getFacts('preference').length >= 1);
});

test('extract pulls a tech-stack fact ("built with X")', () => {
    const ex = new FactExtractor();
    const facts = ex.extract('the app is built with FastAPI', 'noted');
    assert.ok(facts.some((f) => /tech-stack/.test(f)));
});

test('extract records provider performance when metadata.provider is set', () => {
    const ex = new FactExtractor();
    ex.extract('hello', 'hi there', { provider: 'gemini', qualityScore: 9, responseTimeMs: 500 });
    const perf = ex.getStore().getPerformance('gemini');
    assert.equal(perf.totalCalls, 1);
    assert.equal(perf.scores.accurate, 1);
});



const classifyCases = [
    { q: 1, metric: 'refused' },
    { q: 3, metric: 'vague' },
    { q: 4, metric: 'vague' },
    { q: 5, metric: 'vague' },
    { q: 6, metric: 'detailed' },
    { q: 7, metric: 'detailed' },
    { q: 8, metric: 'accurate' },
    { q: 10, metric: 'accurate' },
];

for (const { q, metric } of classifyCases) {
    test(`qualityScore ${q} classifies as '${metric}'`, () => {
        const ex = new FactExtractor();
        ex.extract('m', 'r', { provider: 'p', qualityScore: q });
        const perf = ex.getStore().getPerformance('p');
        assert.equal(perf.scores[metric], 1, `q=${q} should increment ${metric}`);
    });
}

test('no qualityScore + very slow response is counted in the slow bucket', () => {
    const ex = new FactExtractor();
    ex.extract('m', 'r', { provider: 'p', responseTimeMs: 40000 });
    const perf = ex.getStore().getPerformance('p');

    assert.equal(perf.scores.slow, 1);
    assert.equal(perf.scores.accurate, 0);
    assert.equal(perf.totalCalls, 1);
});

test('getRoutingContext surfaces facts and providers with >=3 calls', () => {
    const ex = new FactExtractor();
    ex.extract('I prefer TypeScript', 'ok');
    const store = ex.getStore();
    for (let i = 0; i < 3; i++) store.recordPerformance('claude', 'detailed', 200);
    const ctx = ex.getRoutingContext();
    assert.match(ctx, /preference/);
    assert.match(ctx, /claude/);
});

test('getRoutingContext is empty when nothing has been learned', () => {
    const ex = new FactExtractor();
    assert.equal(ex.getRoutingContext(), '');
});
