// Proxima — Brain Orchestrator Tests.
// Verifies buildVolatile assembling, meta lines and stats, fact serialization, and token budgets.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const brain = require('../../electron/api/byok/brain/index.cjs');

const origAppData = process.env.APPDATA;
const tmpRoots = [];

test.beforeEach(() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-index-'));
    tmpRoots.push(d);
    process.env.APPDATA = d;
});

test.after(() => {
    process.env.APPDATA = origAppData;
    for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test('buildVolatile on an empty brain still emits the meta line and stats', () => {
    const { block, stats } = brain.buildVolatile({ model: 'gpt-x', provider: 'openai' });
    assert.match(block, /Current time:/);
    assert.match(block, /Model: gpt-x/);
    assert.match(block, /Provider: openai/);
    assert.equal(typeof stats.totalTokens, 'number');
    assert.equal(stats.recall.items, 0);
});

test('buildVolatile surfaces a saved recall fact in the block', () => {
    brain.recall.save('stack', 'The backend is Node.js with Fastify', { category: 'project', confidence: 0.9 });
    const { block, stats } = brain.buildVolatile({});
    assert.match(block, /Node\.js with Fastify/);
    assert.equal(stats.recall.items, 1);
    assert.ok(stats.recall.tokens > 0);
});

test('buildVolatile respects the token budget', () => {
    for (let i = 0; i < 10; i++) {
        brain.recall.save(`fact-${i}`, `Fact number ${i}: `.repeat(20), { confidence: 0.9 });
    }
    const { stats } = brain.buildVolatile({ budget: 300 });
    assert.ok(stats.totalTokens <= 300, `totalTokens ${stats.totalTokens} must be <= budget 300`);
});

test('getStats returns combined per-module stats', () => {
    brain.recall.save('x', 'a durable fact about the environment', { category: 'environment' });
    const s = brain.getStats();
    assert.ok(s.recall);
    assert.equal(s.recall.active, 1);
    assert.ok(s.experience);
    assert.ok(s.skills);
    assert.ok(s.sessions);
});
