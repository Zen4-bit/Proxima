// Proxima — Retry Engine Tests.
// Verifies backoff latency computation, retry eligibility heuristics, retry executors, and requests-per-minute controllers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRetryDelayMs, shouldRetry, withRetry, RPMController } from '../../src/retry/retry-engine.js';

describe('getRetryDelayMs', () => {

    it('should increase delay with each attempt (exponential)', () => {
        const d1 = getRetryDelayMs(1, 1);
        const d2 = getRetryDelayMs(2, 1);
        const d3 = getRetryDelayMs(3, 1);
        assert.ok(d2 > d1, `Attempt 2 (${Math.round(d2)}ms) should be > attempt 1 (${Math.round(d1)}ms)`);
        assert.ok(d3 > d2, `Attempt 3 (${Math.round(d3)}ms) should be > attempt 2 (${Math.round(d2)}ms)`);
    });

    it('should respect retryAfter header value', () => {
        const delay = getRetryDelayMs(1, 1, 30);
        assert.equal(delay, 30000);
    });

    it('should apply jitter (never exact same delay)', () => {
        const delays = new Set();
        for (let i = 0; i < 10; i++) {
            delays.add(Math.round(getRetryDelayMs(1, 1)));
        }
        assert.ok(delays.size >= 2);
    });
});

describe('shouldRetry', () => {

    it('should retry on timeout errors', () => {
        assert.equal(shouldRetry(new Error('Request timed out'), 0, 3), true);
        assert.equal(shouldRetry(new Error('ETIMEDOUT'), 0, 3), true);
    });

    it('should retry on network errors', () => {
        assert.equal(shouldRetry(new Error('ECONNRESET'), 0, 3), true);
        assert.equal(shouldRetry(new Error('fetch failed'), 0, 3), true);
    });

    it('should retry on rate limit (429)', () => {
        assert.equal(shouldRetry(new Error('429 Too Many Requests'), 0, 3), true);
    });

    it('should NOT retry past max retries', () => {
        assert.equal(shouldRetry(new Error('timeout'), 3, 3), false);
    });

    it('should NOT retry on non-retryable errors', () => {
        assert.equal(shouldRetry(new Error('Invalid API key'), 0, 3), false);
        assert.equal(shouldRetry(new Error('Syntax error'), 0, 3), false);
    });
});

describe('withRetry', () => {

    it('should succeed on first try', async () => {
        let calls = 0;
        const result = await withRetry(() => { calls++; return 'ok'; });
        assert.equal(result, 'ok');
        assert.equal(calls, 1);
    });

    it('should retry on failure then succeed', async () => {
        let calls = 0;
        const result = await withRetry(() => {
            calls++;
            if (calls < 3) throw new Error('ECONNRESET');
            return 'recovered';
        }, { maxRetries: 3, baseDelay: 0.01, label: 'test' });
        assert.equal(result, 'recovered');
        assert.equal(calls, 3);
    });

    it('should throw after exhausting all retries', async () => {
        await assert.rejects(
            () => withRetry(
                () => { throw new Error('ECONNRESET'); },
                { maxRetries: 2, baseDelay: 0.01, label: 'failing' }
            ),
            { message: /ECONNRESET/ }
        );
    });
});

describe('RPMController', () => {

    it('should pass in unlimited mode (null limit)', async () => {
        const rpm = new RPMController(null);
        const ok = await rpm.checkOrWait();
        assert.equal(ok, true);
        rpm.stop();
    });

    it('should track request counts', async () => {
        const rpm = new RPMController(100);
        await rpm.checkOrWait();
        await rpm.checkOrWait();
        const status = rpm.getStatus();
        assert.equal(status.current, 2);
        assert.equal(status.available, 98);
        rpm.stop();
    });

    it('should report correct limit', async () => {
        const rpm = new RPMController(60);
        const status = rpm.getStatus();
        assert.equal(status.max, 60);
        rpm.stop();
    });
});
