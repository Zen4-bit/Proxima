// Proxima — Embeddings Tests.
// Verifies downloadModel removal, clean init/embed rejections when absent, and vector similarity mathematics.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const embeddings = require('../../electron/api/byok/brain/embeddings.cjs');

test('downloadModel is removed (no auto-download surface)', () => {
    assert.equal(embeddings.downloadModel, undefined);
    assert.equal(typeof embeddings.isModelReady, 'function');
    assert.equal(typeof embeddings.embed, 'function');
});

test('init() rejects cleanly when the model is absent, and is retryable', async (t) => {
    if (embeddings.isModelReady()) {
        t.skip('embedding model is present in this environment — skipping absent-model test');
        return;
    }
    await assert.rejects(() => embeddings.init(), /not installed|disabled/i);
    await assert.rejects(() => embeddings.init(), /not installed|disabled/i);
    await assert.rejects(() => embeddings.embed('hello world'), /not installed|disabled/i);
});

test('similarity math is correct on normalized vectors', () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([1, 0, 0]);
    const c = Float32Array.from([0, 1, 0]);
    assert.equal(embeddings.similarity(a, b), 1);
    assert.equal(embeddings.similarity(a, c), 0);
    assert.equal(embeddings.similarity(a, null), 0);
});
