// Proxima — BYOK Models Tests.
// Verifies default-model maps, endpoint overrides, model resolution fallbacks, and model eligibility.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const models = require('../../electron/api/byok/models.cjs');


const envVar = process.platform === 'win32' ? 'APPDATA' : 'HOME';
let saved;
let tmp;
test.before(() => {
    saved = process.env[envVar];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-models-'));
    process.env[envVar] = tmp;
});
test.after(() => {
    if (saved === undefined) delete process.env[envVar];
    else process.env[envVar] = saved;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
});


test('exposes frozen default-model / endpoint / max-token maps for all core providers', () => {
    for (const p of ['chatgpt', 'claude', 'gemini', 'perplexity']) {
        assert.ok(models.DEFAULT_MODELS[p], `default model for ${p}`);
        assert.ok(models.MAX_TOKENS[p] > 0, `max tokens for ${p}`);
    }
    assert.equal(models.ANTHROPIC_VERSION, '2023-06-01');
    assert.ok(Object.isFrozen(models.DEFAULT_MODELS));
});


test('resolveModel: falls back to the provider default when nothing is configured', () => {
    assert.equal(models.resolveModel('chatgpt'), 'gpt-5.5');
    assert.equal(models.resolveModel('claude'), 'claude-sonnet-5');
});

test('resolveModel: a Gemini engine override maps to the real model id', () => {
    assert.equal(models.resolveModel('gemini', '3.1-pro'), 'gemini-3.1-pro');
    assert.equal(models.resolveModel('gemini', '3.5-flash'), 'gemini-3.5-flash');
    assert.equal(models.resolveModel('gemini', 'bogus-engine'), 'gemini-3.5-flash');
});

test('resolveModel: an explicit modelId is honored (fail-open when no model list configured)', () => {
    assert.equal(models.resolveModel('chatgpt', null, 'gpt-4o-mini'), 'gpt-4o-mini');
});

test('resolveModel: an unknown provider with no config falls back to the provider name itself', () => {
    assert.equal(models.resolveModel('some-custom-llm'), 'some-custom-llm');
});


test('getEndpoint: returns the known endpoint for core providers', () => {
    assert.match(models.getEndpoint('chatgpt'), /api\.openai\.com/);
    assert.match(models.getEndpoint('claude'), /api\.anthropic\.com/);
    assert.match(models.getEndpoint('perplexity'), /api\.perplexity\.ai/);
});

test('getEndpoint: an explicit custom endpoint overrides everything', () => {
    assert.equal(models.getEndpoint('chatgpt', 'http://localhost:1234/v1'), 'http://localhost:1234/v1');
});

test('getEndpoint: unknown provider with no stored endpoint returns null', () => {
    assert.equal(models.getEndpoint('mystery-provider'), null);
});


test('isModelEnabled: fails open (true) when no model list is configured', () => {
    assert.equal(models.isModelEnabled('chatgpt', 'gpt-5.5'), true);
});

test('getEnabledModels: returns an empty array when nothing is configured', () => {
    assert.deepEqual(models.getEnabledModels('chatgpt'), []);
});
