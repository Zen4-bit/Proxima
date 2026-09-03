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

test('sendMessageToProvider: options.shouldRun skips a queued send without touching the provider', async () => {
    let calls = 0;
    sendImpl = async () => { calls += 1; await delay(30); return 'ok'; };
    const first = sender.sendMessageToProvider('gemini', 'one', null, null, 's1');
    let cancelled = false;
    const second = sender.sendMessageToProvider('gemini', 'two', null, null, 's2', { shouldRun: () => !cancelled });
    cancelled = true;
    await first;
    await assert.rejects(second, /Cancelled by user/);
    assert.equal(calls, 1, 'the cancelled send never reached the provider');
});

test('abortActive: aborts only the in-flight send with the matching conversation id', async () => {
    const aborted = [];
    providerAPI.abortActive = async (p) => { aborted.push(p); return true; };
    let release;
    sendImpl = () => new Promise((r) => { release = r; });
    const p = sender.sendMessageToProvider('claude', 'slow', null, null, 'conv-A');
    await delay(5);
    assert.equal(await sender.abortActive('claude', 'conv-B'), false, 'a different conversation is left alone');
    assert.equal(await sender.abortActive('claude', 'conv-A'), true);
    assert.deepEqual(aborted, ['claude']);
    release('done');
    await p;
    assert.equal(await sender.abortActive('claude', null), false, 'nothing active after completion');
    delete providerAPI.abortActive;
});

test('sendMessageToProvider: "Cancelled by user" from the engine is terminal (not retried)', async () => {
    let calls = 0;
    sendImpl = async () => { calls += 1; throw new Error('Cancelled by user'); };
    await assert.rejects(() => sender.sendMessageToProvider('chatgpt', 'hi'), /Cancelled by user/);
    assert.equal(calls, 1);
});
