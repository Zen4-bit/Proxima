// Proxima — OpenAI BYOK Connector.
// Connects to OpenAI chat completions API, handling bearer authorization and multimodal/tool formatting.

'use strict';

const { postJson } = require('./_http.cjs');
const { API_ENDPOINTS, MAX_TOKENS, resolveModel } = require('../models.cjs');

async function call(apiKey, messageOrMessages, options = {}) {
    const model = resolveModel('chatgpt', null, options.modelId || null);
    const { filePath, tools } = options;

    let messages;
    if (Array.isArray(messageOrMessages)) {
        messages = messageOrMessages.map(m => ({ ...m }));
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
        messages,
        max_completion_tokens: MAX_TOKENS.chatgpt,
        store: false,
    };

    if (tools && tools.length > 0) {
        payload.tools = tools;
    }

    const body = JSON.stringify(payload);

    const start = Date.now();
    const response = await _request(apiKey, body);
    const elapsed = Date.now() - start;

    const choiceMessage = response.choices?.[0]?.message;
    const text = choiceMessage?.content || '';
    const toolCalls = choiceMessage?.tool_calls || null;
    const usedModel = response.model || model;

    if (!text && !toolCalls) {
        const finish = response.choices?.[0]?.finish_reason;
        throw new Error(
            `OpenAI returned no content${finish ? ` (finish_reason: ${finish})` : ''} — ` +
            `the request may have been refused or content-filtered.`
        );
    }

    return { text, toolCalls, model: usedModel, responseTimeMs: elapsed };
}

function _buildMultimodalContent(message, filePath) {
    const fs = require('fs');
    const path = require('path');

    const parts = [];
    if (Array.isArray(message)) {
        parts.push(...message);
    } else {
        parts.push({ type: 'text', text: message || '' });
    }

    try {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp',
        };
        const mime = mimeTypes[ext];

        if (mime && fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath);
            const base64 = data.toString('base64');
            parts.push({
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${base64}` },
            });
        }
    } catch (e) {
        console.error('[BYOK/OpenAI] Failed to read file for multimodal:', e.message);
    }

    return parts;
}

function _request(apiKey, body) {
    return postJson(
        API_ENDPOINTS.chatgpt,
        {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body,
        'OpenAI API',
    );
}

module.exports = { call };
