// Proxima — Context Condenser.
// Performs LLM-based summarization of conversation history middle turns.

'use strict';

const tokens = require('./tokens.cjs');

const CONDENSED_TAG = '[CONTEXT CONDENSED — REFERENCE ONLY]';

const SUMMARY_RATIO   = 0.20;
const MIN_SUMMARY_TOK = 500;
const MAX_SUMMARY_TOK = 4000;

function isCondensed(msg) {
    return typeof msg.content === 'string' && msg.content.startsWith(CONDENSED_TAG);
}

function _formatTurn(turn, idx) {
    let value = '';
    if (typeof turn.content === 'string') {
        value = turn.content;
    } else if (turn.tool_calls) {
        value = turn.tool_calls.map(tc => {
            const fn = tc.function || {};
            return `Tool: ${fn.name || '?'}(${(fn.arguments || '').slice(0, 200)})`;
        }).join('\n');
    } else if (turn.content === null) {
        value = '[empty]';
    }

    if (value.length > 3000) {
        value = value.slice(0, 1500) + '\n…[truncated]…\n' + value.slice(-500);
    }

    return `[Turn ${idx} — ${(turn.role || '?').toUpperCase()}]:\n${value}`;
}

function _buildPrompt(turns, startIdx, hasPriorSummary, budgetTokens) {
    const body = turns.map((t, i) => _formatTurn(t, startIdx + i)).join('\n\n');

    return (
        `Summarize the following conversation turns concisely. ` +
        `This summary will REPLACE these turns in the conversation history.\n\n` +
        `Write from a neutral perspective describing what happened:\n` +
        `1. Actions taken (code executed, files modified, browser actions)\n` +
        `2. Key results and outputs\n` +
        `3. Important decisions and findings\n` +
        `4. Current task status and any remaining work\n\n` +
        (hasPriorSummary
            ? `A prior summary is included in the turns — incorporate its info into your updated summary.\n\n`
            : '') +
        `Target approximately ${budgetTokens} tokens. ` +
        `Start your response with "${CONDENSED_TAG}".\n\n` +
        `---\nTURNS TO SUMMARIZE:\n${body}\n---\n\n` +
        `Write ONLY the summary.`
    );
}

async function condense(messages, { callFn, headCount = 2, tailBudget = 8000 }) {
    if (!messages.length || !callFn) {
        return { result: messages, condensed: false, saved: 0 };
    }

    const msgTokens  = tokens.perMessage(messages);
    const totalBefore = msgTokens.reduce((a, b) => a + b, 0);

    const headEnd = Math.min(headCount, messages.length);

    let tailTokens = 0;
    let tailStart  = messages.length;
    for (let i = messages.length - 1; i >= headEnd; i--) {
        tailTokens += msgTokens[i];
        if (tailTokens > tailBudget) {
            tailStart = i + 1;
            break;
        }
    }

    if (tailStart <= headEnd) {
        return { result: messages, condensed: false, saved: 0 };
    }

    const middleTurns  = messages.slice(headEnd, tailStart);
    const middleTokens = middleTurns.reduce((sum, m) => sum + tokens.forMessage(m), 0);

    const summaryBudget = Math.max(
        MIN_SUMMARY_TOK,
        Math.min(Math.floor(middleTokens * SUMMARY_RATIO), MAX_SUMMARY_TOK)
    );

    const hasPrior = middleTurns.some(isCondensed);

    let summary;
    try {
        const prompt = _buildPrompt(middleTurns, headEnd, hasPrior, summaryBudget);
        summary = await callFn(prompt);

        if (!summary || typeof summary !== 'string') {
            throw new Error('Empty summary response');
        }

        if (!summary.startsWith(CONDENSED_TAG)) {
            summary = `${CONDENSED_TAG} ${summary}`;
        }
    } catch (err) {
        console.error('[Context/Condenser] LLM summarization failed:', err.message);

        summary =
            `${CONDENSED_TAG} [Summarization unavailable] ` +
            `${middleTurns.length} earlier turns were removed to save context. ` +
            `Recent conversation continues below.`;
    }

    const condensed = [
        ...messages.slice(0, headEnd),
        { role: 'user', content: summary },
        ...messages.slice(tailStart),
    ];

    const totalAfter = tokens.forAll(condensed);

    console.log(
        `[Context/Condenser] ${middleTurns.length} turns condensed → ` +
        `~${(totalBefore - totalAfter).toLocaleString()} tokens saved ` +
        `(${totalBefore.toLocaleString()} → ${totalAfter.toLocaleString()})`
    );

    return { result: condensed, condensed: true, saved: totalBefore - totalAfter };
}

module.exports = { condense, isCondensed, CONDENSED_TAG };
