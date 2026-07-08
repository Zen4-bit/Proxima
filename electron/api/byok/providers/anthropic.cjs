// Proxima — Anthropic BYOK Connector.
// Connects to Anthropic messages API, handling payload construction, role alternation, and tools format translation.

'use strict';

const { postJson } = require('./_http.cjs');
const { API_ENDPOINTS, ANTHROPIC_VERSION, MAX_TOKENS, resolveModel } = require('../models.cjs');

async function call(apiKey, messageOrMessages, options = {}) {
    const model = resolveModel('claude', null, options.modelId || null);
    const { filePath, tools } = options;

    let system = undefined;
    let messages;

    if (Array.isArray(messageOrMessages)) {
        const sysMsgs = messageOrMessages.filter(m => m.role === 'system');
        if (sysMsgs.length > 0) {
            system = sysMsgs.map(m => m.content).join('\n\n');
        }

        messages = _normalizeAlternation(_convertMessagesToAnthropic(messageOrMessages));

        if (filePath && messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg.role === 'user') {
                lastMsg.content = _buildMultimodalContent(lastMsg.content, filePath);
            }
        }
    } else {
        const content = filePath ? _buildMultimodalContent(messageOrMessages, filePath) : messageOrMessages;
        messages = [{ role: 'user', content }];
    }

    const payload = {
        model,
        max_tokens: MAX_TOKENS.claude,
        messages,
    };

    if (system) {
        payload.system = system;
    }

    const anthropicTools = _convertToolsToAnthropic(tools);
    if (anthropicTools && anthropicTools.length > 0) {
        payload.tools = anthropicTools;
    }

    const body = JSON.stringify(payload);

    const start = Date.now();
    const response = await _request(apiKey, body);
    const elapsed = Date.now() - start;

    const text = _extractText(response);
    const toolCalls = _extractToolCalls(response);
    const usedModel = response.model || model;

    if (!text && !toolCalls) {
        const stop = response.stop_reason;
        throw new Error(
            `Anthropic returned no content${stop ? ` (stop_reason: ${stop})` : ''} — ` +
            `the request may have been refused or filtered.`
        );
    }

    return { text, toolCalls, model: usedModel, responseTimeMs: elapsed };
}

function _normalizeAlternation(messages) {
    const out = [];
    for (const msg of messages) {
        const last = out[out.length - 1];
        if (last && last.role === msg.role) {
            last.content = _toBlocks(last.content).concat(_toBlocks(msg.content));
        } else {
            out.push({ role: msg.role, content: msg.content });
        }
    }
    while (out.length && out[0].role !== 'user') {
        out.shift();
    }
    return out;
}

function _toBlocks(content) {
    if (Array.isArray(content)) return content;
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    if (content == null) return [];
    return [{ type: 'text', text: String(content) }];
}

function _convertMessagesToAnthropic(openAiMessages) {
    const anthropicMessages = [];

    for (const m of openAiMessages) {
        if (m.role === 'system') continue;

        if (m.role === 'assistant') {
            if (m.tool_calls && m.tool_calls.length > 0) {
                const content = [];
                if (m.content) {
                    content.push({ type: 'text', text: m.content });
                }
                m.tool_calls.forEach(tc => {
                    let input = {};
                    try {
                        input = typeof tc.function.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : tc.function.arguments;
                    } catch {
                        input = { raw_args: tc.function.arguments };
                    }
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function.name,
                        input
                    });
                });
                anthropicMessages.push({ role: 'assistant', content });
            } else {
                anthropicMessages.push({ role: 'assistant', content: m.content || '' });
            }
        } else if (m.role === 'tool') {
            const block = {
                type: 'tool_result',
                tool_use_id: m.tool_call_id || m.id,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            };
            
            const lastMsg = anthropicMessages[anthropicMessages.length - 1];
            if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
                lastMsg.content.push(block);
            } else {
                anthropicMessages.push({
                    role: 'user',
                    content: [block]
                });
            }
        } else {
            anthropicMessages.push({ role: 'user', content: m.content });
        }
    }

    return anthropicMessages;
}

function _convertToolsToAnthropic(openAiTools) {
    if (!openAiTools || !Array.isArray(openAiTools)) return undefined;
    return openAiTools.map(t => {
        const fn = t.function || t;
        return {
            name: fn.name,
            description: fn.description || '',
            input_schema: fn.parameters || { type: 'object', properties: {} }
        };
    });
}

function _extractToolCalls(response) {
    if (!response.content || !Array.isArray(response.content)) return null;
    const toolUses = response.content.filter(block => block.type === 'tool_use');
    if (toolUses.length === 0) return null;
    return toolUses.map(tu => ({
        id: tu.id,
        type: 'function',
        function: {
            name: tu.name,
            arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {})
        }
    }));
}

function _extractText(response) {
    if (!response.content || !Array.isArray(response.content)) return '';
    return response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}

function _buildMultimodalContent(message, filePath) {
    const fs = require('fs');
    const path = require('path');

    const parts = [];

    try {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp',
        };
        const mime = mimeTypes[ext];

        if (mime && fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath);
            parts.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: mime,
                    data: data.toString('base64'),
                },
            });
        }
    } catch (e) {
        console.error('[BYOK/Anthropic] Failed to read file for multimodal:', e.message);
    }

    if (Array.isArray(message)) {
        parts.push(...message);
    } else {
        parts.push({ type: 'text', text: message || '' });
    }
    return parts;
}

function _request(apiKey, body) {
    return postJson(
        API_ENDPOINTS.claude,
        {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
        },
        body,
        'Anthropic API',
    );
}

module.exports = { call };
