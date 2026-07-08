// Proxima — BYOK Provider Router.
// Routes BYOK requests to dedicated or compatible provider connectors.

'use strict';

const openai     = require('./providers/openai.cjs');
const anthropic  = require('./providers/anthropic.cjs');
const google     = require('./providers/google.cjs');
const perplexity = require('./providers/perplexity.cjs');
const compatible = require('./providers/openai-compatible.cjs');

const { getFallbackModels } = require('./models.cjs');

const CALLERS = Object.freeze({
    chatgpt:    openai,
    claude:     anthropic,
    gemini:     google,
    perplexity: perplexity,
    deepseek:   compatible,
    groq:       compatible,
    xai:        compatible,
    openrouter: compatible,
    together:   compatible,
    fireworks:  compatible,
    mistral:    compatible,
    nvidia:     compatible,
});

async function callProvider(provider, apiKey, messageOrMessages, options = {}) {
    let caller = CALLERS[provider];

    if (!caller) {
        try {
            const keys = require('./keys.cjs');
            const store = keys._readStore ? keys._readStore() : {};
            const providerEntry = store[provider];
            if (providerEntry && providerEntry.endpoint) {
                caller = compatible;
                options._customEndpoint = providerEntry.endpoint;
            }
        } catch { }

        if (!caller) {
            throw new Error(`[BYOK] Unknown provider: "${provider}". ` +
                `Known: ${Object.keys(CALLERS).join(', ')}. ` +
                `For custom providers, add an endpoint URL when saving the key.`);
        }
    }

    if (!apiKey || typeof apiKey !== 'string') {
        throw new Error(`[BYOK] No API key provided for ${provider}.`);
    }

    if (!messageOrMessages || (typeof messageOrMessages !== 'string' && !Array.isArray(messageOrMessages))) {
        throw new Error(`[BYOK] No message or history array provided for ${provider}.`);
    }

    let modelsList = [];
    if (options.modelId && options.modelId !== 'auto' && options.modelId !== 'default') {
        modelsList = [options.modelId];
    } else {
        modelsList = getFallbackModels(provider);
    }

    let lastError = null;
    for (let i = 0; i < modelsList.length; i++) {
        const currentModel = modelsList[i];
        try {
            const enrichedOptions = { ...options, provider, modelId: currentModel };
            return await caller.call(apiKey, messageOrMessages, enrichedOptions);
        } catch (err) {
            lastError = err;
            const isAuthError = err.statusCode === 401 || err.status === 401 || /unauthorized|401/i.test(err.message);
            if (isAuthError || i === modelsList.length - 1) {
                throw err;
            }
            console.error(`[BYOK/Fallback] Model "${currentModel}" failed for "${provider}": ${err.message}. Retrying with next model...`);
        }
    }

    throw lastError || new Error(`[BYOK] Fallback models exhausted for ${provider}`);
}

module.exports = { callProvider };
