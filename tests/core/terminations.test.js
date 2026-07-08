// Proxima — Terminations Tests.
// Verifies quality threshold, maximum turns, timeout conditions, token budgets, and composite termination checkers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    QualityThreshold,
    MaxTurns,
    TimeoutCondition,
    TokenBudget,
    CompositeCondition,
    createTerminations,
} from '../../src/core/terminations.js';

describe('Termination Conditions', () => {

    describe('QualityThreshold', () => {
        it('should NOT trigger below threshold', () => {
            const cond = new QualityThreshold(8);
            assert.equal(cond.check({ score: 7 }), null);
            assert.equal(cond.triggered, false);
        });

        it('should trigger at threshold', () => {
            const cond = new QualityThreshold(8);
            const result = cond.check({ score: 8 });
            assert.equal(result.shouldStop, true);
            assert.ok(result.reason.includes('8'));
            assert.equal(cond.triggered, true);
        });

        it('should trigger above threshold', () => {
            const cond = new QualityThreshold(7);
            const result = cond.check({ score: 9 });
            assert.equal(result.shouldStop, true);
        });
    });

    describe('MaxTurns', () => {
        it('should count turns and trigger at max', () => {
            const cond = new MaxTurns(3);
            assert.equal(cond.check({ turn: 1 }), null);
            assert.equal(cond.check({ turn: 2 }), null);
            const result = cond.check({ turn: 3 });
            assert.equal(result.shouldStop, true);
            assert.ok(result.reason.includes('3'));
        });

        it('should reset correctly', () => {
            const cond = new MaxTurns(2);
            cond.check({ turn: 2 });
            assert.equal(cond.triggered, true);
            cond.reset();
            assert.equal(cond.triggered, false);
            assert.equal(cond.currentTurn, 0);
        });
    });

    describe('TimeoutCondition', () => {
        it('should NOT trigger before timeout', () => {
            const cond = new TimeoutCondition(60000);
            assert.equal(cond.check(), null);
        });

        it('should trigger after timeout', () => {
            const cond = new TimeoutCondition(1);
            cond.startTime = Date.now() - 100;
            const result = cond.check();
            assert.equal(result.shouldStop, true);
            assert.ok(result.reason.includes('Timeout'));
        });
    });

    describe('TokenBudget', () => {
        it('should accumulate tokens', () => {
            const cond = new TokenBudget(1000);
            assert.equal(cond.check({ tokensUsed: 400 }), null);
            assert.equal(cond.check({ tokensUsed: 400 }), null);
            const result = cond.check({ tokensUsed: 300 });
            assert.equal(result.shouldStop, true);
            assert.ok(result.reason.includes('1100'));
        });
    });

    describe('CompositeCondition', () => {
        it('should trigger on ANY in OR mode', () => {
            const cond = new CompositeCondition('OR', [
                new QualityThreshold(9),
                new MaxTurns(2),
            ]);
            const result = cond.check({ score: 5, turn: 2 });
            assert.equal(result.shouldStop, true);
            assert.ok(result.source === 'MaxTurns');
        });

        it('should require ALL in AND mode', () => {
            const cond = new CompositeCondition('AND', [
                new QualityThreshold(8),
                new MaxTurns(2),
            ]);
            assert.equal(cond.check({ score: 9, turn: 1 }), null);
            const result = cond.check({ score: 9, turn: 2 });
            assert.equal(result.shouldStop, true);
        });

        it('should reset all children', () => {
            const cond = new CompositeCondition('OR', [
                new MaxTurns(1),
                new QualityThreshold(5),
            ]);
            cond.check({ score: 6, turn: 1 });
            assert.equal(cond.triggered, true);
            cond.reset();
            assert.equal(cond.triggered, false);
        });
    });

    describe('createTerminations', () => {
        it('should create loop terminations', () => {
            const cond = createTerminations('loop');
            assert.ok(cond instanceof CompositeCondition);
            assert.equal(cond.conditions.length, 3);
        });

        it('should accept overrides', () => {
            const cond = createTerminations('loop', { maxTurns: 10, quality: 9 });
            assert.ok(cond instanceof CompositeCondition);
        });
    });
});
