// Proxima — BYOK Dynamic Model Fetcher.
// Fetches available models from provider endpoints, falling back to static lists when unavailable.

'use strict';

const { getJson } = require('./providers/_http.cjs');

const MODELS_CONFIG = Object.freeze({
    chatgpt: {
        url: 'https://api.openai.com/v1/models',
        auth: 'bearer',
    },
    claude: {
        url: 'https://api.anthropic.com/v1/models',
        auth: 'anthropic',
    },
    gemini: {
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        auth: 'google',
    },
    perplexity: {
        url: null,
        staticModels: [
            'sonar', 'sonar-pro', 'sonar-reasoning-pro',
            'sonar-deep-research', 'r1-1776',
        ],
    },
    deepseek: {
        url: 'https://api.deepseek.com/v1/models',
        auth: 'bearer',
    },
    groq: {
        url: 'https://api.groq.com/openai/v1/models',
        auth: 'bearer',
    },
    xai: {
        url: 'https://api.x.ai/v1/models',
        auth: 'bearer',
    },
    openrouter: {
        url: 'https://openrouter.ai/api/v1/models',
        auth: 'bearer',
    },
    together: {
        url: 'https://api.together.ai/v1/models',
        auth: 'bearer',
    },
    fireworks: {
        url: 'https://api.fireworks.ai/inference/v1/models',
        auth: 'bearer',
    },
    mistral: {
        url: 'https://api.mistral.ai/v1/models',
        auth: 'bearer',
    },
    nvidia: {
        url: 'https://integrate.api.nvidia.com/v1/models',
        auth: 'bearer',
    },
});

function _buildAuthHeaders(authType, apiKey) {
    switch (authType) {
        case 'bearer':
            return { 'Authorization': `Bearer ${apiKey}` };
        case 'anthropic':
            return {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            };
        case 'google':
            return { 'x-goog-api-key': apiKey };
        default:
            return {};
    }
}

function _parseModels(provider, data) {
    if (provider === 'gemini') {
        return (data.models || [])
            .map(m => m.name?.replace('models/', ''))
            .filter(id => id && id.startsWith('gemini'));
    }

    return (data.data || []).map(m => m.id).filter(Boolean);
}

async function fetchModels(provider, apiKey) {
    const config = MODELS_CONFIG[provider];
    if (!config) {
        return { success: false, models: [], error: `Unknown provider: "${provider}"` };
    }

    if (!config.url) {
        return { success: true, models: config.staticModels || [] };
    }

    if (!apiKey || typeof apiKey !== 'string') {
        return { success: false, models: [], error: 'API key is required to fetch models.' };
    }

    try {
        const headers = _buildAuthHeaders(config.auth, apiKey);
        const data = await getJson(config.url, headers, `${provider} models`, { timeoutMs: 15_000 });
        const models = _parseModels(provider, data);

        models.sort((a, b) => a.localeCompare(b));

        console.log(`[BYOK] Fetched ${models.length} models for ${provider}.`);
        return { success: true, models };
    } catch (e) {
        console.error(`[BYOK] Failed to fetch models for ${provider}:`, e.message);
        return { success: false, models: [], error: e.message };
    }
}

module.exports = { fetchModels, MODELS_CONFIG };
