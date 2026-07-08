// Proxima — JavaScript SDK Tests.
// Verifies response formatting, chat post request bodies, metadata overrides, system endpoints, and connection error/retry mechanisms.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_PATH = path.resolve(__dirname, '../../sdk/proxima.js');
const source = fs.readFileSync(SDK_PATH, 'utf8');


let currentFetch = async () => { throw new Error('fetch not set for this test'); };
const calls = [];

function loadSdk() {
    const module = { exports: {} };
    const sandbox = {
        module,
        exports: module.exports,
        fetch: (...args) => { calls.push(args); return currentFetch(...args); },
        setTimeout,
        clearTimeout,
        AbortController,
        process: { env: {} },
        console,
    };
    vm.runInNewContext(source, sandbox, { filename: 'proxima.js' });
    return module.exports;
}

const { Proxima, ProximaResponse } = loadSdk();

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test.beforeEach(() => { calls.length = 0; });


test('ProximaResponse: maps OpenAI + proxima fields into a friendly shape', () => {
    const r = new ProximaResponse({
        id: 'chatcmpl-1',
        model: 'claude',
        choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }],
        proxima: { responseTimeMs: 1500, provider: 'claude' },
    });
    assert.equal(r.text, 'hi there');
    assert.equal(r.model, 'claude');
    assert.equal(r.id, 'chatcmpl-1');
    assert.equal(r.finishReason, 'stop');
    assert.equal(r.responseTimeMs, 1500);
    assert.equal(r.provider, 'claude');
    assert.equal(String(r), 'hi there');
});

test('ProximaResponse: provider falls back to model; empty content → empty string', () => {
    const r = new ProximaResponse({ model: 'gemini', choices: [] });
    assert.equal(r.text, '');
    assert.equal(r.provider, 'gemini');
});


test('chat: POSTs to /v1/chat/completions with the default model and message', async () => {
    currentFetch = async () => jsonResponse(200, {
        model: 'auto', choices: [{ message: { content: 'ok' } }], proxima: { provider: 'auto' },
    });
    const client = new Proxima();
    const res = await client.chat('hello');
    assert.equal(res.text, 'ok');
    const [url, opts] = calls[0];
    assert.match(url, /\/v1\/chat\/completions$/);
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'auto');
    assert.equal(body.message, 'hello');
});

test('chat: model override and extra function options are forwarded in the body', async () => {
    currentFetch = async () => jsonResponse(200, { choices: [{ message: { content: 'x' } }] });
    const client = new Proxima();
    await client.chat('Hello', { model: 'gemini', function: 'translate', to: 'Hindi' });
    const body = JSON.parse(calls[0][1].body);
    assert.equal(body.model, 'gemini');
    assert.equal(body.function, 'translate');
    assert.equal(body.to, 'Hindi');
    assert.equal(body.message, 'Hello');
});

test('chat: omits the message field when message is empty (e.g. analyze url)', async () => {
    currentFetch = async () => jsonResponse(200, { choices: [{ message: { content: 'x' } }] });
    const client = new Proxima();
    await client.chat('', { function: 'analyze', url: 'https://example.com' });
    const body = JSON.parse(calls[0][1].body);
    assert.equal('message' in body, false);
    assert.equal(body.url, 'https://example.com');
});

test('chat: sets the Authorization header when an apiKey is provided', async () => {
    currentFetch = async () => jsonResponse(200, { choices: [{ message: { content: 'x' } }] });
    const client = new Proxima({ apiKey: 'sk-test-proxima' });
    await client.chat('hi');
    assert.equal(calls[0][1].headers['Authorization'], 'Bearer sk-test-proxima');
});

test('chat: a non-2xx response throws the gateway error message', async () => {
    currentFetch = async () => jsonResponse(429, { error: { message: 'rate limited' } });
    const client = new Proxima({ maxRetries: 1 });
    await assert.rejects(() => client.chat('hi'), /rate limited/);
});

test('chat: a non-2xx response with no error body falls back to "API error: <status>"', async () => {
    currentFetch = async () => jsonResponse(500, {});
    const client = new Proxima({ maxRetries: 1 });
    await assert.rejects(() => client.chat('hi'), /API error: 500/);
});


test('getModels: GETs /v1/models and returns the data array', async () => {
    currentFetch = async () => jsonResponse(200, { data: [{ id: 'claude' }, { id: 'gemini' }] });
    const client = new Proxima();
    const models = await client.getModels();
    assert.deepEqual(models.map((m) => m.id), ['claude', 'gemini']);
    assert.match(calls[0][0], /\/v1\/models$/);
});

test('getStats / getFunctions: GET their endpoints and return the raw JSON', async () => {
    currentFetch = async (url) => jsonResponse(200, { endpoint: url });
    const client = new Proxima();
    const stats = await client.getStats();
    assert.match(stats.endpoint, /\/v1\/stats$/);
    const fns = await client.getFunctions();
    assert.match(fns.endpoint, /\/v1\/functions$/);
});

test('newConversation: POSTs the provider to /v1/conversations/new', async () => {
    currentFetch = async () => jsonResponse(200, { success: true, provider: 'claude' });
    const client = new Proxima();
    const res = await client.newConversation('claude');
    assert.equal(res.success, true);
    const [url, opts] = calls[0];
    assert.match(url, /\/v1\/conversations\/new$/);
    assert.equal(JSON.parse(opts.body).provider, 'claude');
});


test('chat: a connection-refused failure surfaces a clear "cannot connect" error', async () => {
    currentFetch = async () => { const e = new Error('fetch failed'); e.code = 'ECONNREFUSED'; throw e; };
    const client = new Proxima({ maxRetries: 1 });
    await assert.rejects(() => client.chat('hi'), /Cannot connect to Proxima/);
});

test('chat: an AbortError (timeout) surfaces a clear "timed out" error', async () => {
    currentFetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const client = new Proxima({ maxRetries: 1 });
    await assert.rejects(() => client.chat('hi'), /timed out/);
});

test('chat: an unknown error is thrown immediately without retrying', async () => {
    let attempts = 0;
    currentFetch = async () => { attempts += 1; throw new Error('totally unexpected'); };
    const client = new Proxima({ maxRetries: 3 });
    await assert.rejects(() => client.chat('hi'), /totally unexpected/);
    assert.equal(attempts, 1, 'unknown errors must not be retried');
});

test('chat: retries a transient connection failure then succeeds', async () => {
    let attempts = 0;
    currentFetch = async () => {
        attempts += 1;
        if (attempts === 1) { const e = new Error('fetch failed'); e.code = 'ECONNREFUSED'; throw e; }
        return jsonResponse(200, { choices: [{ message: { content: 'recovered' } }] });
    };
    const client = new Proxima({ maxRetries: 2 });
    const res = await client.chat('hi');
    assert.equal(res.text, 'recovered');
    assert.equal(attempts, 2);
});
