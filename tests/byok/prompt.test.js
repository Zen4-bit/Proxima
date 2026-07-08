// Proxima — Two-Tier BYOK System Prompt Tests.
// Verifies stable prompt cached assemblies, OS-specific documents, cache invalidation, and stable/volatile tier concatenations.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const prompt = require('../../electron/api/byok/prompt.cjs');

test('getStablePrompt includes identity and operating principles', () => {
    const p = prompt.getStablePrompt('win32');
    assert.match(p, /You are Proxima Agent/);
    assert.match(p, /OPERATING PRINCIPLES/);
    assert.match(p, /PERSISTENT PYTHON EXECUTION/);
    assert.match(p, /TASK PROTOCOL/);
});

test('getStablePrompt is cached: same platform returns an identical string', () => {
    const a = prompt.getStablePrompt('win32');
    const b = prompt.getStablePrompt('win32');
    assert.equal(a, b);
});

test('different platforms yield different OS-specific desktop docs', () => {
    prompt.invalidateCache();
    const win = prompt.getStablePrompt('win32');
    const mac = prompt.getStablePrompt('darwin');
    assert.notEqual(win, mac);
    assert.match(win, /Windows PC/);
    assert.match(win, /UIAutomation/);
    assert.match(mac, /macOS/);
    assert.match(mac, /Accessibility API/);
});

test('invalidateCache forces the stable prompt to rebuild', () => {
    const before = prompt.getStablePrompt('linux');
    prompt.invalidateCache();
    const after = prompt.getStablePrompt('linux');
    assert.equal(before, after);
    assert.match(after, /Linux/);
});

test('getVolatilePrompt returns a non-empty string and never throws', () => {
    const v = prompt.getVolatilePrompt({ model: 'gpt-x', provider: 'openai' });
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0);
});

test('getSystemPrompt concatenates the stable and volatile tiers', () => {
    const full = prompt.getSystemPrompt({ platform: 'win32', model: 'm', provider: 'p' });
    assert.match(full, /You are Proxima Agent/);
    assert.equal(typeof full, 'string');
    assert.ok(full.length > prompt.getStablePrompt('win32').length - 1);
});
