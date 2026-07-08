// Proxima — Lifecycle Hooks Tests.
// Verifies behavior of event firing, stats tracking, single and multiple subscriptions, and error isolation.

import test from 'node:test';
import assert from 'node:assert';
import { LifecycleHooks, LIFECYCLE_EVENTS } from '../../src/agentic/lifecycle.js';

test('fire emits the event with merged metadata and a timestamp', () => {
    const hooks = new LifecycleHooks();
    let received = null;
    hooks.subscribe(LIFECYCLE_EVENTS.AGENT_START, (d) => { received = d; });
    hooks.fire(LIFECYCLE_EVENTS.AGENT_START, { provider: 'chatgpt', message: 'hi' });
    assert.ok(received);
    assert.equal(received.event, LIFECYCLE_EVENTS.AGENT_START);
    assert.equal(received.provider, 'chatgpt');
    assert.equal(typeof received.timestamp, 'number');
});

test('fire increments eventsEmitted and per-event counts', () => {
    const hooks = new LifecycleHooks();
    hooks.fire(LIFECYCLE_EVENTS.TOOL_START, { toolName: 'a' });
    hooks.fire(LIFECYCLE_EVENTS.TOOL_START, { toolName: 'b' });
    hooks.fire(LIFECYCLE_EVENTS.TOOL_END, { toolName: 'a' });
    assert.equal(hooks.stats.eventsEmitted, 3);
    assert.equal(hooks.stats.eventCounts[LIFECYCLE_EVENTS.TOOL_START], 2);
    assert.equal(hooks.stats.eventCounts[LIFECYCLE_EVENTS.TOOL_END], 1);
});

test('subscribe returns an unsubscribe fn that stops delivery', () => {
    const hooks = new LifecycleHooks();
    let count = 0;
    const off = hooks.subscribe(LIFECYCLE_EVENTS.MEMORY_SAVE, () => { count++; });
    hooks.fire(LIFECYCLE_EVENTS.MEMORY_SAVE, {});
    off();
    hooks.fire(LIFECYCLE_EVENTS.MEMORY_SAVE, {});
    assert.equal(count, 1);
});

test('subscribeOnce fires exactly once', () => {
    const hooks = new LifecycleHooks();
    let count = 0;
    hooks.subscribeOnce(LIFECYCLE_EVENTS.HANDOFF, () => { count++; });
    hooks.fire(LIFECYCLE_EVENTS.HANDOFF, { from: 'a', to: 'b' });
    hooks.fire(LIFECYCLE_EVENTS.HANDOFF, { from: 'a', to: 'c' });
    assert.equal(count, 1);
});

test('a throwing subscriber does not crash fire()', () => {
    const hooks = new LifecycleHooks();
    hooks.subscribe(LIFECYCLE_EVENTS.WORKFLOW_STEP, () => { throw new Error('subscriber boom'); });
    assert.doesNotThrow(() => hooks.fire(LIFECYCLE_EVENTS.WORKFLOW_STEP, { step: 1 }));

    assert.equal(hooks.stats.eventCounts[LIFECYCLE_EVENTS.WORKFLOW_STEP], 1);
});

test('getStatusReport reports fired count and top events', () => {
    const hooks = new LifecycleHooks();
    hooks.fire(LIFECYCLE_EVENTS.AGENT_START, {});
    hooks.fire(LIFECYCLE_EVENTS.AGENT_END, {});
    const report = hooks.getStatusReport();
    assert.match(report, /Lifecycle Hooks: 2 events fired/);
    assert.match(report, /Top Events/);
});

test('reset zeroes the stats', () => {
    const hooks = new LifecycleHooks();
    hooks.fire(LIFECYCLE_EVENTS.AGENT_START, {});
    hooks.reset();
    assert.equal(hooks.stats.eventsEmitted, 0);
    assert.deepEqual(hooks.stats.eventCounts, {});
});
