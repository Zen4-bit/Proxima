// Proxima — Tracing & Spans.
// Performs in-memory execution tracking and performance telemetry for provider calls.

import { createLogger } from '../utils/logger.js';
const log = createLogger('tracing');

let spanIdCounter = 0;

function generateSpanId() {
    return `span_${Date.now()}_${++spanIdCounter}`;
}

function generateTraceId() {
    return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

const SPAN_TYPE = {
    CHAT: 'chat',
    GUARDRAIL: 'guardrail',
    TOOL: 'tool',
    HANDOFF: 'handoff',
    WORKFLOW: 'workflow',
    LOOP: 'loop',
};

class Span {
    constructor({ type, name, traceId, parentId = null, metadata = {} }) {
        this.id = generateSpanId();
        this.type = type;
        this.name = name;
        this.traceId = traceId;
        this.parentId = parentId;
        this.metadata = metadata;

        this.startedAt = null;
        this.endedAt = null;
        this.duration = null;
        this.error = null;
        this.status = 'created';
    }

    start() {
        if (this.startedAt) return this;
        this.startedAt = Date.now();
        this.status = 'running';
        return this;
    }

    end(metadata = {}) {
        if (this.endedAt) return this;
        this.endedAt = Date.now();
        this.duration = this.endedAt - this.startedAt;
        this.status = 'completed';
        Object.assign(this.metadata, metadata);
        return this;
    }

    setError(error) {
        this.error = typeof error === 'string' ? error : error?.message || 'Unknown error';
        this.status = 'error';
        if (!this.endedAt) {
            this.endedAt = Date.now();
            this.duration = this.endedAt - (this.startedAt || this.endedAt);
        }
        return this;
    }

    toJSON() {
        return {
            id: this.id,
            type: this.type,
            name: this.name,
            traceId: this.traceId,
            parentId: this.parentId,
            status: this.status,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            duration: this.duration,
            error: this.error,
            metadata: this.metadata,
        };
    }
}

class Trace {
    constructor(id, name) {
        this.id = id;
        this.name = name;
        this.spans = [];
        this.createdAt = Date.now();
    }

    addSpan(span) {
        this.spans.push(span);
        return span;
    }

    get totalDuration() {
        if (this.spans.length === 0) return 0;
        const start = Math.min(...this.spans.filter(s => s.startedAt).map(s => s.startedAt));
        const end = Math.max(...this.spans.filter(s => s.endedAt).map(s => s.endedAt));
        return end - start;
    }

    get spanCount() {
        return this.spans.length;
    }

    get hasErrors() {
        return this.spans.some(s => s.status === 'error');
    }
}

class TracingManager {
    constructor(options = {}) {
        this.traces = [];
        this.activeTraceId = null;
        this.maxTraces = options.maxTraces || 100;

        this.stats = {
            totalSpans: 0,
            totalTraces: 0,
            totalErrors: 0,
            providerStats: {},
            spanTypeStats: {},
        };
    }

    startTrace(name) {
        const traceId = generateTraceId();
        const trace = new Trace(traceId, name);
        this.traces.push(trace);
        this.activeTraceId = traceId;
        this.stats.totalTraces++;

        if (this.traces.length > this.maxTraces) {
            this.traces = this.traces.slice(-this.maxTraces);
        }

        return trace;
    }

    startSpan({ type, name, traceId = null, parentId = null, metadata = {} }) {
        const resolvedTraceId = traceId || this.activeTraceId || generateTraceId();
        const span = new Span({ type, name, traceId: resolvedTraceId, parentId, metadata });
        span.start();

        let trace = this.traces.find(t => t.id === resolvedTraceId);
        if (!trace) {
            trace = new Trace(resolvedTraceId, name);
            this.traces.push(trace);

            // Enforce the maxTraces cap.
            if (this.traces.length > this.maxTraces) {
                this.traces = this.traces.slice(-this.maxTraces);
            }
        }
        trace.addSpan(span);

        this.stats.totalSpans++;
        return span;
    }

    endSpan(span, metadata = {}) {
        if (!span) return;
        span.end(metadata);
        this._updateStats(span);
        return span;
    }

    errorSpan(span, error) {
        if (!span) return;
        span.setError(error);
        this.stats.totalErrors++;
        this._updateStats(span);
        return span;
    }

    _updateStats(span) {
        const provider = span.metadata.provider;
        if (provider) {
            if (!this.stats.providerStats[provider]) {
                this.stats.providerStats[provider] = {
                    calls: 0,
                    totalDuration: 0,
                    errors: 0,
                    avgDuration: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                };
            }
            const ps = this.stats.providerStats[provider];
            ps.calls++;
            if (span.duration) ps.totalDuration += span.duration;
            if (span.status === 'error') ps.errors++;
            ps.avgDuration = Math.round(ps.totalDuration / ps.calls);
            if (span.metadata.inputTokens) ps.inputTokens += span.metadata.inputTokens;
            if (span.metadata.outputTokens) ps.outputTokens += span.metadata.outputTokens;
        }

        if (!this.stats.spanTypeStats[span.type]) {
            this.stats.spanTypeStats[span.type] = { count: 0, totalDuration: 0 };
        }
        const ts = this.stats.spanTypeStats[span.type];
        ts.count++;
        if (span.duration) ts.totalDuration += span.duration;
    }

    getRecentTraces(limit = 5) {
        return this.traces.slice(-limit).map(t => ({
            id: t.id,
            name: t.name,
            spanCount: t.spanCount,
            totalDuration: t.totalDuration,
            hasErrors: t.hasErrors,
            createdAt: new Date(t.createdAt).toISOString(),
        }));
    }

    getStatusReport() {
        const lines = [];
        lines.push(`Tracing: ${this.stats.totalSpans} spans, ${this.stats.totalTraces} traces, ${this.stats.totalErrors} errors`);

        const providers = Object.entries(this.stats.providerStats);
        if (providers.length > 0) {
            lines.push('  Per-Provider Timings:');
            for (const [name, ps] of providers) {
                lines.push(`    ${name}: ${ps.calls} calls | avg ${ps.avgDuration}ms | errors: ${ps.errors} | tokens: ${ps.inputTokens}in/${ps.outputTokens}out`);
            }
        }

        return lines.join('\n');
    }

    reset() {
        this.traces = [];
        this.activeTraceId = null;
        this.stats = {
            totalSpans: 0,
            totalTraces: 0,
            totalErrors: 0,
            providerStats: {},
            spanTypeStats: {},
        };
    }
}

export { TracingManager, Span, Trace, SPAN_TYPE };
