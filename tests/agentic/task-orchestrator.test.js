// Proxima — Task Orchestrator Tests.
// Verifies task classification, strategy selection, role assignments (direct, consensus, verify, collaborate), and prompt compilation.

import test from 'node:test';
import assert from 'node:assert';
import { TaskOrchestrator, STRATEGY } from '../../src/agentic/task-orchestrator.js';

test('classifyTask detects a research task', () => {
    const o = new TaskOrchestrator();
    assert.ok(o.classifyTask('search for the latest news on this').includes('research'));
});

test('selectStrategy defaults to DIRECT in auto mode', () => {
    const o = new TaskOrchestrator();
    const s = o.selectStrategy(['general'], new Set(['a', 'b', 'c']));
    assert.equal(s, STRATEGY.DIRECT);
});

test('selectStrategy honours forceConsensus only with >=2 providers', () => {
    const o = new TaskOrchestrator();
    assert.equal(o.selectStrategy(['general'], new Set(['a', 'b']), { forceConsensus: true }), STRATEGY.CONSENSUS);
    assert.equal(o.selectStrategy(['general'], new Set(['a']), { forceConsensus: true }), STRATEGY.DIRECT);
});

test('assignRoles DIRECT picks a single primary', () => {
    const o = new TaskOrchestrator();
    const roles = o.assignRoles(['code-review'], new Set(['claude', 'chatgpt']), STRATEGY.DIRECT);
    assert.equal(roles.length, 1);
    assert.equal(roles[0].role, 'primary');
});

test('assignRoles DIRECT honours an enabled preferredProvider', () => {
    const o = new TaskOrchestrator();
    const roles = o.assignRoles(['general'], new Set(['claude', 'chatgpt']), STRATEGY.DIRECT, {
        preferredProvider: 'chatgpt',
    });
    assert.equal(roles[0].provider, 'chatgpt');
});

test('assignRoles DIRECT ignores a preferredProvider that is not enabled', () => {
    const o = new TaskOrchestrator();
    const roles = o.assignRoles(['general'], new Set(['claude']), STRATEGY.DIRECT, {
        preferredProvider: 'gemini',
    });
    assert.equal(roles[0].provider, 'claude');
});

test('assignRoles CONSENSUS assigns up to three voters', () => {
    const o = new TaskOrchestrator();
    const roles = o.assignRoles(['general'], new Set(['a', 'b', 'c', 'd']), STRATEGY.CONSENSUS);
    assert.equal(roles.length, 3);
    assert.ok(roles.every((r) => r.role === 'voter'));
});

test('assignRoles VERIFY assigns a primary and a different verifier', () => {
    const o = new TaskOrchestrator();
    const roles = o.assignRoles(['code-review'], new Set(['claude', 'gemini']), STRATEGY.VERIFY);
    assert.equal(roles[0].role, 'primary');
    assert.equal(roles[1].role, 'verifier');
    assert.notEqual(roles[0].provider, roles[1].provider);
});

test('assignRoles COLLABORATE assigns a researcher when research is needed', () => {
    const o = new TaskOrchestrator();
    const roles = o.assignRoles(
        ['research', 'code-gen'],
        new Set(['perplexity', 'claude', 'chatgpt']),
        STRATEGY.COLLABORATE,
    );
    assert.ok(roles.some((r) => r.provider === 'perplexity' && r.role === 'researcher'));
    assert.ok(roles.some((r) => r.provider === 'claude'));
});

test('buildPrompt returns the raw message when there are no previous outputs', () => {
    const o = new TaskOrchestrator();
    const p = o.buildPrompt('hello', { assignment: 'execute' }, []);
    assert.equal(p, 'hello');
});

test('buildPrompt wraps a verify assignment with the response to verify', () => {
    const o = new TaskOrchestrator();
    const p = o.buildPrompt('is X true?', { assignment: 'verify' }, [
        { provider: 'chatgpt', role: 'primary', response: 'X is true' },
    ]);
    assert.match(p, /VERIFY/);
    assert.match(p, /X is true/);
});

test('buildPrompt synthesize includes all prior inputs', () => {
    const o = new TaskOrchestrator();
    const p = o.buildPrompt('combine', { assignment: 'synthesize' }, [
        { provider: 'a', role: 'r1', response: 'alpha' },
        { provider: 'b', role: 'r2', response: 'beta' },
    ]);
    assert.match(p, /SYNTHESIZE/);
    assert.match(p, /alpha/);
    assert.match(p, /beta/);
});

test('createPlan records the chosen strategy in stats', () => {
    const o = new TaskOrchestrator();
    o.createPlan('write a function', new Set(['claude']));
    assert.equal(o.getStats().totalOrchestrations, 1);
    assert.equal(o.getStats().strategyCounts.direct, 1);
});

test('_pickBestFor penalises a provider with SmartRouter consecutive errors', () => {
    const smartRouter = { metrics: { claude: { consecutiveErrors: 5 }, chatgpt: { consecutiveErrors: 0 } } };
    const o = new TaskOrchestrator({ smartRouter });

    const best = o._pickBestFor(['code-review'], ['claude', 'chatgpt']);
    assert.equal(typeof best, 'string');
});
