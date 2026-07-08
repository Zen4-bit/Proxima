// Proxima — Provider Send Dispatcher Tests.
// Verifies API success shapes, transient error retries, terminal error fail-fasts, and queue serialization for base providers.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sender = require('../../../electron/providers/sender.cjs');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));


let sendImpl;
const providerAPI = { sendViaAPI: (...args) => sendImpl(...args) };
const browserManager = { getWebContents: () => ({ id: 'wc' }) };
sender.init({ browserManager, providerAPI });

test('sendMessageToProvider: resolves { response } on a non-empty API response', async () => {
    sendImpl = async () => 'hello world';
    const r = await sender.sendMessageToProvider('claude', 'hi');
    assert.deepEqual(r, { response: 'hello world' });
});

test('sendMessageToProvider: empty response is deterministic — thrown once, NOT retried', async () => {
    let calls = 0;
    sendImpl = async () => { calls += 1; return ''; };
    await assert.rejects(() => sender.sendMessageToProvider('claude', 'hi'), /empty response/i);
    assert.equal(calls, 1, 'empty must not trigger the retry loop');
});

test('sendMessageToProvider: a transient error is retried up to the bound then fails', async () => {
    let calls = 0;
    sendImpl = async () => { calls += 1; throw new Error('network timeout'); };
    await assert.rejects(() => sender.sendMessageToProvider('claude', 'hi'), /API failed/);
    assert.equal(calls, 2, 'transient errors retry exactly MAX_TRANSIENT_RETRIES times');
});

test('sendMessageToProvider: a terminal error is NOT retried', async () => {
    let calls = 0;
    sendImpl = async () => { calls += 1; throw new Error('Not logged in to Claude'); };
    await assert.rejects(() => sender.sendMessageToProvider('claude', 'hi'), /Not logged in/);
    assert.equal(calls, 1, 'a deterministic/terminal error must fail fast');
});

test('sendMessageToProvider: an AbortError (360s cap) is treated as transient and retried', async () => {
    let calls = 0;
    sendImpl = async () => { calls += 1; throw new Error('The operation was aborted'); };
    await assert.rejects(() => sender.sendMessageToProvider('claude', 'hi'));
    assert.equal(calls, 2, 'abort must be classified transient and retried');
});

test('sendMessageToProvider: sends to the SAME base provider run strictly one-at-a-time', async () => {
    let active = 0;
    let maxActive = 0;
    sendImpl = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(40);
        active -= 1;
        return 'ok';
    };

    await Promise.all([
        sender.sendMessageToProvider('gemini', 'a'),
        sender.sendMessageToProvider('gemini:3.5-flash', 'b'),
    ]);
    assert.equal(maxActive, 1, 'same-tab requests must be serialized to avoid collision');
});

test('sendMessageToProvider: sends to DIFFERENT providers run in parallel', async () => {
    let active = 0;
    let maxActive = 0;
    sendImpl = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(40);
        active -= 1;
        return 'ok';
    };
    await Promise.all([
        sender.sendMessageToProvider('claude', 'a'),
        sender.sendMessageToProvider('perplexity', 'b'),
    ]);
    assert.equal(maxActive, 2, 'independent providers must not block each other');
});

test('sendMessageToProvider: a failing send does not wedge the queue for the next send', async () => {
    sendImpl = async () => { throw new Error('Not logged in'); };
    await assert.rejects(() => sender.sendMessageToProvider('gemini', 'a'));
    sendImpl = async () => 'recovered';
    const r = await sender.sendMessageToProvider('gemini', 'b');
    assert.deepEqual(r, { response: 'recovered' });
});
