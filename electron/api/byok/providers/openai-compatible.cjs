// Proxima — OpenAI-Compatible BYOK Connector.
// Routes to OpenAI-compatible provider endpoints with model fallback chains and vision support.

'use strict';

const { postJson } = require('./_http.cjs');
const { API_ENDPOINTS, MAX_TOKENS, resolveModel, getEndpoint } = require('../models.cjs');

function _getExtraHeaders(provider) {
    switch (provider) {
        case 'openrouter':
            return {
                'HTTP-Referer': 'https://proxima.app',
                'X-Title': 'Proxima AI Gateway',
            };
        default:
            return {};
    }
}

const _stickyModels = {};
const _modelListCache = {};
const _failedModels = {};

const MAX_RETRIES = 2;

async function _getModelList(provider, apiKey) {
    if (_modelListCache[provider]?.length) return _modelListCache[provider];
    try {
        const { fetchModels } = require('../model-fetcher.cjs');
        const result = await fetchModels(provider, apiKey);
        if (result.success && result.models.length) {
            _modelListCache[provider] = result.models;
            return result.models;
        }
    } catch (e) {
        console.error(`[BYOK/Sticky] Failed to fetch model list for ${provider}:`, e.message);
    }
    return [];
}

async function _pickNextModel(provider, apiKey) {
    const models = await _getModelList(provider, apiKey);
    const failed = _failedModels[provider] || new Set();
    for (const m of models) {
        if (!failed.has(m)) return m;
    }
    return null;
}

async function call(apiKey, messageOrMessages, options = {}) {
    const provider = options.provider;
    if (!provider) {
        throw new Error('[BYOK/Compatible] No provider name passed in options.');
    }

    const endpoint = getEndpoint(provider, options._customEndpoint);
    if (!endpoint) {
        throw new Error(`[BYOK/Compatible] No API endpoint for provider: "${provider}". ` +
            `Add an endpoint URL when configuring this provider.`);
    }

    const userSelectedModel = resolveModel(provider, options.engine, options.modelId || null);
    const isAuto = !require('../keys.cjs').getSelectedModel(provider) && !options.modelId;

    let model;
    if (isAuto && _stickyModels[provider]) {
        model = _stickyModels[provider];
    } else {
        model = userSelectedModel;
    }

    const maxTokens = MAX_TOKENS[provider] || 4096;

    let messages;
    if (Array.isArray(messageOrMessages)) {
        messages = messageOrMessages.map(m => ({ ...m }));
        if (options.filePath && _supportsVision(provider) && messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg.role === 'user') {
                lastMsg.content = _buildMultimodalContent(lastMsg.content, options.filePath);
            }
        }
    } else {
        const content = options.filePath && _supportsVision(provider)
            ? _buildMultimodalContent(messageOrMessages, options.filePath)
            : messageOrMessages;
        messages = [{ role: 'user', content }];
    }

    let lastError = null;
    let currentModel = model;
    const triedModels = new Set();

    const _isTransient = (e) => {
        const s = e && e.statusCode;
        if (s === undefined) return true;
        return s >= 500;
    };

    const _isFatalKeyError = (e) => {
        const s = e && e.statusCode;
        return s === 401 || s === 403 || s === 429;
    };

    while (currentModel) {
        triedModels.add(currentModel);

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const payload = {
                    model: currentModel,
                    messages,
                    max_tokens: maxTokens,
                };

                if (options.tools && options.tools.length > 0) {
                    payload.tools = options.tools;
                }

                const body = JSON.stringify(payload);
                const start = Date.now();
                const response = await _request(provider, apiKey, endpoint, body);
                const elapsed = Date.now() - start;

                const choiceMessage = response.choices?.[0]?.message;
                const text = choiceMessage?.content || '';
                const toolCalls = choiceMessage?.tool_calls || null;
                const usedModel = response.model || currentModel;

                if (!text && !toolCalls) {
                    throw new Error(`${provider} returned no content (empty completion)`);
                }

                if (isAuto) {
                    _stickyModels[provider] = currentModel;
                    delete _failedModels[provider];
                }

                return { text, toolCalls, model: usedModel, responseTimeMs: elapsed };

            } catch (e) {
                lastError = e;

                if (_isFatalKeyError(e)) {
                    console.error(`[BYOK/Sticky] ${provider} key/quota error (HTTP ${e.statusCode}) — aborting model fallback: ${e.message}`);
                    throw e;
                }

                if (attempt < MAX_RETRIES && _isTransient(e)) {
                    console.log(`[BYOK/Sticky] ${provider}/${currentModel} attempt ${attempt + 1} failed (transient), retrying... (${e.message})`);
                    continue;
                }
                console.error(`[BYOK/Sticky] ${provider}/${currentModel} failed: ${e.message}`);
                break;
            }
        }

        if (!isAuto) break;

        if (!_failedModels[provider]) _failedModels[provider] = new Set();
        _failedModels[provider].add(currentModel);
        delete _stickyModels[provider];

        const nextModel = await _pickNextModel(provider, apiKey);
        if (!nextModel || triedModels.has(nextModel)) break;

        console.log(`[BYOK/Sticky] Switching ${provider}: ${currentModel} → ${nextModel}`);
        currentModel = nextModel;
    }

    delete _failedModels[provider];
    throw lastError || new Error(`[BYOK] All models exhausted for ${provider}`);
}

function _supportsVision(provider) {
    const visionProviders = ['deepseek', 'groq', 'xai', 'openrouter', 'fireworks'];
    return visionProviders.includes(provider);
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
        console.error(`[BYOK/Compatible] Failed to read file for multimodal:`, e.message);
    }

    return parts;
}

function _request(provider, apiKey, endpoint, body) {
    return postJson(
        endpoint,
        {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ..._getExtraHeaders(provider),
        },
        body,
        `${provider} API`,
    );
}

module.exports = { call };
