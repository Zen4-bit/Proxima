// Proxima — Model Fetcher Tests.
// Verifies static model lists, unknown provider handling, missing API key rejections, and configurations.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fetchModels, MODELS_CONFIG } = require('../../electron/api/byok/model-fetcher.cjs');

test('perplexity returns its static model list without a network call', async () => {
    const r = await fetchModels('perplexity', 'pplx-key');
    assert.equal(r.success, true);
    assert.ok(Array.isArray(r.models) && r.models.length > 0);
    assert.ok(r.models.includes('sonar-pro'));
});

test('unknown provider is rejected cleanly', async () => {
    const r = await fetchModels('does-not-exist', 'key');
    assert.equal(r.success, false);
    assert.match(r.error, /unknown provider/i);
});

test('a network provider without an API key fails fast (no request)', async () => {
    const r = await fetchModels('chatgpt', '');
    assert.equal(r.success, false);
    assert.match(r.error, /api key/i);
});

test('MODELS_CONFIG covers every known provider name', () => {
    for (const p of ['chatgpt', 'claude', 'gemini', 'perplexity', 'deepseek', 'groq', 'xai', 'openrouter', 'together', 'fireworks', 'mistral', 'nvidia']) {
        assert.ok(MODELS_CONFIG[p], `missing models config for ${p}`);
    }
});
