// Proxima — Agent State Machine Tests.
// Verifies behavior of state transitions, stats tracking, listeners, history caps, and concurrency handles.

import test from 'node:test';
import assert from 'node:assert';
import { AGENT_STATE, AgentStateMachine } from '../../src/agentic/agent-state.js';


function runToDone(m, metadata = {}) {
    m.transition(AGENT_STATE.THINKING, metadata);
    m.transition(AGENT_STATE.ROUTING);
    m.transition(AGENT_STATE.ACTING);
    m.transition(AGENT_STATE.EVALUATING);
    m.transition(AGENT_STATE.DONE);
}

test('starts IDLE with zeroed stats', () => {
    const m = new AgentStateMachine();
    assert.equal(m.state, AGENT_STATE.IDLE);
    assert.equal(m.stats.totalRuns, 0);
    assert.equal(m.stats.completed, 0);
});

test('valid transition IDLE → THINKING succeeds and opens a run', () => {
    const m = new AgentStateMachine();
    m.transition(AGENT_STATE.THINKING);
    assert.equal(m.state, AGENT_STATE.THINKING);
    assert.equal(m.stats.totalRuns, 1);
    assert.ok(m.currentRun, 'currentRun created');
});

test('invalid transition is a silent no-op (state unchanged)', () => {
    const m = new AgentStateMachine();

    const ret = m.transition(AGENT_STATE.ACTING);
    assert.equal(m.state, AGENT_STATE.IDLE);
    assert.equal(ret, m, 'returns the machine for chaining');
});

test('any state can force-reset to IDLE', () => {
    const m = new AgentStateMachine();
    m.transition(AGENT_STATE.THINKING);
    m.transition(AGENT_STATE.ROUTING);

    m.transition(AGENT_STATE.IDLE);
    assert.equal(m.state, AGENT_STATE.IDLE);
});

test('full happy-path run increments completed and records duration', () => {
    const m = new AgentStateMachine();
    runToDone(m, { provider: 'chatgpt' });
    assert.equal(m.state, AGENT_STATE.DONE);
    assert.equal(m.stats.completed, 1);
    assert.equal(m.stats.errors, 0);
    assert.equal(m.currentRun.endState, AGENT_STATE.DONE);
    assert.equal(typeof m.currentRun.duration, 'number');
    assert.equal(m.currentRun.provider, 'chatgpt');
});

test('ERROR path bumps the error counter', () => {
    const m = new AgentStateMachine();
    m.transition(AGENT_STATE.THINKING);
    m.transition(AGENT_STATE.ERROR);
    assert.equal(m.stats.errors, 1);
    assert.equal(m.stats.completed, 0);
});

test('BLOCKED path bumps the blocked counter', () => {
    const m = new AgentStateMachine();
    m.transition(AGENT_STATE.THINKING);
    m.transition(AGENT_STATE.BLOCKED);
    assert.equal(m.stats.blocked, 1);
});

test('avgDurationMs is derived from totalDurationMs over totalRuns', () => {
    const m = new AgentStateMachine();
    runToDone(m);
    assert.equal(m.stats.avgDurationMs, Math.round(m.stats.totalDurationMs / m.stats.totalRuns));
});

test('listeners fire on transition with (newState, prevState, metadata)', () => {
    const m = new AgentStateMachine();
    const calls = [];
    m.onStateChange((to, from, meta) => calls.push({ to, from, meta }));
    m.transition(AGENT_STATE.THINKING, { provider: 'gemini' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, AGENT_STATE.THINKING);
    assert.equal(calls[0].from, AGENT_STATE.IDLE);
    assert.equal(calls[0].meta.provider, 'gemini');
});

test('onStateChange returns an unsubscribe fn that stops further calls', () => {
    const m = new AgentStateMachine();
    let count = 0;
    const off = m.onStateChange(() => { count++; });
    m.transition(AGENT_STATE.THINKING);
    off();
    m.transition(AGENT_STATE.ROUTING);
    assert.equal(count, 1, 'only the pre-unsubscribe transition counted');
});

test('a throwing listener does not break the transition', () => {
    const m = new AgentStateMachine();
    m.onStateChange(() => { throw new Error('boom'); });
    assert.doesNotThrow(() => m.transition(AGENT_STATE.THINKING));
    assert.equal(m.state, AGENT_STATE.THINKING);
});

test('history is capped at 50 entries', () => {
    const m = new AgentStateMachine();

    for (let i = 0; i < 60; i++) m.transition(AGENT_STATE.IDLE);
    assert.equal(m.history.length, 50);
});

test('getStatus reports current state, run info and last transitions', () => {
    const m = new AgentStateMachine();
    m.transition(AGENT_STATE.THINKING, { provider: 'claude' });
    const status = m.getStatus();
    assert.equal(status.currentState, AGENT_STATE.THINKING);
    assert.equal(status.currentRun.provider, 'claude');
    assert.ok(Array.isArray(status.lastTransitions));
    assert.ok(status.lastTransitions.length >= 1);
});

test('reset clears state and current run without touching stats', () => {
    const m = new AgentStateMachine();
    runToDone(m);
    const runsBefore = m.stats.totalRuns;
    m.reset();
    assert.equal(m.state, AGENT_STATE.IDLE);
    assert.equal(m.currentRun, null);
    assert.equal(m.stats.totalRuns, runsBefore, 'reset does not wipe stats');
});



test('beginRun counts every concurrent run and tracks them independently', () => {
    const m = new AgentStateMachine();
    const r1 = m.beginRun({ provider: 'chatgpt' });
    const r2 = m.beginRun({ provider: 'claude' });
    assert.equal(m.stats.totalRuns, 2, 'both concurrent runs counted (was under-counted with transition())');
    assert.equal(m.getStatus().activeRuns, 2);

    r1.setState(AGENT_STATE.ROUTING);
    r2.setState(AGENT_STATE.ROUTING);

    r1.end(AGENT_STATE.DONE);
    assert.equal(m.stats.completed, 1);
    assert.equal(m.getStatus().activeRuns, 1, 'r2 still active after r1 finishes');
    assert.notEqual(m.state, AGENT_STATE.IDLE, 'display not idle while a run is active');

    r2.end(AGENT_STATE.ERROR);
    assert.equal(m.stats.errors, 1);
    assert.equal(m.stats.completed, 1, 'r1 completion not clobbered by r2');
    assert.equal(m.getStatus().activeRuns, 0);
    assert.equal(m.state, AGENT_STATE.IDLE, 'display returns to idle once all runs finish');
});

test('beginRun handle is idempotent after end() (no double-count)', () => {
    const m = new AgentStateMachine();
    const r = m.beginRun();
    r.end(AGENT_STATE.DONE);
    const completedAfter = m.stats.completed;
    r.end(AGENT_STATE.DONE);
    r.setState(AGENT_STATE.ACTING);
    assert.equal(m.stats.completed, completedAfter, 'end() cannot be counted twice');
});

test('reset also clears active runs', () => {
    const m = new AgentStateMachine();
    m.beginRun();
    m.reset();
    assert.equal(m.getStatus().activeRuns, 0);
});
