// Proxima — Perplexity BYOK Connector.
// Connects to Perplexity API, utilizing OpenAI-compatible format without multimodal/tool call support.

'use strict';

const { postJson } = require('./_http.cjs');
const { API_ENDPOINTS, MAX_TOKENS, resolveModel } = require('../models.cjs');

async function call(apiKey, messageOrMessages, options = {}) {
    const model = resolveModel('perplexity', null, options.modelId || null);

    const messages = Array.isArray(messageOrMessages)
        ? messageOrMessages.map(m => ({ ...m }))
        : [{ role: 'user', content: messageOrMessages }];

    const body = JSON.stringify({
        model,
        messages,
        max_tokens: MAX_TOKENS.perplexity,
    });

    const start = Date.now();
    const response = await _request(apiKey, body);
    const elapsed = Date.now() - start;

    const text = response.choices?.[0]?.message?.content || '';
    const usedModel = response.model || model;

    if (!text) {
        const finish = response.choices?.[0]?.finish_reason;
        throw new Error(
            `Perplexity returned no content${finish ? ` (finish_reason: ${finish})` : ''}.`
        );
    }

    return { text, toolCalls: null, model: usedModel, responseTimeMs: elapsed };
}

function _request(apiKey, body) {
    return postJson(
        API_ENDPOINTS.perplexity,
        {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body,
        'Perplexity API',
    );
}

module.exports = { call };
