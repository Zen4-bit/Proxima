// Proxima — Workflow Engine Tests.
// Verifies sequential multi-step execution, fallback mechanisms, auto-routing, and active workflow cleanups.

import test from 'node:test';
import assert from 'node:assert';
import { WorkflowEngine, WORKFLOW_STATUS, TASK_STATUS } from '../../src/agentic/workflow-engine.js';

function makeRouter() {
    const calls = { success: [], error: [] };
    return {
        calls,
        route() { return { provider: 'gemini', reason: 'auto-picked' }; },
        recordSuccess(p, ms) { calls.success.push({ p, ms }); },
        recordError(p, e) { calls.error.push({ p, e }); },
    };
}

test('runs steps in order, threads context, and completes', async () => {
    const engine = new WorkflowEngine({ smartRouter: makeRouter() });
    const seen = [];
    const chatFn = async (provider, prompt) => {
        seen.push({ provider, prompt });
        return `out-${seen.length}`;
    };
    const result = await engine.execute({
        name: 'demo',
        steps: [
            { task: 'first task', provider: 'chatgpt' },
            { task: 'second task', provider: 'claude' },
        ],
        input: 'seed input',
        chatFn,
        enabledProviders: new Set(['chatgpt', 'claude']),
    });

    assert.equal(result.status, WORKFLOW_STATUS.COMPLETED);
    assert.equal(result.steps.length, 2);
    assert.equal(result.finalOutput, 'out-2');
    assert.match(seen[1].prompt, /out-1/);
    assert.equal(result.summary.completedSteps, 2);
    assert.equal(result.summary.failedSteps, 0);
});

test('auto-routes a step that specifies no provider', async () => {
    const router = makeRouter();
    const engine = new WorkflowEngine({ smartRouter: router });
    const result = await engine.execute({
        name: 'auto',
        steps: [{ task: 'do research' }],
        input: '',
        chatFn: async () => 'researched',
        enabledProviders: new Set(['gemini', 'claude']),
    });
    assert.equal(result.status, WORKFLOW_STATUS.COMPLETED);
    assert.equal(result.steps[0].provider, 'gemini');
    assert.equal(result.steps[0].autoRouted, true);
    assert.equal(router.calls.success.length, 1);
});

test('falls back to another enabled provider when the primary fails', async () => {
    const engine = new WorkflowEngine({ smartRouter: makeRouter() });
    const chatFn = async (provider) => {
        if (provider === 'chatgpt') throw new Error('chatgpt down');
        return `ok from ${provider}`;
    };
    const result = await engine.execute({
        name: 'fb',
        steps: [{ task: 'do it', provider: 'chatgpt' }],
        input: '',
        chatFn,
        enabledProviders: new Set(['chatgpt', 'claude']),
    });
    assert.equal(result.status, WORKFLOW_STATUS.COMPLETED);
    assert.equal(result.steps[0].fallback, true);
    assert.equal(result.steps[0].provider, 'claude');
});

test('marks the workflow FAILED when a step has no viable fallback', async () => {
    const engine = new WorkflowEngine({ smartRouter: makeRouter() });
    const chatFn = async () => { throw new Error('everything is down'); };
    const result = await engine.execute({
        name: 'boom',
        steps: [{ task: 'attempt', provider: 'chatgpt' }],
        input: '',
        chatFn,
        enabledProviders: new Set(['chatgpt']),
    });
    assert.equal(result.status, WORKFLOW_STATUS.FAILED);
    assert.equal(result.summary.failedSteps, 1);
});

test('active workflows are released after completion (no leak)', async () => {
    const engine = new WorkflowEngine({ smartRouter: makeRouter() });
    await engine.execute({
        name: 'x',
        steps: [{ task: 't', provider: 'gemini' }],
        input: '',
        chatFn: async () => 'done',
        enabledProviders: new Set(['gemini']),
    });
    assert.equal(engine.getActiveWorkflows().length, 0);

    assert.equal(engine._recent.length, 1);
    assert.equal(engine._recent[0].status, WORKFLOW_STATUS.COMPLETED);
});

test('exposes WORKFLOW_STATUS and TASK_STATUS enums', () => {
    assert.equal(WORKFLOW_STATUS.COMPLETED, 'completed');
    assert.equal(TASK_STATUS.DONE, 'done');
});
