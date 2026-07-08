// Proxima — Smart Router Tests.
// Verifies task classification, capability-based routing, latency averages, unhealthy penalization, and health reports.

import test from 'node:test';
import assert from 'node:assert';
import { SmartRouter, PROVIDER_PROFILES } from '../../src/agentic/smart-router.js';

test('classifyTask detects security tasks', () => {
    const r = new SmartRouter();
    const types = r.classifyTask('find the sql injection vulnerability in auth');
    assert.ok(types.includes('security'));
});

test('classifyTask returns ["general"] when nothing matches', () => {
    const r = new SmartRouter();
    assert.deepEqual(r.classifyTask('hmm ok sure fine yes'), ['general']);
});

test('route sends a web-search query to perplexity over claude', () => {
    const r = new SmartRouter();
    const res = r.route('search for the latest news today about AI', new Set(['claude', 'perplexity']));
    assert.equal(res.provider, 'perplexity');
    assert.ok(res.score > 0);
    assert.ok(res.taskTypes.includes('web-search'));
});

test('route sends a code-review query to claude over perplexity', () => {
    const r = new SmartRouter();
    const res = r.route('please review this code function for quality', new Set(['claude', 'perplexity']));
    assert.equal(res.provider, 'claude');
});

test('route with no scorable providers returns a NaN-safe fallback', () => {
    const r = new SmartRouter();
    const res = r.route('anything', new Set(['claude']), { exclude: ['claude'] });
    assert.equal(res.score, 0);
    assert.deepEqual(res.allScores, {});
    assert.equal(res.provider, 'claude');
});

test('recordSuccess seeds then EMA-smooths avgResponseMs and clears errors', () => {
    const r = new SmartRouter();
    r.recordError('gemini', new Error('x'));
    r.recordSuccess('gemini', 1000);
    const m = r.metrics.gemini;
    assert.equal(m.avgResponseMs, 1000);
    assert.equal(m.consecutiveErrors, 0);
    r.recordSuccess('gemini', 2000);
    assert.equal(m.avgResponseMs, 1300);
});

test('three consecutive errors mark a provider unhealthy and penalise its score', () => {
    const r = new SmartRouter();
    const enabled = new Set(['claude', 'chatgpt']);
    const before = r.route('write code function', enabled).allScores.claude;
    for (let i = 0; i < 3; i++) r.recordError('claude', new Error('boom'));
    assert.equal(r.metrics.claude.isHealthy, false);
    const after = r.route('write code function', enabled).allScores.claude;
    assert.ok(after < before);
});

test('time-based recovery lifts the degraded penalty after cooldown', () => {
    const r = new SmartRouter();
    r._recoveryCooldownMs = -1;
    for (let i = 0; i < 3; i++) r.recordError('claude', new Error('boom'));
    assert.equal(r.metrics.claude.isHealthy, false);
    r.route('write code function', new Set(['claude']));
    assert.equal(r.metrics.claude.isHealthy, true);
    assert.equal(r.metrics.claude.consecutiveErrors, 0);
});

test('model-suffixed provider keys fold onto the base provider metrics', () => {
    const r = new SmartRouter();
    r.recordSuccess('gemini:2.5-flash', 500);
    assert.equal(r.metrics.gemini.totalCalls, 1);
});

test('BYOK provider without a profile still gets a baseline score', () => {
    const r = new SmartRouter();
    assert.equal(PROVIDER_PROFILES.myllm, undefined);
    const res = r.route('do a thing', new Set(['myllm']));
    assert.equal(res.provider, 'myllm');
    assert.ok(res.score >= 50);
});

test('pickByTaskType maps coarse buckets and returns the best provider', () => {
    const r = new SmartRouter();
    const best = r.pickByTaskType('research', new Set(['claude', 'perplexity']));
    assert.equal(best, 'perplexity');
});

test('getHealthReport marks disabled providers and reports mode', () => {
    const r = new SmartRouter();
    const report = r.getHealthReport(new Set(['claude']), false);
    assert.equal(report.claude.status, 'ready');
    assert.equal(report.claude.mode, 'session');
    assert.equal(report.chatgpt.status, 'disabled');
});
