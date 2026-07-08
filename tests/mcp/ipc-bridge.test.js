// Proxima — IPC Bridge Tests.
// Verifies IPCClient TCP round-trips, dynamic token overrides, port scans, heartbeats, idle timeouts, and AIProvider queue/caching/error mappings.

import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import { IPCClient, AIProvider } from '../../src/mcp/ipc-bridge.js';
import { RateLimitError, AuthError, TimeoutError, ProviderError } from '../../src/utils/errors.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function startProtocolServer(onRequest) {
    const server = net.createServer((sock) => {
        let buf = '';
        sock.on('data', (d) => {
            buf += d.toString();
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                if (line.trim()) onRequest(JSON.parse(line), sock);
            }
        });
        sock.on('error', () => {});
    });
    return server;
}

function listen(server, port = 0) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
}

function closeServer(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

async function freePort() {
    const s = net.createServer();
    const p = await listen(s, 0);
    await closeServer(s);
    return p;
}

// ─── IPCClient ───────────────────────────────────────
test('IPCClient.send: round-trips a request and resolves the matching reply', async () => {
    const server = startProtocolServer((req, sock) => {
        sock.write(JSON.stringify({ requestId: req.requestId, action: req.action, ok: true }) + '\n');
    });
    const port = await listen(server);
    const client = new IPCClient(port);
    try {
        const res = await client.send('ping', 'claude', { x: 1 });
        assert.equal(res.ok, true);
        assert.equal(res.action, 'ping');
    } finally {
        client.disconnect();
        await closeServer(server);
    }
});

test('IPCClient.send: attaches a static token to the request', async () => {
    let seenToken;
    const server = startProtocolServer((req, sock) => {
        seenToken = req.token;
        sock.write(JSON.stringify({ requestId: req.requestId, ok: true }) + '\n');
    });
    const port = await listen(server);
    const client = new IPCClient(port, 'secret-token');
    try {
        await client.send('x');
        assert.equal(seenToken, 'secret-token');
    } finally {
        client.disconnect();
        await closeServer(server);
    }
});

test('IPCClient: a function token source is re-read on connect (rotatable secret)', async () => {
    let seenToken;
    const server = startProtocolServer((req, sock) => {
        seenToken = req.token;
        sock.write(JSON.stringify({ requestId: req.requestId, ok: true }) + '\n');
    });
    const port = await listen(server);
    const client = new IPCClient(port, () => 'dynamic-token');
    try {
        await client.send('x');
        assert.equal(seenToken, 'dynamic-token');
    } finally {
        client.disconnect();
        await closeServer(server);
    }
});

test('IPCClient: scans upward and connects when the base port is refused', async () => {

    const server = startProtocolServer((req, sock) => {
        sock.write(JSON.stringify({ requestId: req.requestId, ok: true }) + '\n');
    });
    const port = await listen(server);
    const client = new IPCClient(port - 1);
    try {
        const res = await client.send('x');
        assert.equal(res.ok, true);
        assert.equal(client.port, port, 'client should settle on the discovered port');
    } finally {
        client.disconnect();
        await closeServer(server);
    }
});

test('IPCClient.connect: throws a clear error when nothing is listening', async () => {
    const port = await freePort(); // guaranteed free
    const client = new IPCClient(port);
    await assert.rejects(() => client.send('x'), /connect|running|Agent Hub/i);
});

test('IPCClient: a heartbeat does NOT resolve the request; the real reply does', async () => {
    const server = startProtocolServer((req, sock) => {

        sock.write(JSON.stringify({ type: 'heartbeat', requestId: req.requestId }) + '\n');
        setTimeout(() => {
            sock.write(JSON.stringify({ requestId: req.requestId, done: true }) + '\n');
        }, 40);
    });
    const port = await listen(server);
    const client = new IPCClient(port);
    try {
        const res = await client.send('slow');
        assert.equal(res.done, true);
        assert.equal(res.type, undefined, 'must not resolve with the heartbeat frame');
    } finally {
        client.disconnect();
        await closeServer(server);
    }
});

test('IPCClient.send: rejects when the idle watchdog fires (no activity)', async () => {
    const server = startProtocolServer(() => {});
    const port = await listen(server);
    const client = new IPCClient(port);
    const prev = process.env.AGENT_HUB_IDLE_TIMEOUT_MS;
    process.env.AGENT_HUB_IDLE_TIMEOUT_MS = '150';
    try {
        await assert.rejects(() => client.send('x'), /timed out|no activity|heartbeat/i);
    } finally {
        if (prev === undefined) delete process.env.AGENT_HUB_IDLE_TIMEOUT_MS;
        else process.env.AGENT_HUB_IDLE_TIMEOUT_MS = prev;
        client.disconnect();
        await closeServer(server);
    }
});

test('IPCClient: a disconnect rejects in-flight pending requests', async () => {
    const server = startProtocolServer(() => {});
    const port = await listen(server);
    const client = new IPCClient(port);
    const prev = process.env.AGENT_HUB_IDLE_TIMEOUT_MS;
    process.env.AGENT_HUB_IDLE_TIMEOUT_MS = '5000';
    try {
        const pending = client.send('x');
        await delay(50);
        client.disconnect();
        await assert.rejects(() => pending, /lost/i);
    } finally {
        if (prev === undefined) delete process.env.AGENT_HUB_IDLE_TIMEOUT_MS;
        else process.env.AGENT_HUB_IDLE_TIMEOUT_MS = prev;
        await closeServer(server);
    }
});

test('IPCClient: after disconnect, send() and connect() refuse to re-open a socket', async () => {

    const server = startProtocolServer((req, sock) => {
        sock.write(JSON.stringify({ requestId: req.requestId, ok: true }) + '\n');
    });
    const port = await listen(server);
    const client = new IPCClient(port);
    try {
        await client.send('x');
        client.disconnect();
        assert.equal(client.connected, false);
        await assert.rejects(() => client.send('y'), /shutting down/i);
        await assert.rejects(() => client.connect(), /shutting down/i);
    } finally {
        await closeServer(server);
    }
});

test('IPCClient.disconnect: safe (no throw) when never connected, and rejects pending', async () => {
    const client = new IPCClient(await freePort());

    assert.doesNotThrow(() => client.disconnect());
    assert.equal(client.connected, false);
});


function mockIpc(sendImpl) {
    return { send: (...args) => sendImpl(...args) };
}

test('AIProvider.ensureInitialized: throws when the provider is disabled', async () => {
    const p = new AIProvider('claude', mockIpc(async () => ({})), () => false);
    await assert.rejects(() => p.ensureInitialized(), /disabled/i);
});

test('AIProvider.ensureInitialized: initializes when enabled', async () => {
    const actions = [];
    const p = new AIProvider('claude', mockIpc(async (action) => { actions.push(action); return {}; }), () => true);
    await p.ensureInitialized();
    assert.ok(actions.includes('initProvider'));
});

test('AIProvider.isLoggedIn: returns the gateway loggedIn flag', async () => {
    const p = new AIProvider('claude', mockIpc(async () => ({ loggedIn: true })), () => true);
    assert.equal(await p.isLoggedIn(), true);
});

test('AIProvider.chat: returns the response and caches it (no second network call)', async () => {
    let sendMessageCalls = 0;
    const ipc = mockIpc(async (action) => {
        if (action === 'initProvider') return {};
        if (action === 'sendMessage') { sendMessageCalls += 1; return { response: 'hello' }; }
        return {};
    });
    const p = new AIProvider('claude', ipc, () => true);
    assert.equal(await p.chat('q'), 'hello');
    assert.equal(await p.chat('q'), 'hello');
    assert.equal(sendMessageCalls, 1, 'identical query must hit the cache the second time');
});

test('AIProvider.chat: cache key includes filePath (same text + different file → new call)', async () => {
    let sendMessageCalls = 0;
    const ipc = mockIpc(async (action) => {
        if (action === 'initProvider') return {};
        if (action === 'sendMessage') { sendMessageCalls += 1; return { response: 'r' }; }
        return {};
    });
    const p = new AIProvider('claude', ipc, () => true);
    await p.chat('describe');
    await p.chat('describe', true, 'photo.png');
    assert.equal(sendMessageCalls, 2, 'a different attached file must not reuse the cached answer');
});

test('AIProvider.chat: gateway {success:false,error:"rate limit"} throws a RateLimitError', async () => {
    const ipc = mockIpc(async (action) => (action === 'initProvider' ? {} : { success: false, error: 'rate limit exceeded' }));
    const p = new AIProvider('claude', ipc, () => true);
    await assert.rejects(() => p.chat('q', false), (e) => e instanceof RateLimitError && e.retryable === true);
});

test('AIProvider.chat: an auth failure throws a non-retryable AuthError', async () => {
    const ipc = mockIpc(async (action) => (action === 'initProvider' ? {} : { success: false, error: 'session expired' }));
    const p = new AIProvider('claude', ipc, () => true);
    await assert.rejects(() => p.chat('q', false), (e) => e instanceof AuthError && e.retryable === false);
});

test('AIProvider.chat: an empty success throws a non-retryable EMPTY_RESPONSE ProviderError', async () => {
    const ipc = mockIpc(async (action) => (action === 'initProvider' ? {} : { success: true }));
    const p = new AIProvider('claude', ipc, () => true);
    await assert.rejects(() => p.chat('q', false), (e) => e instanceof ProviderError && e.code === 'EMPTY_RESPONSE' && e.retryable === false);
});

test('AIProvider._classifyError: maps timeout to TimeoutError and unknown to a plain Error', async () => {
    const p = new AIProvider('claude', mockIpc(async () => ({})), () => true);
    assert.ok(p._classifyError('request timed out') instanceof TimeoutError);
    const unknown = p._classifyError('some weird failure');
    assert.equal(unknown instanceof ProviderError, false);
    assert.equal(unknown.message, 'some weird failure');
});

test('AIProvider.newConversation: sends a newConversation action for the provider', async () => {
    const calls = [];
    const ipc = mockIpc(async (action, name) => { calls.push([action, name]); return {}; });
    const p = new AIProvider('gemini', ipc, () => true);
    await p.newConversation();
    assert.deepEqual(calls, [['newConversation', 'gemini']]);
});

test('AIProvider.chat: concurrent requests are processed sequentially per provider', async () => {
    let active = 0;
    let maxActive = 0;
    const ipc = mockIpc(async (action) => {
        if (action === 'initProvider') return {};
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(40);
        active -= 1;
        return { response: 'ok' };
    });
    const p = new AIProvider('claude', ipc, () => true);
    await Promise.all([p.chat('a', false), p.chat('b', false), p.chat('c', false)]);
    assert.equal(maxActive, 1, 'provider requests must be queued one-at-a-time');
});
