// Proxima — Token Tracker Tests.
// Verifies token estimation from text, file list token calculations, usage tracking, cost calculations, and report generation.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TokenTracker } from '../../src/cost/token-tracker.js';

describe('TokenTracker', () => {
    let tracker;

    beforeEach(() => {
        tracker = new TokenTracker();
    });



    it('should estimate tokens from text', () => {
        const tokens = TokenTracker.estimateTokens('Hello, how are you doing today?');
        assert.ok(tokens > 0, 'Should return positive number');
        assert.ok(tokens < 100, 'Should be reasonable estimate');
    });

    it('should return 0 for empty/null text', () => {
        assert.equal(TokenTracker.estimateTokens(''), 0);
        assert.equal(TokenTracker.estimateTokens(null), 0);
        assert.equal(TokenTracker.estimateTokens(undefined), 0);
    });

    it('should use language-specific ratios when ext provided', () => {
        const text = 'x'.repeat(400);
        const jsTokens = TokenTracker.estimateTokens(text, '.js');
        const jsonTokens = TokenTracker.estimateTokens(text, '.json');
        assert.ok(jsonTokens < jsTokens, 'JSON should estimate fewer tokens than JS');
    });

    it('should estimate tokens for multiple files', () => {
        const files = [
            { content: 'const x = 1;', path: 'test.js' },
            { content: '{"key": "value"}', path: 'data.json' },
        ];
        const result = TokenTracker.estimateTokensForFiles(files);
        assert.ok(result.total > 0);
        assert.ok(result.perFile['test.js'] > 0);
        assert.ok(result.perFile['data.json'] > 0);
        assert.equal(result.total, result.perFile['test.js'] + result.perFile['data.json']);
    });



    it('should log usage and calculate cost', () => {
        const result = tracker.logUsage({
            model: 'gpt-4',
            provider: 'chatgpt',
            promptTokens: 1000,
            completionTokens: 500,
        });
        assert.ok(result.requestCost > 0, 'Should calculate positive cost');
        assert.equal(result.totalSaved, result.requestCost);
    });

    it('should accumulate costs across multiple calls', () => {
        tracker.logUsage({ model: 'gpt-4', provider: 'chatgpt', promptTokens: 500, completionTokens: 200 });
        const r2 = tracker.logUsage({ model: 'claude-3.5-sonnet', provider: 'claude', promptTokens: 300, completionTokens: 150 });
        assert.ok(r2.totalSaved > r2.requestCost, 'Total should be more than just this request');
    });

    it('should track per-provider stats', () => {
        tracker.logUsage({ model: 'gpt-4', provider: 'chatgpt', promptTokens: 100, completionTokens: 50 });
        tracker.logUsage({ model: 'gpt-4', provider: 'chatgpt', promptTokens: 200, completionTokens: 100 });
        tracker.logUsage({ model: 'claude-3-haiku', provider: 'claude', promptTokens: 150, completionTokens: 75 });

        const report = tracker.getReport();
        assert.equal(report.totalRequests, 3);
        assert.equal(Object.keys(report.providers).length, 2);
        assert.equal(report.providers.chatgpt.requests, 2);
        assert.equal(report.providers.claude.requests, 1);
    });



    it('should generate formatted report', () => {
        tracker.logUsage({ model: 'gpt-4', provider: 'chatgpt', promptTokens: 100, completionTokens: 50 });
        const report = tracker.getReport();

        assert.ok(report.sessionStart);
        assert.equal(report.totalRequests, 1);
        assert.equal(report.totalPromptTokens, 100);
        assert.equal(report.totalCompletionTokens, 50);
        assert.equal(report.totalTokens, 150);
        assert.ok(report.totalCostSaved.startsWith('$'));
        assert.ok(report.totalCostSavedINR.startsWith('₹'));
        assert.ok(report.message.includes('rupees'));
    });



    it('should calculate cost statically', () => {
        const cost = TokenTracker.calculateCost('gpt-4', 1000, 500);
        assert.ok(cost.cost > 0);
        assert.ok(cost.costINR > 0);
        assert.ok(cost.costINR > cost.cost, 'INR should be more than USD');
    });

    it('should get pricing for known model', () => {
        const pricing = TokenTracker.getPricing('gpt-4');
        assert.ok(pricing.input > 0);
        assert.ok(pricing.output > 0);
    });

    it('should fallback to default pricing for unknown model', () => {
        const pricing = TokenTracker.getPricing('some-future-model-v99');
        assert.ok(pricing.input > 0);
        assert.ok(pricing.output > 0);
    });

    it('should handle cached tokens in logUsage', () => {
        tracker.logUsage({
            model: 'gpt-4',
            provider: 'chatgpt',
            promptTokens: 100,
            completionTokens: 50,
            cachedTokens: 20,
        });
        const report = tracker.getReport();
        assert.equal(report.providers.chatgpt.cachedTokens, 20);
    });
});
