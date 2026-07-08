// Proxima — Memory Intelligence Tests.
// Verifies quality scoring, decay functions, fact harvesting from user messages, deduplication, and consolidation.

import test from 'node:test';
import assert from 'node:assert';
import {
    IntelligentMemory,
    calculateDecay,
    scoreQuality,
    harvestFacts,
    DECAY_CONFIG,
} from '../../src/memory/memory-intelligence.js';

const DAY = 1000 * 60 * 60 * 24;



test('scoreQuality rates a bare greeting low', () => {
    assert.ok(scoreQuality('thanks') < 0.4);
});

test('scoreQuality rates specific technical content higher than a greeting', () => {
    const tech = scoreQuality('The project runs on port 8080 using the express framework in server.js');
    const greet = scoreQuality('hello there');
    assert.ok(tech > greet);
});

test('scoreQuality is clamped to [0,1]', () => {
    const s = scoreQuality('use version v2 on port 3000 with api key, prefer postgres database in app.ts 12345');
    assert.ok(s >= 0 && s <= 1);
});



test('calculateDecay is near 1.0 for a freshly created entry', () => {
    const entry = { createdAt: Date.now(), lastAccessedAt: Date.now(), accessCount: 1 };
    assert.ok(calculateDecay(entry) >= 0.9);
});

test('calculateDecay drops for an old, unaccessed entry but never below the floor', () => {
    const now = Date.now();
    const old = { createdAt: now - 60 * DAY, lastAccessedAt: now - 60 * DAY, accessCount: 1 };
    const score = calculateDecay(old, now);
    assert.ok(score < 0.5, 'a 60-day-old memory has decayed substantially');
    assert.ok(score >= DECAY_CONFIG.minScore, 'never below the minimum floor');
});

test('calculateDecay boosts entries accessed within the last day', () => {
    const now = Date.now();
    const base = { createdAt: now - 10 * DAY, accessCount: 1 };
    const recent = calculateDecay({ ...base, lastAccessedAt: now }, now);
    const stale = calculateDecay({ ...base, lastAccessedAt: now - 5 * DAY }, now);
    assert.ok(recent > stale);
});



test('harvestFacts extracts a tech-stack fact from a user message', () => {
    const facts = harvestFacts([
        { role: 'user', content: 'We are built with: React and Node on the backend' },
    ]);
    assert.ok(facts.some((f) => f.type === 'tech_stack'));
});

test('harvestFacts ignores assistant messages and very short ones', () => {
    const facts = harvestFacts([
        { role: 'assistant', content: 'we use: something the model said' },
        { role: 'user', content: 'hi' },
    ]);
    assert.equal(facts.length, 0);
});



test('add skips very low quality content', () => {
    const mem = new IntelligentMemory();
    const r = mem.add('ok');
    assert.equal(r, null);
    assert.equal(mem.memories.size, 0);
});

test('add dedupes identical content and boosts the existing entry', () => {
    const mem = new IntelligentMemory();
    const content = 'The project uses PostgreSQL on port 5432 in production config';
    const first = mem.add(content);
    assert.ok(first, 'first add stored');
    const before = first.accessCount;
    const second = mem.add(content);
    assert.strictEqual(second, first, 'same entry returned');
    assert.equal(second.accessCount, before + 1, 'access count boosted, not duplicated');
    assert.equal(mem.memories.size, 1);
});

test('retrieve ranks a relevant memory above an unrelated one', () => {
    const mem = new IntelligentMemory();
    mem.add('The database is PostgreSQL running on port 5432 in the backend service');
    mem.add('The frontend framework we use is React with the Vite build tool today');
    const results = mem.retrieve('postgresql database port', 5);
    assert.ok(results.length >= 1);
    assert.match(results[0].content, /PostgreSQL/);
});

test('harvest stores facts as high-quality memories and bounds the fact list', () => {
    const mem = new IntelligentMemory({ maxFacts: 3 });
    const messages = [];
    for (let i = 0; i < 10; i++) {
        messages.push({ role: 'user', content: `We are using: framework number ${i} on the stack today` });
    }
    mem.harvest(messages);
    assert.ok(mem.facts.length <= 3, 'fact list is trimmed to maxFacts');
    assert.ok(mem.stats.harvestedFacts >= 3);
});

test('consolidate force-archives lowest-scoring entries when over capacity', () => {
    const mem = new IntelligentMemory({ maxMemories: 5 });
    for (let i = 0; i < 12; i++) {
        mem.add(`Configuration item number ${i} uses port ${3000 + i} in the service file app${i}.js`);
    }
    assert.ok(mem.memories.size <= 5, `expected <=5 memories, got ${mem.memories.size}`);
    assert.ok(mem.archived.length >= 1, 'some memories were archived');
});

test('getStatus reports active/archived counts and averages', () => {
    const mem = new IntelligentMemory();
    mem.add('The backend uses Redis for caching on port 6379 in the config file');
    const status = mem.getStatus();
    assert.equal(status.activeMemories, 1);
    assert.ok(status.avgQualityScore >= 0 && status.avgQualityScore <= 1);
    assert.equal(status.lastConsolidation, 'never');
    assert.equal(status.totalProcessed, 1);
});
