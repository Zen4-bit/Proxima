// Proxima — Context Pruner.
// Performs token-budgeted pruning of old tool outputs and truncates large argument blobs.

'use strict';

const tokens = require('./tokens.cjs');

const TOOL_OUTPUT_CUTOFF   = 500;
const ASSISTANT_TEXT_CUTOFF = 2000;
const TOOL_ARGS_CUTOFF     = 200;

function _briefToolResult(toolName, parsedArgs, content) {
    const len   = (content || '').length;
    const lines = content ? content.split('\n').length : 0;
    const args  = parsedArgs || {};

    switch (toolName) {
        case 'execute': {
            const snippet = (args.code || '').slice(0, 60).replace(/\n/g, ' ');
            const suffix  = (args.code || '').length > 60 ? '…' : '';
            return `[execute] "${snippet}${suffix}" → ${lines} lines output`;
        }
        case 'read_file': {
            const p = args.path || args.file || '?';
            return `[read_file] ${p} (${len.toLocaleString()} chars)`;
        }
        case 'write_file': {
            const p = args.path || args.file || '?';
            return `[write_file] wrote ${p}`;
        }
        case 'search':
        case 'grep': {
            const q = args.query || args.pattern || '?';
            return `[${toolName}] "${q}" (${len.toLocaleString()} chars result)`;
        }
        case 'browser_navigate':
        case 'browser_click':
        case 'browser_snapshot':
        case 'browser_type': {
            const url = args.url || '';
            return `[${toolName}] ${url ? url.slice(0, 60) : ''} (${len.toLocaleString()} chars)`;
        }
        default: {
            const hint = Object.entries(args).slice(0, 2)
                .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
                .join(' ');
            return `[${toolName || 'tool'}] ${hint} (${len.toLocaleString()} chars)`;
        }
    }
}

function _shrinkJsonValues(obj, maxLen) {
    if (typeof obj === 'string' && obj.length > maxLen) {
        return obj.slice(0, maxLen) + '…[trimmed]';
    }
    if (Array.isArray(obj)) return obj.map(v => _shrinkJsonValues(v, maxLen));
    if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = _shrinkJsonValues(v, maxLen);
        return out;
    }
    return obj;
}

function _truncateArgs(argsStr, maxLen) {
    try {
        return JSON.stringify(_shrinkJsonValues(JSON.parse(argsStr), maxLen));
    } catch {
        return argsStr.length > maxLen ? argsStr.slice(0, maxLen) + '…' : argsStr;
    }
}

function prune(messages, tailBudget = 8000) {
    if (!messages.length) return { pruned: messages, count: 0 };

    const result = messages.map(m => ({ ...m }));
    let count = 0;

    let tailTokens = 0;
    let boundary = result.length;
    for (let i = result.length - 1; i >= 0; i--) {
        tailTokens += tokens.forMessage(result[i]);
        if (tailTokens > tailBudget) {
            boundary = i + 1;
            break;
        }
    }

    for (let i = 0; i < boundary; i++) {
        const msg = result[i];

        if (msg.role === 'system') continue;

        if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > TOOL_OUTPUT_CUTOFF) {
            msg.content = _briefToolResult(msg.name || 'tool', {}, msg.content);
            count++;
            continue;
        }

        if (msg.role === 'assistant' && msg.tool_calls) {
            let changed = false;
            msg.tool_calls = msg.tool_calls.map(tc => {
                const fn   = tc.function || {};
                const args = fn.arguments || '';
                if (args.length > TOOL_ARGS_CUTOFF) {
                    changed = true;
                    return { ...tc, function: { ...fn, arguments: _truncateArgs(args, TOOL_ARGS_CUTOFF) } };
                }
                return tc;
            });
            if (changed) count++;
            continue;
        }

        if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > ASSISTANT_TEXT_CUTOFF) {
            msg.content =
                msg.content.slice(0, 800) +
                '\n…[earlier output trimmed]…\n' +
                msg.content.slice(-400);
            count++;
        }
    }

    return { pruned: result, count };
}

module.exports = { prune };
