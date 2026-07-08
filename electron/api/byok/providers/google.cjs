// Proxima — Gemini BYOK Connector.
// Connects to Gemini API, managing contents/parts layout conversion, systemInstruction, and tools layout translation.

'use strict';

const { postJson } = require('./_http.cjs');
const { API_ENDPOINTS, MAX_TOKENS, resolveModel } = require('../models.cjs');

async function call(apiKey, messageOrMessages, options = {}) {
    const { engine, filePath, tools, modelId } = options;
    const model = resolveModel('gemini', engine, modelId);

    let systemInstruction = undefined;
    let contents;

    if (Array.isArray(messageOrMessages)) {
        const sysMsgs = messageOrMessages.filter(m => m.role === 'system');
        if (sysMsgs.length > 0) {
            systemInstruction = {
                parts: [{ text: sysMsgs.map(m => m.content).join('\n\n') }]
            };
        }

        contents = _convertMessagesToGemini(messageOrMessages, filePath);
    } else {
        const parts = _buildParts(messageOrMessages, filePath);
        contents = [{ role: 'user', parts }];
    }

    const payload = {
        contents,
        generationConfig: {
            maxOutputTokens: MAX_TOKENS.gemini,
        },
    };

    if (systemInstruction) {
        payload.systemInstruction = systemInstruction;
    }

    const geminiTools = _convertToolsToGemini(tools);
    if (geminiTools && geminiTools.length > 0) {
        payload.tools = geminiTools;
    }

    const body = JSON.stringify(payload);

    const start = Date.now();
    const response = await _request(apiKey, model, body);
    const elapsed = Date.now() - start;

    const text = _extractText(response);
    const toolCalls = _extractToolCalls(response);

    if (!text && !toolCalls) {
        const blockReason = response.promptFeedback?.blockReason;
        if (blockReason) {
            throw new Error(`Google AI blocked the request (reason: ${blockReason}).`);
        }
        const finish = response.candidates?.[0]?.finishReason;
        throw new Error(
            `Google AI returned no content${finish ? ` (finishReason: ${finish})` : ''} — ` +
            `the request may have been refused or safety-filtered.`
        );
    }

    return { text, toolCalls, model, responseTimeMs: elapsed };
}

function _convertMessagesToGemini(openAiMessages, filePath) {
    const contents = [];

    openAiMessages.forEach((m, idx) => {
        if (m.role === 'system') return;

        const role = m.role === 'assistant' ? 'model' : 'user';
        const parts = [];

        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            m.tool_calls.forEach(tc => {
                let args = {};
                try {
                    args = typeof tc.function.arguments === 'string'
                        ? JSON.parse(tc.function.arguments)
                        : tc.function.arguments;
                } catch {
                    args = { raw_args: tc.function.arguments };
                }
                parts.push({
                    functionCall: {
                        name: tc.function.name,
                        args
                    }
                });
            });
        } else if (m.role === 'tool') {
            parts.push({
                functionResponse: {
                    name: m.name || 'execute',
                    response: { output: m.content }
                }
            });
        } else {
            if (filePath && idx === openAiMessages.length - 1 && role === 'user') {
                parts.push(..._buildParts(m.content, filePath));
            } else {
                parts.push({ text: m.content || '' });
            }
        }

        if (parts.length > 0) {
            contents.push({ role, parts });
        }
    });

    return contents;
}

function _convertToolsToGemini(openAiTools) {
    if (!openAiTools || !Array.isArray(openAiTools)) return undefined;
    const functionDeclarations = openAiTools.map(t => {
        const fn = t.function || t;
        return {
            name: fn.name,
            description: fn.description || '',
            parameters: fn.parameters || { type: 'object', properties: {} }
        };
    });
    return [{ functionDeclarations }];
}

function _extractToolCalls(response) {
    const candidates = response.candidates;
    if (!candidates || candidates.length === 0) return null;
    const parts = candidates[0].content?.parts;
    if (!parts || !Array.isArray(parts)) return null;
    const calls = parts.filter(p => p.functionCall);
    if (calls.length === 0) return null;
    return calls.map((c, i) => ({
        id: `call_gemini_${Date.now()}_${i}`,
        type: 'function',
        function: {
            name: c.functionCall.name,
            arguments: typeof c.functionCall.args === 'string' ? c.functionCall.args : JSON.stringify(c.functionCall.args || {})
        }
    }));
}

function _extractText(response) {
    const candidates = response.candidates;
    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
        return '';
    }

    const parts = candidates[0].content?.parts;
    if (!parts || !Array.isArray(parts)) return '';

    return parts
        .filter(p => p.text)
        .map(p => p.text)
        .join('');
}

function _buildParts(message, filePath) {
    const parts = [];

    if (filePath) {
        try {
            const fs = require('fs');
            const path = require('path');
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
            };
            const mime = mimeTypes[ext];

            if (mime && fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath);
                parts.push({
                    inlineData: {
                        mimeType: mime,
                        data: data.toString('base64'),
                    },
                });
            }
        } catch (e) {
            console.error('[BYOK/Google] Failed to read file for multimodal:', e.message);
        }
    }

    parts.push({ text: message });
    return parts;
}

function _request(apiKey, model, body) {
    const endpoint =
        `${API_ENDPOINTS.google}/${encodeURIComponent(model)}:generateContent`;
    return postJson(
        endpoint,
        {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body,
        'Google AI API',
    );
}

module.exports = { call };
