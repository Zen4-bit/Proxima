// Proxima — Defaults Tests.
// Verifies structural integrity, types, and invariants of configuration constants.

import test from 'node:test';
import assert from 'node:assert';
import { DEFAULTS, PROVIDER_INFO } from '../../src/config/defaults.js';

test('DEFAULTS exposes the core connection/pipeline numbers as numbers', () => {
    for (const key of [
        'IPC_PORT', 'IPC_CONNECT_TIMEOUT_MS', 'IPC_REQUEST_TIMEOUT_MS',
        'PIPELINE_TIMEOUT_MS', 'MAX_MESSAGE_LENGTH', 'MAX_FILE_SIZE_CHARS',
        'API_PORT',
    ]) {
        assert.equal(typeof DEFAULTS[key], 'number', `${key} must be a number`);
        assert.ok(DEFAULTS[key] > 0, `${key} must be positive`);
    }
});

test('retry delays are internally consistent (base <= max)', () => {
    assert.ok(DEFAULTS.RETRY_BASE_DELAY_MS <= DEFAULTS.RETRY_MAX_DELAY_MS);
    assert.ok(DEFAULTS.MAX_RETRIES >= 0);
});

test('PROVIDER_ORDER lists the four session providers', () => {
    assert.deepEqual(
        [...DEFAULTS.PROVIDER_ORDER].sort(),
        ['chatgpt', 'claude', 'gemini', 'perplexity'],
    );
});

test('TOKENS_PER_DOLLAR has a positive rate for every ordered provider', () => {
    for (const p of DEFAULTS.PROVIDER_ORDER) {
        assert.equal(typeof DEFAULTS.TOKENS_PER_DOLLAR[p], 'number');
        assert.ok(DEFAULTS.TOKENS_PER_DOLLAR[p] > 0);
    }
});

test('PROVIDER_INFO has a name and https url for each provider', () => {
    for (const p of DEFAULTS.PROVIDER_ORDER) {
        assert.ok(PROVIDER_INFO[p], `PROVIDER_INFO.${p} exists`);
        assert.equal(typeof PROVIDER_INFO[p].name, 'string');
        assert.match(PROVIDER_INFO[p].url, /^https:\/\//);
    }
});

test('server identity constants are present', () => {
    assert.equal(typeof DEFAULTS.MCP_SERVER_NAME, 'string');
    assert.match(DEFAULTS.MCP_SERVER_VERSION, /^\d+\.\d+\.\d+$/);
});
