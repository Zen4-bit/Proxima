// Proxima — Custom Error Hierarchy Tests.
// Verifies AppError, ProviderError, RateLimitError, AuthError, and TimeoutError configurations, serialization, and status codes.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    AppError,
    ProviderError,
    RateLimitError,
    AuthError,
    TimeoutError,
} from '../../src/utils/errors.js';



describe('AppError', () => {
    it('should create with default values', () => {
        const err = new AppError('Something failed');
        assert.equal(err.message, 'Something failed');
        assert.equal(err.code, 'APP_ERROR');
        assert.equal(err.statusCode, 500);
        assert.equal(err.retryable, false);
        assert.ok(err.timestamp);
        assert.ok(err instanceof Error);
    });

    it('should accept custom options', () => {
        const err = new AppError('Custom error', {
            code: 'CUSTOM',
            statusCode: 418,
            context: { key: 'value' },
            retryable: true,
        });
        assert.equal(err.code, 'CUSTOM');
        assert.equal(err.statusCode, 418);
        assert.deepEqual(err.context, { key: 'value' });
        assert.equal(err.retryable, true);
    });

    it('should serialize to JSON correctly', () => {
        const err = new AppError('Test', { code: 'TEST' });
        const json = err.toJSON();
        assert.equal(json.name, 'AppError');
        assert.equal(json.code, 'TEST');
        assert.equal(json.message, 'Test');
        assert.ok(json.timestamp);
    });
});



describe('ProviderError', () => {
    it('should include provider name in context', () => {
        const err = new ProviderError('chatgpt', 'API failed');
        assert.equal(err.provider, 'chatgpt');
        assert.equal(err.context.provider, 'chatgpt');
        assert.equal(err.statusCode, 502);
        assert.equal(err.retryable, true);
    });

    it('should be instance of AppError', () => {
        const err = new ProviderError('claude', 'Timeout');
        assert.ok(err instanceof AppError);
        assert.ok(err instanceof ProviderError);
        assert.ok(err instanceof Error);
    });
});



describe('RateLimitError', () => {
    it('should set 429 status and retryAfterMs', () => {
        const err = new RateLimitError('chatgpt', 30000);
        assert.equal(err.statusCode, 429);
        assert.equal(err.retryAfterMs, 30000);
        assert.equal(err.retryable, true);
        assert.ok(err.message.includes('chatgpt'));
    });

    it('should default to 60000ms retry', () => {
        const err = new RateLimitError('claude');
        assert.equal(err.retryAfterMs, 60000);
    });
});



describe('AuthError', () => {
    it('should set 401 and not be retryable', () => {
        const err = new AuthError('gemini');
        assert.equal(err.statusCode, 401);
        assert.equal(err.retryable, false);
        assert.equal(err.code, 'AUTH_ERROR');
    });
});



describe('TimeoutError', () => {
    it('should include timeout duration', () => {
        const err = new TimeoutError('perplexity', 120000);
        assert.equal(err.statusCode, 504);
        assert.equal(err.retryable, true);
        assert.ok(err.message.includes('120000'));
    });
});
