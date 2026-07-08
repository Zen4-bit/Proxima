// Proxima — Enhanced Memory Tests.
// Verifies session creation, message truncation, auto-summarization, project contexts, facts, and session eviction.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enh-mem-'));
process.env.PROXIMA_DATA_DIR = tmpDir;


const { EnhancedMemory } = await import('../../src/agentic/enhanced-memory.js');

test.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('getOrCreateSession creates once then reuses the same object', () => {
    const m = new EnhancedMemory();
    const s1 = m.getOrCreateSession('s1');
    const s2 = m.getOrCreateSession('s1');
    assert.strictEqual(s1, s2);
    assert.equal(s1.id, 's1');
    assert.deepEqual(s1.messages, []);
});

test('addToSession stores a message and truncates content over 2000 chars', () => {
    const m = new EnhancedMemory();
    m.addToSession('s1', 'user', 'x'.repeat(5000), 'chatgpt');
    const session = m.getOrCreateSession('s1');
    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0].content.length, 2000);
    assert.equal(session.messages[0].provider, 'chatgpt');
});

test('addToSession auto-summarizes once the history exceeds 20 messages', () => {
    const m = new EnhancedMemory();
    for (let i = 0; i < 25; i++) {
        m.addToSession('big', 'user', `message number ${i} discussing databases indexing`, 'claude');
    }
    const session = m.getOrCreateSession('big');
    assert.ok(session.summary.length > 0, 'a summary was generated');

    assert.ok(session.messages.length < 20, `expected trimmed history, got ${session.messages.length}`);
});

test('getSessionContext renders summary and recent messages', () => {
    const m = new EnhancedMemory();
    m.addToSession('ctx', 'user', 'how do I center a div', null);
    m.addToSession('ctx', 'assistant', 'use flexbox with justify-content center', 'chatgpt');
    const ctx = m.getSessionContext('ctx', 5);
    assert.match(ctx, /RECENT MESSAGES/);
    assert.match(ctx, /center a div/);
    assert.match(ctx, /AI \(chatgpt\)/);
});

test('getSessionContext returns empty string for an unknown session', () => {
    const m = new EnhancedMemory();
    assert.equal(m.getSessionContext('nope'), '');
});

test('project context is stored and retrieved, unknown path returns null', () => {
    const m = new EnhancedMemory();
    m.setProjectContext('/proj/a', { language: 'ts', framework: 'next' });
    const ctx = m.getProjectContext('/proj/a');
    assert.equal(ctx.language, 'ts');
    assert.equal(ctx.framework, 'next');
    assert.ok(ctx.lastUpdated);
    assert.equal(m.getProjectContext('/proj/unknown'), null);
});

test('global facts add, dedupe case-insensitively, and are searchable', () => {
    const m = new EnhancedMemory();
    m.addFact('User prefers PostgreSQL for storage', 'preference');
    m.addFact('user prefers postgresql for storage');
    assert.equal(m.globalFacts.length, 1);
    const hits = m.searchFacts('postgresql storage');
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].relevance > 0.3);
});

test('recall finds a prior question and its AI answer by keyword overlap', () => {
    const m = new EnhancedMemory();
    m.addToSession('r1', 'user', 'how to configure webpack module federation remotes', null);
    m.addToSession('r1', 'assistant', 'set the remotes field in ModuleFederationPlugin', 'claude');
    const results = m.recall('webpack module federation configuration');
    assert.ok(results.length >= 1);
    assert.match(results[0].query, /webpack module federation/);
    assert.match(results[0].answer, /ModuleFederationPlugin/);
    assert.equal(results[0].provider, 'claude');
});

test('getStats aggregates sessions, messages, facts and projects', () => {
    const m = new EnhancedMemory();
    m.addToSession('a', 'user', 'hello there friend', null);
    m.addToSession('b', 'user', 'another message here', null);
    m.addFact('some durable fact about the project');
    m.setProjectContext('/p', { x: 1 });
    const stats = m.getStats();
    assert.ok(stats.totalSessions >= 2);
    assert.ok(stats.totalMessages >= 2);
    assert.ok(stats.totalFacts >= 1);
    assert.ok(stats.totalProjects >= 1);
    assert.ok(!Number.isNaN(Date.parse(stats.oldestSession)));
});

test('session eviction caps retained sessions at the maximum', () => {
    const m = new EnhancedMemory();

    for (let i = 0; i < 520; i++) {
        m.addToSession(`sess-${i}`, 'user', `msg ${i}`, null);
    }
    assert.ok(
        Object.keys(m.sessions).length <= 500,
        `expected <=500 sessions, got ${Object.keys(m.sessions).length}`,
    );
});
