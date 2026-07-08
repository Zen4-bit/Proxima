// Proxima — Memory Store Tests.
// Verifies history logging, newest-first querying, results cap, eviction on overflow, and store resetting.

import test from 'node:test';
import assert from 'node:assert';
import { MemoryHistoryManager } from '../../src/memory/memory-store.js';

test('addHistory stores an entry with an id and the supplied fields', async () => {
    const m = new MemoryHistoryManager();
    await m.addHistory('mem1', null, 'hello', 'ADD', '2026-01-01T00:00:00.000Z');
    const hist = await m.getHistory('mem1');
    assert.equal(hist.length, 1);
    assert.equal(hist[0].memory_id, 'mem1');
    assert.equal(hist[0].new_value, 'hello');
    assert.equal(hist[0].action, 'ADD');
    assert.ok(hist[0].id, 'an id was generated');
});

test('getHistory returns only the requested memory_id, newest first', async () => {
    const m = new MemoryHistoryManager();
    await m.addHistory('a', null, 'first', 'ADD', '2026-01-01T00:00:00.000Z');
    await m.addHistory('a', 'first', 'second', 'UPDATE', '2026-02-01T00:00:00.000Z');
    await m.addHistory('b', null, 'other', 'ADD', '2026-03-01T00:00:00.000Z');
    const hist = await m.getHistory('a');
    assert.equal(hist.length, 2);
    assert.equal(hist[0].new_value, 'second');
    assert.equal(hist[1].new_value, 'first');
});

test('getHistory caps results at 100 for a single memory', async () => {
    const m = new MemoryHistoryManager();
    m.maxEntries = 10000;
    for (let i = 0; i < 150; i++) {
        await m.addHistory('big', null, `v${i}`, 'ADD', new Date(2026, 0, 1, 0, 0, i).toISOString());
    }
    const hist = await m.getHistory('big');
    assert.equal(hist.length, 100);
});

test('the store evicts oldest entries once maxEntries is exceeded', async () => {
    const m = new MemoryHistoryManager();
    m.maxEntries = 5;
    for (let i = 0; i < 8; i++) {
        await m.addHistory(`mem${i}`, null, `v${i}`, 'ADD');
    }
    assert.equal(m.memoryStore.size, 5, 'store never exceeds the cap');
});

test('reset clears the store and close is a safe no-op', async () => {
    const m = new MemoryHistoryManager();
    await m.addHistory('x', null, 'y', 'ADD');
    await m.reset();
    assert.equal(m.memoryStore.size, 0);
    assert.doesNotThrow(() => m.close());
});
