// Proxima — Context Pipeline Orchestrator.
// Chains cheap context pruning and LLM-based middle-turn condensation to fit model limits.

'use strict';

const tokens    = require('./tokens.cjs');
const pruner    = require('./pruner.cjs');
const condenser = require('./condenser.cjs');

const DEFAULT_THRESHOLD = 32000;
const DEFAULT_TAIL_BUDGET = 8000;
const DEFAULT_HEAD_COUNT = 2;

async function process(messages, options = {}) {
    if (!messages || !messages.length) return messages;

    const threshold  = options.threshold  || DEFAULT_THRESHOLD;
    const tailBudget = options.tailBudget || DEFAULT_TAIL_BUDGET;
    const headCount  = options.headCount  || DEFAULT_HEAD_COUNT;
    const callFn     = options.callFn     || null;

    const initialTokens = tokens.forAll(messages);
    if (initialTokens <= threshold) {
        return messages;
    }

    console.log(
        `[Context] Over budget: ~${initialTokens.toLocaleString()} tokens ` +
        `(threshold ${threshold.toLocaleString()}) — running pipeline…`
    );

    const { pruned, count: pruneCount } = pruner.prune(messages, tailBudget);

    if (pruneCount > 0) {
        const afterPrune = tokens.forAll(pruned);
        console.log(
            `[Context] Pruned ${pruneCount} message(s) → ` +
            `~${afterPrune.toLocaleString()} tokens`
        );

        if (afterPrune <= threshold) {
            return pruned;
        }
    }

    if (!callFn) {
        console.warn(
            '[Context] No callFn for condenser — falling back to tail truncation'
        );
        return _hardTruncate(pruned, threshold, tailBudget);
    }

    const { result, condensed, saved } = await condenser.condense(pruned, {
        callFn,
        headCount,
        tailBudget,
    });

    if (!condensed) {
        return _hardTruncate(pruned, threshold, tailBudget);
    }

    return result;
}

function _hardTruncate(messages, threshold, tailBudget) {
    const headCount = Math.min(2, messages.length);
    const head = messages.slice(0, headCount);
    const tail = [];

    let budget = threshold - tokens.forAll(head);

    for (let i = messages.length - 1; i >= headCount; i--) {
        const cost = tokens.forMessage(messages[i]);
        if (budget - cost < 0) break;
        tail.unshift(messages[i]);
        budget -= cost;
    }

    const dropped = messages.length - head.length - tail.length;
    if (dropped > 0) {
        console.log(`[Context] Hard truncated — dropped ${dropped} middle message(s)`);
        head.push({
            role: 'user',
            content: `[${dropped} earlier messages were removed to fit context window. Recent conversation continues below.]`,
        });
    }

    return [...head, ...tail];
}

module.exports = {
    process,
    tokens,
    pruner,
    condenser,
};
