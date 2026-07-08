// Proxima — BYOK Brain Storage Primitives Tests.
// Verifies atomic JSON write-read round-trips, quarantining of corrupt JSON files, and missing file handling.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const paths = require('../../electron/api/byok/brain/paths.cjs');

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-paths-')); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('atomicWriteJSON + readJSON round-trip', () => {
    const f = path.join(dir, 'store.json');
    paths.atomicWriteJSON(f, { facts: [{ k: 'v' }], n: 7 });
    const got = paths.readJSON(f);
    assert.deepEqual(got, { facts: [{ k: 'v' }], n: 7 });
    const leftovers = fs.readdirSync(dir).filter((x) => x.includes('.tmp'));
    assert.equal(leftovers.length, 0, 'no temp file should remain');
});

test('corrupt JSON is quarantined, not overwritten', () => {
    const f = path.join(dir, 'corrupt.json');
    fs.writeFileSync(f, '{ this is : not valid json', 'utf8');

    const got = paths.readJSON(f);
    assert.equal(got, null, 'unparseable file yields null');

    const quarantined = fs.readdirSync(dir).filter((x) => x.startsWith('corrupt.json.corrupt-'));
    assert.equal(quarantined.length, 1, 'corrupt file must be quarantined');
    assert.ok(!fs.existsSync(f), 'original corrupt path must no longer exist');
});

test('missing file → null, no quarantine', () => {
    const f = path.join(dir, 'does-not-exist.json');
    assert.equal(paths.readJSON(f), null);
    const quarantined = fs.readdirSync(dir).filter((x) => x.includes('.corrupt-'));
    // Only the one from the previous test should exist (none new for a missing file).
    assert.ok(!quarantined.some((x) => x.startsWith('does-not-exist')));
});
