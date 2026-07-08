// Proxima — BYOK Key Storage Tests.
// Verifies provider validation, endpoint schemas, encryption round-trips, and persistence failure propagations.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const keys = require('../../electron/api/byok/keys.cjs');

const origAppData = process.env.APPDATA;
const tmpRoots = [];

function freshStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-keys-'));
    tmpRoots.push(dir);
    process.env.APPDATA = dir;
    return dir;
}

test.after(() => {
    process.env.APPDATA = origAppData;
    for (const d of tmpRoots) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
});

test('encrypted/plaintext round-trip: save → get → remove', () => {
    freshStore();
    keys.saveKey('chatgpt', 'sk-test-key-123');
    assert.equal(keys.getKey('chatgpt'), 'sk-test-key-123');
    assert.equal(keys.hasKey('chatgpt'), true);
    keys.removeKey('chatgpt');
    assert.equal(keys.getKey('chatgpt'), null);
    assert.equal(keys.hasKey('chatgpt'), false);
});

test('reserved "_meta" provider name is rejected (master toggle protected)', () => {
    freshStore();
    assert.throws(() => keys.saveKey('_meta', 'sk-whatever'), /reserved/i);
    assert.equal(keys.hasKey('_meta'), false);
    keys.setEnabled(true);
    assert.equal(keys.isEnabled(), true);
});

test('custom endpoint validation: rejects unsafe schemes, allows http(s)', () => {
    freshStore();
    assert.throws(() => keys.saveKey('customx', 'keykey1', { endpoint: 'file:///etc/passwd' }), /endpoint/i);
    assert.throws(() => keys.saveKey('customx', 'keykey1', { endpoint: 'not a url' }), /valid URL/i);
    keys.saveKey('customx', 'keykey1', { endpoint: 'http://localhost:11434/v1/chat/completions' });
    assert.equal(keys.getKey('customx'), 'keykey1');
    keys.saveKey('customy', 'keykey2', { endpoint: 'https://api.example.com/v1' });
    assert.equal(keys.getKey('customy'), 'keykey2');
});

test('write failure PROPAGATES (no false "saved")', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-keys-broken-'));
    tmpRoots.push(dir);
    fs.writeFileSync(path.join(dir, 'proxima'), 'x');
    process.env.APPDATA = dir;
    assert.throws(() => keys.saveKey('chatgpt', 'sk-should-fail'), /persist|ENOTDIR|EEXIST|not a directory/i);
});
