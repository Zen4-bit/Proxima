// Proxima — Termination Conditions.
// Provides composable conditions (quality, max turns, timeout, token budget) to check task completion.

import { DEFAULTS } from '../config/defaults.js';



class TerminationCondition {
    constructor(name) {
        this.name = name;
        this._triggered = false;
    }

    check() { return null; }

    reset() { this._triggered = false; }

    get triggered() { return this._triggered; }
}


class QualityThreshold extends TerminationCondition {
    constructor(threshold = 8) {
        super('QualityThreshold');
        this.threshold = threshold;
    }

    check(context) {
        if (context.score >= this.threshold) {
            this._triggered = true;
            return {
                shouldStop: true,
                reason: `Quality score ${context.score}/10 >= threshold ${this.threshold}`,
                source: this.name,
            };
        }
        return null;
    }
}


class MaxTurns extends TerminationCondition {
    constructor(maxTurns = 3) {
        super('MaxTurns');
        this.maxTurns = maxTurns;
        this.currentTurn = 0;
    }

    check(context) {
        this.currentTurn = context.turn || this.currentTurn + 1;
        if (this.currentTurn >= this.maxTurns) {
            this._triggered = true;
            return {
                shouldStop: true,
                reason: `Max turns ${this.maxTurns} reached`,
                source: this.name,
            };
        }
        return null;
    }

    reset() {
        super.reset();
        this.currentTurn = 0;
    }
}


class TimeoutCondition extends TerminationCondition {
    constructor(timeoutMs = 60000) {
        super('Timeout');
        this.timeoutMs = timeoutMs;
        this.startTime = Date.now();
    }

    check() {
        const elapsed = Date.now() - this.startTime;
        if (elapsed >= this.timeoutMs) {
            this._triggered = true;
            return {
                shouldStop: true,
                reason: `Timeout after ${Math.round(elapsed / 1000)}s`,
                source: this.name,
            };
        }
        return null;
    }

    reset() {
        super.reset();
        this.startTime = Date.now();
    }
}


class TokenBudget extends TerminationCondition {
    constructor(maxTokens = 50000) {
        super('TokenBudget');
        this.maxTokens = maxTokens;
        this.totalTokens = 0;
    }

    check(context) {
        this.totalTokens += context.tokensUsed || 0;
        if (this.totalTokens >= this.maxTokens) {
            this._triggered = true;
            return {
                shouldStop: true,
                reason: `Token budget ${this.maxTokens} exceeded (used: ${this.totalTokens})`,
                source: this.name,
            };
        }
        return null;
    }

    reset() {
        super.reset();
        this.totalTokens = 0;
    }
}


class CompositeCondition extends TerminationCondition {
    constructor(mode, conditions) {
        super(`Composite(${mode})`);
        this.mode = mode;
        this.conditions = conditions;
    }

    check(context) {
        const results = this.conditions
            .map(c => c.check(context))
            .filter(r => r !== null);

        if (this.mode === 'OR' && results.length > 0) {
            this._triggered = true;
            return results[0];
        }

        if (this.mode === 'AND' && results.length === this.conditions.length) {
            this._triggered = true;
            return {
                shouldStop: true,
                reason: results.map(r => r.reason).join(' AND '),
                source: this.name,
            };
        }

        return null;
    }

    reset() {
        super.reset();
        this.conditions.forEach(c => c.reset());
    }
}


function createTerminations(type, overrides = {}) {
    switch (type) {
        case 'loop':
            return new CompositeCondition('OR', [
                new QualityThreshold(overrides.quality || 8),
                new MaxTurns(overrides.maxTurns || DEFAULTS.RUN_LOOP_DEFAULT_MAX_TURNS),
                new TimeoutCondition(overrides.timeoutMs || 120000),
            ]);

        case 'workflow':
            return new CompositeCondition('OR', [
                new TimeoutCondition(overrides.timeoutMs || 300000),
                new TokenBudget(overrides.tokenBudget || 100000),
            ]);

        default:
            return new CompositeCondition('OR', [
                new MaxTurns(overrides.maxTurns || 3),
                new TimeoutCondition(overrides.timeoutMs || 60000),
            ]);
    }
}

export {
    TerminationCondition,
    QualityThreshold,
    MaxTurns,
    TimeoutCondition,
    TokenBudget,
    CompositeCondition,
    createTerminations,
};
