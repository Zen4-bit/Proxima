// Proxima — BYOK HTTP Transport Tests.
// Verifies postJson/getJson response accumulation, size capping, JSON parsing, error surfacing, and timeouts.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { postJson, getJson } = require('../../electron/api/byok/providers/_http.cjs');

let server;
let port;
let handler = null;
const realHttpsRequest = https.request;

test.before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => handler(req, res, body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    https.request = function (options, cb) {
        return http.request({ ...options, hostname: '127.0.0.1', port }, cb);
    };
});

test.after(async () => {
    https.request = realHttpsRequest;
    await new Promise((resolve) => server.close(resolve));
});

const ENDPOINT = 'https://example.test/v1/chat';

test('postJson resolves parsed JSON on 200', async () => {
    handler = (req, res, body) => {
        assert.equal(JSON.parse(body).hello, 'world');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, n: 42 }));
    };
    const out = await postJson(ENDPOINT, { 'Content-Type': 'application/json' }, JSON.stringify({ hello: 'world' }), 'Test API');
    assert.equal(out.ok, true);
    assert.equal(out.n, 42);
});

test('postJson rejects with statusCode + provider message on 4xx', async () => {
    handler = (req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    };
    await assert.rejects(
        () => postJson(ENDPOINT, {}, '{}', 'Test API'),
        (err) => {
            assert.equal(err.statusCode, 401);
            assert.match(err.message, /invalid api key/);
            return true;
        }
    );
});

test('postJson extracts string-form error and sets 5xx statusCode', async () => {
    handler = (req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'service down' }));
    };
    await assert.rejects(
        () => postJson(ENDPOINT, {}, '{}', 'Test API'),
        (err) => {
            assert.equal(err.statusCode, 503);
            assert.match(err.message, /service down/);
            return true;
        }
    );
});

test('postJson rejects on invalid JSON body (carries statusCode)', async () => {
    handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>not json</html>');
    };
    await assert.rejects(
        () => postJson(ENDPOINT, {}, '{}', 'Test API'),
        (err) => {
            assert.equal(err.statusCode, 200);
            assert.match(err.message, /invalid JSON/i);
            return true;
        }
    );
});

test('postJson enforces the response-size cap', async () => {
    handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ big: 'x'.repeat(50 * 1024) }));
    };
    await assert.rejects(
        () => postJson(ENDPOINT, {}, '{}', 'Test API', { maxBytes: 1024 }),
        (err) => {
            assert.match(err.message, /exceeded|limit/i);
            return true;
        }
    );
});

test('postJson rejects on timeout', async () => {
    handler = (req, res) => {
        setTimeout(() => { try { res.end('{}'); } catch {} }, 500);
    };
    await assert.rejects(
        () => postJson(ENDPOINT, {}, '{}', 'Test API', { timeoutMs: 80 }),
        (err) => {
            assert.match(err.message, /timed out/i);
            assert.equal(err.statusCode, undefined);
            return true;
        }
    );
});

test('getJson resolves parsed JSON on 200 (GET, no body)', async () => {
    handler = (req, res) => {
        assert.equal(req.method, 'GET');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
    };
    const out = await getJson(ENDPOINT, { Authorization: 'Bearer x' }, 'Models API');
    assert.equal(out.data.length, 2);
    assert.equal(out.data[0].id, 'model-a');
});

test('getJson rejects with statusCode on 4xx', async () => {
    handler = (req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'forbidden' } }));
    };
    await assert.rejects(
        () => getJson(ENDPOINT, {}, 'Models API'),
        (err) => {
            assert.equal(err.statusCode, 403);
            assert.match(err.message, /forbidden/);
            return true;
        }
    );
});
