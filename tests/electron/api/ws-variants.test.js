// Proxima — WebSocket variant actions.
// Drives the ws server's message handler through a fake socket and a scripted
// handleMCPRequest: `variants`, `ask_variant`, and `ask_variants` (one
// `response` per seat as it finishes, then `done`).

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const Module = require('module');

// Stand-in for `ws`: a WebSocketServer that hands us its connection handler.
class FakeWSS extends EventEmitter { constructor() { super(); FakeWSS.last = this; } close(cb) { if (cb) cb(); } get clients() { return new Set(); } }
const origLoad = Module._load;
Module._load = function (req) { if (req === 'ws') return { WebSocketServer: FakeWSS, WebSocket: { OPEN: 1 } }; return origLoad.apply(this, arguments); };
const { initWebSocket } = require('../../../electron/api/ws-server.cjs');
Module._load = origLoad;

function connect(mcp) {
    initWebSocket(new EventEmitter(), mcp, () => ['chatgpt'], { isAllowedOrigin: () => true, isWsAuthorized: () => true });
    const wss = FakeWSS.last;
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.sent = [];
    ws.send = (s) => ws.sent.push(JSON.parse(s));
    ws.ping = () => { };
    ws.terminate = () => { };
    wss.emit('connection', ws, { headers: {}, socket: { remoteAddress: '127.0.0.1' }, url: '/ws' });
    return ws;
}

const send = (ws, msg) => new Promise((resolve) => { ws.emit('message', Buffer.from(JSON.stringify(msg))); setTimeout(resolve, 20); });

test('ws: variants / ask_variant / ask_variants', async () => {
    const mcp = async ({ action, data }) => {
        if (action === 'multiaiVariants') return { success: true, cli: { claude: { version: '2.1.259' } }, library: [{ id: 'opus-max' }] };
        if (action === 'multiaiAskVariant') {
            if (data.variant === 'gemini-x') return { success: false, error: 'Gemini CLI is not installed' };
            return { success: true, variant: data.variant || 'seat', provider: 'claude-cli', model: 'opus', effort: 'max', text: `answer for ${data.message}`, ms: 5 };
        }
        return { success: false, error: 'nope' };
    };
    const ws = connect(mcp);
    ws.sent.length = 0;

    await send(ws, { action: 'variants', id: 'v1', probe: true });
    let m = ws.sent.pop();
    assert.equal(m.type, 'response'); assert.equal(m.action, 'variants'); assert.equal(m.id, 'v1');
    assert.deepEqual(m.library, [{ id: 'opus-max' }]);

    ws.sent.length = 0;
    await send(ws, { action: 'ask_variant', id: 'a1', variant: 'opus:max', message: 'why?' });
    assert.deepEqual(ws.sent.map(x => x.type), ['status', 'response']);
    m = ws.sent[1];
    assert.deepEqual([m.action, m.variant, m.provider, m.model, m.effort, m.content, m.responseTimeMs], ['ask_variant', 'opus:max', 'claude-cli', 'opus', 'max', 'answer for why?', 5]);

    ws.sent.length = 0;
    await send(ws, { action: 'ask_variant', id: 'a2', variant: 'x' });
    assert.equal(ws.sent[0].type, 'error');

    ws.sent.length = 0;
    await send(ws, { action: 'ask_variants', id: 'f1', message: 'hi', variants: ['opus:max', 'gemini-x', 'sonnet:low'] });
    assert.equal(ws.sent[0].type, 'status');
    const responses = ws.sent.filter(x => x.type === 'response');
    assert.equal(responses.length, 3);
    const byIndex = responses.sort((a, b) => a.index - b.index);
    assert.deepEqual(byIndex.map(r => [r.index, r.ok]), [[0, true], [1, false], [2, true]]);
    assert.match(byIndex[1].error, /Gemini CLI is not installed/);
    assert.equal(ws.sent[ws.sent.length - 1].type, 'done');
    assert.ok(responses.every(r => typeof r.remaining === 'number'));

    ws.sent.length = 0;
    await send(ws, { action: 'ask_variants', id: 'f2', message: 'hi', variants: [] });
    assert.equal(ws.sent[0].type, 'error');
});
