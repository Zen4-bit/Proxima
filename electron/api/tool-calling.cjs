// Proxima — Tool-Calling Bridge.
// Translates OpenAI-style function calling to plain-text session prompts and parses tool invocations.

const TOOL_SYSTEM = `HOW TO USE TOOLS:
When you need to use a tool, respond with ONLY this exact JSON format (nothing else):
{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"TOOL_NAME","arguments":{"key":"value"}}}]}

- The "arguments" must be a JSON OBJECT (not a string)
- ONE tool call per response
- No text before or after the JSON when calling a tool
- Do NOT wrap in code blocks or markdown
- When NOT using a tool, respond with plain text only
- After receiving a tool result, either call another tool OR give your final text response
- When the user clearly asks you to do something actionable, do it instead of only describing how
- CRITICAL: ONLY use the tool names listed below. NEVER invent tools like "google:search", "web_search", "browser:navigate", or any other name. The ONLY tool is "execute".`;

function buildToolCallingPrompt(body) {
    const { messages = [], tools = [], tool_choice } = body;
    const parts = [];

    const sysMsgs = messages.filter(m => m.role === 'system');
    if (sysMsgs.length) {
        sysMsgs.forEach(m => parts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
        parts.push('');
    }

    parts.push(TOOL_SYSTEM);
    parts.push('');

    parts.push('=== AVAILABLE TOOLS ===');
    tools.forEach(t => {
        const fn = t.function || t;
        parts.push(`Tool: ${fn.name}`);
        if (fn.description) parts.push(`  Description: ${fn.description}`);
        if (fn.parameters) parts.push(`  Parameters: ${JSON.stringify(fn.parameters)}`);
        parts.push('');
    });

    if (tool_choice === 'none') {
        parts.push('NOTE: Do NOT use any tools. Respond with text only.');
    } else if (tool_choice === 'required') {
        parts.push('NOTE: You MUST use at least one tool.');
    } else if (typeof tool_choice === 'object' && tool_choice?.function?.name) {
        parts.push(`NOTE: You MUST use the tool "${tool_choice.function.name}".`);
    }
    parts.push('');

    parts.push('=== CONVERSATION ===');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const lastMsg = nonSystem[nonSystem.length - 1];

    if (lastMsg) {
        if (lastMsg.role === 'user') {
            const c = typeof lastMsg.content === 'string' ? lastMsg.content :
                Array.isArray(lastMsg.content) ? lastMsg.content.map(p => p.type === 'text' ? p.text : `[${p.type}]`).join('\n') :
                    JSON.stringify(lastMsg.content);
            parts.push(`[USER]: ${c}`);
        } else if (lastMsg.role === 'tool') {
            parts.push(`[TOOL RESULT ${lastMsg.tool_call_id || ''}]: ${lastMsg.content}`);
        } else if (lastMsg.role === 'assistant') {
            if (lastMsg.tool_calls && lastMsg.tool_calls.length > 0) {
                parts.push(`[ASSISTANT TOOL CALLS]: ${JSON.stringify(lastMsg.tool_calls)}`);
            } else if (lastMsg.content) {
                parts.push(`[ASSISTANT]: ${lastMsg.content}`);
            }
        }
    }

    return parts.join('\n');
}

function parseToolCallResponse(text) {
    if (!text || typeof text !== 'string') return { isToolCall: false, toolCalls: null, text: text || '' };

    const trimmed = text.trim();

    const hasToolCallSignal = (
        trimmed.includes('tool_calls') ||
        trimmed.includes('"name"') && trimmed.includes('"arguments"') ||
        trimmed.includes('"function"') && trimmed.includes('"name"')
    );

    if (!hasToolCallSignal) {
        return { isToolCall: false, toolCalls: null, text };
    }

    let parsed = tryParse(trimmed);

    if (!parsed) {
        const fencePatterns = [
            /```json\s*\n?([\s\S]*?)\n?\s*```/,
            /```\s*\n?([\s\S]*?)\n?\s*```/,
        ];
        for (const pat of fencePatterns) {
            const m = trimmed.match(pat);
            if (m) {
                parsed = tryParse(m[1].trim());
                if (parsed) break;
            }
        }
    }

    if (!parsed) {
        const startIdx = trimmed.indexOf('{"tool_calls"');
        if (startIdx !== -1) {
            const jsonStr = extractBalancedJSON(trimmed, startIdx);
            if (jsonStr) parsed = tryParse(jsonStr);
        }
    }

    if (!parsed) {
        for (let i = 0; i < trimmed.length; i++) {
            if (trimmed[i] === '{') {
                const jsonStr = extractBalancedJSON(trimmed, i);
                if (jsonStr && jsonStr.includes('tool_calls')) {
                    parsed = tryParse(jsonStr);
                    if (parsed) break;
                }
            }
        }
    }

    if (!parsed) {
        parsed = tryExtractToolCall(trimmed);
    }

    if (!parsed) {
        try {
            let unescaped = trimmed.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            parsed = tryParse(unescaped);
        } catch { }
    }

    if (!parsed) {
        const jsonBlocks = trimmed.match(/\{[\s\S]*\}/g);
        if (jsonBlocks) {
            const sorted = jsonBlocks.sort((a, b) => b.length - a.length);
            for (const block of sorted) {
                if (block.includes('tool_calls') || (block.includes('"name"') && block.includes('"arguments"'))) {
                    parsed = tryParse(block);
                    if (parsed) break;
                    const balanced = extractBalancedJSON(block, 0);
                    if (balanced) {
                        parsed = tryParse(balanced);
                        if (parsed) break;
                    }
                }
            }
        }
    }

    if (parsed?.tool_calls && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
        const toolCalls = parsed.tool_calls.map((tc, i) => ({
            id: tc.id || `call_${Date.now()}_${i}`,
            type: 'function',
            function: {
                name: tc.function?.name || tc.name || 'unknown',
                arguments: typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function?.arguments || tc.arguments || {})
            }
        }));
        return { isToolCall: true, toolCalls, text: null };
    }

    return { isToolCall: false, toolCalls: null, text };
}

function tryParse(str) {
    try { const p = JSON.parse(str); return p?.tool_calls ? p : null; }
    catch {
        try {
            const fixed = str.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
            const p = JSON.parse(fixed);
            return p?.tool_calls ? p : null;
        } catch { return null; }
    }
}

function extractBalancedJSON(str, start) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
    }
    return null;
}

function tryExtractToolCall(text) {
    const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
    if (!nameMatch) return null;
    const name = nameMatch[1];

    const argsStart = text.indexOf('"arguments"');
    if (argsStart === -1) return null;

    const colonIdx = text.indexOf(':', argsStart + 11);
    if (colonIdx === -1) return null;

    let valueStart = colonIdx + 1;
    while (valueStart < text.length && /\s/.test(text[valueStart])) valueStart++;

    let argsValue = null;

    if (text[valueStart] === '{') {
        const jsonStr = extractBalancedJSON(text, valueStart);
        if (jsonStr) {
            try { argsValue = JSON.parse(jsonStr); } catch {
                try {
                    const fixed = jsonStr.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
                    argsValue = JSON.parse(fixed);
                } catch { }
            }
        }
    } else if (text[valueStart] === '"') {
        let end = valueStart + 1;
        while (end < text.length) {
            if (text[end] === '\\') { end += 2; continue; }
            if (text[end] === '"') break;
            end++;
        }
        const str = text.slice(valueStart, end + 1);
        try { argsValue = JSON.parse(str); } catch { }
    }

    if (argsValue !== null) {
        return {
            tool_calls: [{
                id: `call_${Date.now()}_0`,
                type: 'function',
                function: { name, arguments: argsValue }
            }]
        };
    }

    return null;
}

function formatToolCallResponse(toolCalls, model, timeMs) {
    return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: toolCalls },
            finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        proxima: { provider: model, responseTimeMs: timeMs, toolCalling: true }
    };
}

module.exports = { buildToolCallingPrompt, parseToolCallResponse, formatToolCallResponse };
