// Proxima — BYOK Conversation Memory Tests.
// Verifies message sequence round-trips, path traversal sanitizations, safe invalid ID handling, and single/provider-wide clear actions.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mem = require('../../electron/api/byok/memory/index.cjs');

const origAppData = process.env.APPDATA;
const tmpRoots = [];

test.beforeEach(() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-conv-mem-'));
    tmpRoots.push(d);
    process.env.APPDATA = d;
});

test.after(() => {
    process.env.APPDATA = origAppData;
    for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test('save then load round-trips the message sequence', () => {
    const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    mem.save('conv1', msgs);
    assert.deepEqual(mem.load('conv1'), msgs);
});

test('load returns an empty array for an unknown conversation', () => {
    assert.deepEqual(mem.load('does-not-exist'), []);
});

test('conversation IDs are sanitized against path traversal', () => {
    mem.save('../../etc/passwd', [{ role: 'user', content: 'x' }]);
    assert.deepEqual(mem.load('../../etc/passwd'), [{ role: 'user', content: 'x' }]);
    const memDir = path.join(process.env.APPDATA, 'proxima', 'byok-memory');
    const files = fs.readdirSync(memDir);
    assert.ok(files.every((f) => f.endsWith('.json')));
});

test('invalid conversation ids are safe no-ops', () => {
    assert.deepEqual(mem.load(null), []);
    assert.deepEqual(mem.load(''), []);
    assert.doesNotThrow(() => mem.save(null, [{ role: 'user', content: 'x' }]));
});

test('clear removes a single conversation file', () => {
    mem.save('gone', [{ role: 'user', content: 'bye' }]);
    assert.equal(mem.load('gone').length, 1);
    mem.clear('gone');
    assert.deepEqual(mem.load('gone'), []);
});

test('clearProvider removes all conversations for a provider prefix', () => {
    mem.save('gemini:sessionA', [{ role: 'user', content: 'a' }]);
    mem.save('gemini:sessionB', [{ role: 'user', content: 'b' }]);
    mem.save('claude:sessionC', [{ role: 'user', content: 'c' }]);
    mem.clearProvider('gemini');
    assert.deepEqual(mem.load('gemini:sessionA'), []);
    assert.deepEqual(mem.load('gemini:sessionB'), []);
    assert.equal(mem.load('claude:sessionC').length, 1);
});
