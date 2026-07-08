// Proxima — BYOK Model Mappings.
// Translates provider names to API model identifiers, endpoints, and token limits.

'use strict';

const FALLBACK_MODELS = Object.freeze({
    chatgpt:    ['gpt-5.5', 'gpt-4o', 'gpt-4o-mini'],
    claude:     ['claude-sonnet-5', 'claude-3-5-sonnet-latest', 'claude-3-haiku-20240307'],
    gemini:     ['gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-2.0-flash-lite'],
    perplexity: ['sonar-pro', 'sonar'],
    deepseek:   ['deepseek-chat'],
    groq:       ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    xai:        ['grok-2-1212', 'grok-beta'],
    openrouter: ['openai/gpt-4o', 'google/gemini-2.0-flash-exp:free'],
    together:   ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    fireworks:  ['accounts/fireworks/models/llama-v3p1-70b-instruct'],
    mistral:    ['mistral-large-latest', 'mistral-small-latest'],
    nvidia:     ['meta/llama-3.3-70b-instruct'],
});

const DEFAULT_MODELS = Object.freeze({
    chatgpt:    FALLBACK_MODELS.chatgpt[0],
    claude:     FALLBACK_MODELS.claude[0],
    gemini:     FALLBACK_MODELS.gemini[0],
    perplexity: FALLBACK_MODELS.perplexity[0],
    deepseek:   FALLBACK_MODELS.deepseek[0],
    groq:       FALLBACK_MODELS.groq[0],
    xai:        FALLBACK_MODELS.xai[0],
    openrouter: FALLBACK_MODELS.openrouter[0],
    together:   FALLBACK_MODELS.together[0],
    fireworks:  FALLBACK_MODELS.fireworks[0],
    mistral:    FALLBACK_MODELS.mistral[0],
    nvidia:     FALLBACK_MODELS.nvidia[0],
});

const GEMINI_ENGINES = Object.freeze({
    '3.5-flash':      'gemini-3.5-flash',
    '3.1-pro':        'gemini-3.1-pro',
    '3.1-flash-lite': 'gemini-2.0-flash-lite',
});

const API_ENDPOINTS = Object.freeze({
    chatgpt:    'https://api.openai.com/v1/chat/completions',
    claude:     'https://api.anthropic.com/v1/messages',
    google:     'https://generativelanguage.googleapis.com/v1beta/models',
    perplexity: 'https://api.perplexity.ai/chat/completions',
    deepseek:   'https://api.deepseek.com/v1/chat/completions',
    groq:       'https://api.groq.com/openai/v1/chat/completions',
    xai:        'https://api.x.ai/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    together:   'https://api.together.ai/v1/chat/completions',
    fireworks:  'https://api.fireworks.ai/inference/v1/chat/completions',
    mistral:    'https://api.mistral.ai/v1/chat/completions',
    nvidia:     'https://integrate.api.nvidia.com/v1/chat/completions',
});

const ANTHROPIC_VERSION = '2023-06-01';

const MAX_TOKENS = Object.freeze({
    chatgpt:    4096,
    claude:     4096,
    gemini:     8192,
    perplexity: 4096,
    deepseek:   4096,
    groq:       4096,
    xai:        4096,
    openrouter: 4096,
    together:   4096,
    fireworks:  4096,
    mistral:    4096,
    nvidia:     4096,
});

function resolveModel(provider, engine = null, modelId = null) {
    if (modelId && typeof modelId === 'string' && modelId !== 'auto' && modelId !== 'default') {
        if (isModelEnabled(provider, modelId)) {
            return modelId;
        }
    }

    if (provider === 'gemini' && engine && GEMINI_ENGINES[engine]) {
        return GEMINI_ENGINES[engine];
    }

    try {
        const keys = require('./keys.cjs');
        const userModel = keys.getSelectedModel(provider);
        if (userModel && userModel !== 'auto' && userModel !== 'default') return userModel;
    } catch { }

    if (DEFAULT_MODELS[provider]) {
        return DEFAULT_MODELS[provider];
    }

    try {
        const keys = require('./keys.cjs');
        const store = keys._readStore ? keys._readStore() : {};
        const entry = store[provider];
        if (entry && entry.selectedModel && entry.selectedModel !== 'auto' && entry.selectedModel !== 'default') return entry.selectedModel;
    } catch { }

    return provider;
}

function getFallbackModels(provider) {
    if (FALLBACK_MODELS[provider]) {
        return [...FALLBACK_MODELS[provider]];
    }
    return [provider];
}

function getEnabledModels(provider) {
    try {
        const keys = require('./keys.cjs');
        const models = keys.getModels(provider);
        return models.filter(m => m.enabled !== false).map(m => m.id);
    } catch {
        return [];
    }
}

function isModelEnabled(provider, modelId) {
    try {
        const keys = require('./keys.cjs');
        const models = keys.getModels(provider);
        if (models.length === 0) return true;
        const match = models.find(m => m.id === modelId);
        return match ? match.enabled !== false : false;
    } catch {
        return true;
    }
}

function getEndpoint(provider, customEndpoint = null) {
    if (customEndpoint) return customEndpoint;

    if (API_ENDPOINTS[provider]) return API_ENDPOINTS[provider];

    try {
        const keys = require('./keys.cjs');
        const store = keys._readStore ? keys._readStore() : {};
        const entry = store[provider];
        if (entry && entry.endpoint) return entry.endpoint;
    } catch { }

    return null;
}

module.exports = {
    DEFAULT_MODELS,
    GEMINI_ENGINES,
    API_ENDPOINTS,
    ANTHROPIC_VERSION,
    MAX_TOKENS,
    resolveModel,
    getEndpoint,
    getFallbackModels,
    getEnabledModels,
    isModelEnabled,
};
