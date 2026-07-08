// Proxima — Execution Tracing Tests.
// Verifies trace/span lifecycle, provider statistics aggregation, and maximum trace caps.

import test from 'node:test';
import assert from 'node:assert';
import { TracingManager, Span, Trace, SPAN_TYPE } from '../../src/agentic/tracing.js';

test('Span.start sets running status once and is idempotent', () => {
    const s = new Span({ type: SPAN_TYPE.CHAT, name: 'x', traceId: 't1' });
    s.start();
    const firstStart = s.startedAt;
    assert.equal(s.status, 'running');
    s.start();
    assert.equal(s.startedAt, firstStart);
});

test('Span.end computes a numeric duration and completes', () => {
    const s = new Span({ type: SPAN_TYPE.CHAT, name: 'x', traceId: 't1' });
    s.start();
    s.end({ provider: 'chatgpt' });
    assert.equal(s.status, 'completed');
    assert.equal(typeof s.duration, 'number');
    assert.ok(s.duration >= 0);
    assert.equal(s.metadata.provider, 'chatgpt');
});

test('Span.setError records message and closes the span', () => {
    const s = new Span({ type: SPAN_TYPE.CHAT, name: 'x', traceId: 't1' });
    s.start();
    s.setError(new Error('timeout'));
    assert.equal(s.status, 'error');
    assert.equal(s.error, 'timeout');
    assert.ok(s.endedAt !== null);
});

test('Span.setError accepts a plain string', () => {
    const s = new Span({ type: SPAN_TYPE.TOOL, name: 'x', traceId: 't1' });
    s.setError('boom');
    assert.equal(s.error, 'boom');
});

test('Span.toJSON exposes the documented fields', () => {
    const s = new Span({ type: SPAN_TYPE.CHAT, name: 'call', traceId: 't1', parentId: 'p1' });
    s.start(); s.end();
    const json = s.toJSON();
    assert.deepEqual(
        Object.keys(json).sort(),
        ['duration', 'endedAt', 'error', 'id', 'metadata', 'name', 'parentId', 'startedAt', 'status', 'traceId', 'type'].sort(),
    );
    assert.equal(json.parentId, 'p1');
});

test('Trace reports spanCount and hasErrors', () => {
    const t = new Trace('t1', 'run');
    const ok = new Span({ type: SPAN_TYPE.CHAT, name: 'a', traceId: 't1' }); ok.start(); ok.end();
    const bad = new Span({ type: SPAN_TYPE.CHAT, name: 'b', traceId: 't1' }); bad.start(); bad.setError('x');
    t.addSpan(ok); t.addSpan(bad);
    assert.equal(t.spanCount, 2);
    assert.equal(t.hasErrors, true);
});

test('TracingManager.startSpan attaches to the active trace', () => {
    const tm = new TracingManager();
    tm.startTrace('main');
    const span = tm.startSpan({ type: SPAN_TYPE.CHAT, name: 'ask' });
    assert.equal(span.traceId, tm.activeTraceId);
    assert.equal(tm.stats.totalSpans, 1);
    const trace = tm.traces.find((t) => t.id === tm.activeTraceId);
    assert.equal(trace.spanCount, 1);
});

test('TracingManager.endSpan aggregates per-provider and per-type stats', () => {
    const tm = new TracingManager();
    tm.startTrace('main');
    const span = tm.startSpan({ type: SPAN_TYPE.CHAT, name: 'ask', metadata: { provider: 'gemini', inputTokens: 10, outputTokens: 20 } });
    tm.endSpan(span);
    const ps = tm.stats.providerStats.gemini;
    assert.equal(ps.calls, 1);
    assert.equal(ps.inputTokens, 10);
    assert.equal(ps.outputTokens, 20);
    assert.equal(ps.avgDuration, ps.totalDuration);
    assert.equal(tm.stats.spanTypeStats[SPAN_TYPE.CHAT].count, 1);
});

test('TracingManager.errorSpan increments error counters', () => {
    const tm = new TracingManager();
    tm.startTrace('main');
    const span = tm.startSpan({ type: SPAN_TYPE.CHAT, name: 'ask', metadata: { provider: 'claude' } });
    tm.errorSpan(span, new Error('429'));
    assert.equal(tm.stats.totalErrors, 1);
    assert.equal(tm.stats.providerStats.claude.errors, 1);
});

test('orphan spans still respect the maxTraces cap', () => {
    const tm = new TracingManager({ maxTraces: 3 });

    for (let i = 0; i < 10; i++) {
        tm.startSpan({ type: SPAN_TYPE.CHAT, name: `s${i}`, traceId: `trace-${i}` });
    }
    assert.ok(tm.traces.length <= 3, `expected <=3 traces, got ${tm.traces.length}`);
});

test('startTrace also enforces the maxTraces cap', () => {
    const tm = new TracingManager({ maxTraces: 2 });
    tm.startTrace('a'); tm.startTrace('b'); tm.startTrace('c');
    assert.equal(tm.traces.length, 2);
    assert.equal(tm.stats.totalTraces, 3);
});

test('getRecentTraces returns ISO timestamps and limited count', () => {
    const tm = new TracingManager();
    tm.startTrace('a'); tm.startTrace('b'); tm.startTrace('c');
    const recent = tm.getRecentTraces(2);
    assert.equal(recent.length, 2);
    assert.ok(!Number.isNaN(Date.parse(recent[0].createdAt)));
});

test('getStatusReport summarises spans, traces and provider timings', () => {
    const tm = new TracingManager();
    tm.startTrace('main');
    const span = tm.startSpan({ type: SPAN_TYPE.CHAT, name: 'ask', metadata: { provider: 'chatgpt' } });
    tm.endSpan(span);
    const report = tm.getStatusReport();
    assert.match(report, /Tracing: 1 spans/);
    assert.match(report, /chatgpt/);
});

test('reset clears traces and stats', () => {
    const tm = new TracingManager();
    tm.startTrace('main');
    tm.endSpan(tm.startSpan({ type: SPAN_TYPE.CHAT, name: 'x', metadata: { provider: 'p' } }));
    tm.reset();
    assert.equal(tm.traces.length, 0);
    assert.equal(tm.stats.totalSpans, 0);
    assert.deepEqual(tm.stats.providerStats, {});
});
