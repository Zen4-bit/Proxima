// Proxima — MCP Workflow/Agentic Tools Tests.
// Verifies registration of workflow/agentic tools, run_workflow step executions, run_loop convergence, crew multi-agent pipeline routing, and status/cost aggregates.

import test from 'node:test';
import assert from 'node:assert';
import { register } from '../../src/mcp/tools-workflow.js';
import { registerModule, textOf } from '../fixtures/mcp-harness.js';


function workflowDeps(extra = {}) {
    return {
        workflowEngine: { execute: async () => ({ status: 'completed', finalOutput: 'final', summary: 'ok', steps: [{ step: 1, task: 'do', provider: 'claude', elapsedSec: 1, response: 'r' }] }) },
        runLoop: { execute: async () => ({ finalOutput: 'looped', converged: true, summary: 's', iterations: [{ turn: 1, score: 9, converged: true, elapsedMs: 1000 }] }), getStats: () => ({ totalRuns: 2, avgTurns: 1.5 }) },
        chatWithProvider: async (provider) => `crew:${provider}`,
        tokenTracker: { getReport: () => ({ totalRequests: 3, totalTokens: 100, totalCostSaved: '$0.10', totalCostSavedINR: '₹8', message: 'saved', providers: { claude: { requests: 3, promptTokens: 60, completionTokens: 40 } } }) },
        memoryStore: { memoryStore: new Map([['a', { new_value: 'remembered a fact' }]]) },
        smartRouterV2: { getHealthReport: () => ({ claude: { mode: 'session', status: 'healthy', calls: 1, avgResponseSec: '2.0', errors: 0 } }) },
        enhancedMemory: { getStats: () => ({ totalFacts: 5 }) },
        intelligentMemory: { getStatus: () => ({ activeMemories: 2, archivedMemories: 0, harvestedFacts: 1, avgQualityScore: 0.8, avgDecayScore: 0.1, lastConsolidation: 'never' }) },
        agentState: { getStatus: () => ({ currentState: 'idle', stats: { totalRuns: 1, completed: 1, errors: 0, blocked: 0, avgDurationMs: 500 } }) },
        getContextStats: () => ({ totalChecks: 0, totalInjections: 0, libraryHits: {} }),
        tracingManager: { getStatusReport: () => 'trace-ok' },
        lifecycle: { getStatusReport: () => 'lifecycle-ok' },
        initAgenticExecutor: () => ({ getStats: () => ({ totalExecutions: 1, multiProviderCalls: 0, orchestrator: { strategyCounts: {} }, evaluator: { avgScore: 9 }, facts: 0 }) }),
        ...extra,
    };
}

test('tools-workflow: registers the 5 documented workflow/agentic tools', () => {
    const { tools } = registerModule(register, { deps: workflowDeps() });
    assert.deepEqual([...tools.keys()].sort(), ['crew', 'proxima_agentic_status', 'proxima_cost_report', 'run_loop', 'run_workflow']);
});

test('run_workflow: executes the engine and returns a mapped step summary', async () => {
    const h = registerModule(register, { deps: workflowDeps() });
    const res = await h.tools.get('run_workflow').handler({ steps: [{ task: 'do' }], name: 'W' });
    const parsed = JSON.parse(textOf(res));
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.finalOutput, 'final');
    assert.equal(parsed.steps[0].provider, 'claude');
});

test('run_workflow: an engine failure becomes a toolError', async () => {
    const h = registerModule(register, { deps: workflowDeps({ workflowEngine: { execute: async () => { throw new Error('engine boom'); } } }) });
    const res = await h.tools.get('run_workflow').handler({ steps: [{ task: 'x' }] });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /engine boom/);
});

test('run_loop: returns final output, convergence and per-iteration stats', async () => {
    const h = registerModule(register, { deps: workflowDeps() });
    const res = await h.tools.get('run_loop').handler({ task: 'refine', maxTurns: 3 });
    const parsed = JSON.parse(textOf(res));
    assert.equal(parsed.finalOutput, 'looped');
    assert.equal(parsed.converged, true);
    assert.equal(parsed.iterations[0].score, 9);
});

test('crew: runs the default 3-role pipeline and labels each role/provider', async () => {
    const h = registerModule(register, { enabled: ['claude', 'chatgpt', 'perplexity'], deps: workflowDeps() });
    const res = await h.tools.get('crew').handler({ task: 'write a post' });
    const text = textOf(res);
    assert.match(text, /## Researcher \(perplexity\)/);
    assert.match(text, /## Writer \(claude\)/);
    assert.match(text, /## Reviewer \(chatgpt\)/);
    assert.match(text, /Total time/);
});

test('crew: falls back to auto when a requested provider is disabled (transparent label)', async () => {
    const h = registerModule(register, { enabled: ['claude'], deps: workflowDeps() });
    const res = await h.tools.get('crew').handler({ task: 't' });
    assert.match(textOf(res), /perplexity unavailable/);
});

test('proxima_cost_report: formats the token/cost report', async () => {
    const h = registerModule(register, { deps: workflowDeps() });
    const res = await h.tools.get('proxima_cost_report').handler({});
    assert.match(textOf(res), /Total Requests: 3/);
    assert.match(textOf(res), /Money Saved: \$0\.10/);
});

test('proxima_agentic_status: aggregates subsystem stats into a status report', async () => {
    const h = registerModule(register, { enabled: ['claude'], deps: workflowDeps() });
    const res = await h.tools.get('proxima_agentic_status').handler({});
    const text = textOf(res);
    assert.match(text, /Proxima v8\.0 Agentic Status/);
    assert.match(text, /Mode: Session/);
    assert.match(text, /Provider Health/);
    assert.match(text, /claude/);
});
