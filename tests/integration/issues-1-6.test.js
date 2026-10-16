import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const pythonEnv = require('../../electron/python-env.cjs');
const restApi = require('../../electron/api/rest-api.cjs');
const {
    getPythonExecutable,
    waitForAgentReadiness,
    getRestPortFilePath,
    getUserDataPath,
    isAllowedOrigin,
    getApprovedOrigins,
} = restApi;

const routesPkg = require('../../electron/api/routes.cjs');
const { createRouteHandler } = routesPkg;

import { IPCClient } from '../../src/mcp/ipc-bridge.js';
const wsServer = require('../../electron/api/ws-server.cjs');
const { initWebSocket, closeWebSocket } = wsServer;
const cliModule = require('../../cli/proxima-cli.cjs');
const { Proxima } = require('../../sdk/proxima.js');

test('Issue 1: isInterpreterUsable rejects nonexistent or invalid executables', () => {
    assert.equal(pythonEnv.isInterpreterUsable('nonexistent_python_binary_xyz', false), false);
    assert.equal(pythonEnv.isInterpreterUsable(null, false), false);
    assert.equal(pythonEnv.isInterpreterUsable('', false), false);
});

test('Issue 1: isInterpreterUsable with requireAgent rejects interpreters missing proxima_agent', () => {
    const systemPy = process.platform === 'win32' ? 'python' : 'python3';
    const hasAgent = pythonEnv.isInterpreterUsable(systemPy, true);
    assert.equal(hasAgent, false, 'System Python without proxima_agent must not be treated as usable agent runtime');
});

test('Issue 1: resolveInterpreter rejects broken virtual environments', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-test-venv-'));
    try {
        const fakeBinDir = process.platform === 'win32' ? path.join(tmpDir, 'Scripts') : path.join(tmpDir, 'bin');
        fs.mkdirSync(fakeBinDir, { recursive: true });
        const fakePy = path.join(fakeBinDir, process.platform === 'win32' ? 'python.exe' : 'python');
        fs.writeFileSync(fakePy, 'corrupt binary content');

        const prevCustom = process.env.PROXIMA_PYTHON;
        process.env.PROXIMA_PYTHON = fakePy;
        try {
            const resolved = pythonEnv.resolveInterpreter();
            assert.notEqual(resolved, fakePy, 'resolveInterpreter must not return corrupt PROXIMA_PYTHON');
        } finally {
            if (prevCustom) process.env.PROXIMA_PYTHON = prevCustom;
            else delete process.env.PROXIMA_PYTHON;
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Issue 1: waitForAgentReadiness handles early child exit and timeouts correctly', async () => {
    const failingChild = spawn(process.execPath, ['-e', 'process.exit(42)']);
    await assert.rejects(
        () => waitForAgentReadiness(failingChild, 3000, 59999),
        /exited early with code 42/
    );

    const stalledChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    try {
        await assert.rejects(
            () => waitForAgentReadiness(stalledChild, 400, 59998),
            /timed out/
        );
    } finally {
        stalledChild.kill('SIGKILL');
    }
});

test('Issue 2: Port fallback results in exactly one upgrade listener and successful WS handshake', async () => {
    const blockerServer = http.createServer();
    await new Promise((resolve) => blockerServer.listen(0, '127.0.0.1', resolve));
    const occupiedPort = blockerServer.address().port;

    const testServer = http.createServer();
    let onListeningCount = 0;
    const MAX_PORT_ATTEMPTS = 5;
    let portAttempt = 0;

    const onListening = () => {
        onListeningCount++;
        initWebSocket(testServer, async () => ({}), () => ({}));
    };

    testServer.once('listening', onListening);

    await new Promise((resolve, reject) => {
        testServer.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                portAttempt++;
                if (portAttempt <= MAX_PORT_ATTEMPTS) {
                    testServer.listen(occupiedPort + portAttempt, '127.0.0.1');
                } else {
                    reject(new Error('Exceeded port attempts'));
                }
            } else {
                reject(err);
            }
        });
        testServer.once('listening', resolve);
        testServer.listen(occupiedPort, '127.0.0.1');
    });

    try {
        const activePort = testServer.address().port;
        assert.equal(onListeningCount, 1, 'onListening must be invoked exactly once');
        assert.equal(testServer.listenerCount('upgrade'), 1, 'Exactly one upgrade listener must be attached');

        const ws = new WebSocket(`ws://127.0.0.1:${activePort}/ws`);
        const connectedMsg = await new Promise((resolve, reject) => {
            ws.on('message', (raw) => {
                const data = JSON.parse(raw.toString());
                if (data.type === 'connected') resolve(data);
            });
            ws.on('error', reject);
        });

        assert.equal(connectedMsg.type, 'connected');
        ws.close();

        closeWebSocket();
        assert.equal(testServer.listenerCount('upgrade'), 0, 'closeWebSocket must remove upgrade listener');
    } finally {
        closeWebSocket();
        await new Promise((resolve) => testServer.close(resolve));
        await new Promise((resolve) => blockerServer.close(resolve));
    }
});

test('Issue 3: rest-port.json is discovered consistently with proper env var precedence', () => {
    const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-rest-discovery-'));
    const testPortFile = path.join(testUserData, 'rest-port.json');

    const prevAppdata = process.env.APPDATA;
    const prevHome = process.env.HOME;
    const prevRestPort = process.env.PROXIMA_REST_PORT;
    const prevPort = process.env.PROXIMA_PORT;

    try {
        delete process.env.PROXIMA_REST_PORT;
        delete process.env.PROXIMA_PORT;

        if (process.platform === 'win32') {
            process.env.APPDATA = path.dirname(testUserData);
            const proximaDir = path.join(process.env.APPDATA, 'proxima');
            fs.mkdirSync(proximaDir, { recursive: true });
            fs.writeFileSync(path.join(proximaDir, 'rest-port.json'), JSON.stringify({ port: 3888, pid: process.pid }));
        }

        if (process.platform === 'win32') {
            const discoveredCli = cliModule.resolveRestPort();
            assert.equal(discoveredCli, 3888);
            assert.equal(cliModule.getApiBase(), 'http://127.0.0.1:3888');
        }

        process.env.PROXIMA_REST_PORT = '4555';
        assert.equal(cliModule.resolveRestPort(), 4555);
        assert.equal(cliModule.getApiBase(), 'http://127.0.0.1:4555');

        delete process.env.PROXIMA_REST_PORT;
        if (process.platform === 'win32') {
            const proximaDir = path.join(process.env.APPDATA, 'proxima');
            fs.writeFileSync(path.join(proximaDir, 'rest-port.json'), '{ invalid json content ');
            assert.equal(cliModule.resolveRestPort(), 3210);
        }
    } finally {
        if (prevAppdata) process.env.APPDATA = prevAppdata; else delete process.env.APPDATA;
        if (prevHome) process.env.HOME = prevHome; else delete process.env.HOME;
        if (prevRestPort) process.env.PROXIMA_REST_PORT = prevRestPort; else delete process.env.PROXIMA_REST_PORT;
        if (prevPort) process.env.PROXIMA_PORT = prevPort; else delete process.env.PROXIMA_PORT;
        fs.rmSync(testUserData, { recursive: true, force: true });
    }
});

test('Issue 4: Origin verification permits self and approved frontend origins and blocks unapproved/external', () => {
    const mockReq = (origin, serverPort = 3210) => ({
        headers: origin ? { origin } : {},
        socket: { localPort: serverPort },
    });

    assert.equal(isAllowedOrigin(mockReq(null, 3210)), true);
    assert.equal(isAllowedOrigin(mockReq('http://localhost:3210', 3210)), true);
    assert.equal(isAllowedOrigin(mockReq('http://127.0.0.1:3210', 3210)), true);
    assert.equal(isAllowedOrigin(mockReq('http://localhost:8500', 3210)), true);
    assert.equal(isAllowedOrigin(mockReq('http://127.0.0.1:8500', 3210)), true);

    const prevAllowed = process.env.PROXIMA_ALLOWED_ORIGINS;
    process.env.PROXIMA_ALLOWED_ORIGINS = 'http://localhost:3000, 3001';
    try {
        assert.equal(isAllowedOrigin(mockReq('http://localhost:3000', 3210)), true);
        assert.equal(isAllowedOrigin(mockReq('http://localhost:3001', 3210)), true);
    } finally {
        if (prevAllowed) process.env.PROXIMA_ALLOWED_ORIGINS = prevAllowed;
        else delete process.env.PROXIMA_ALLOWED_ORIGINS;
    }

    assert.equal(isAllowedOrigin(mockReq('http://localhost:9999', 3210)), false);
    assert.equal(isAllowedOrigin(mockReq('https://evil.com', 3210)), false);
    assert.equal(isAllowedOrigin(mockReq('http://localhost.attacker.com', 3210)), false);
    assert.equal(isAllowedOrigin(mockReq('http://127.0.0.1.attacker.com', 3210)), false);
    assert.equal(isAllowedOrigin(mockReq('not-a-valid-url', 3210)), false);
});

test('Issue 5: DELETE routes handle trailing slashes, url-encoding, and reject empty identifiers', async () => {
    let deletedKey = null;
    let deletedRecall = null;
    let deletedSkill = null;

    const mockRes = () => {
        const res = {
            statusCode: 200,
            headers: {},
            body: null,
            writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
            end(data) { this.body = data; },
        };
        return res;
    };

    const handle = createRouteHandler({
        API_PREFIX: '/v1',
        VERSION: '5.5.0',
        MODEL_ALIASES: {},
        sendJSON: (res, code, obj) => { res.writeHead(code, {}); res.end(JSON.stringify(obj)); },
        sendError: (res, code, msg) => { res.writeHead(code, {}); res.end(JSON.stringify({ error: msg })); },
        byok: {
            keys: {
                removeKey: (p) => { deletedKey = p; },
                isEnabled: () => true,
            },
            brain: {
                recall: {
                    remove: (k) => { deletedRecall = k; return { success: true, key: k }; },
                },
                skills: {
                    remove: (n) => { deletedSkill = n; return { success: true, name: n }; },
                },
            },
        },
    });

    deletedKey = null;
    let res = mockRes();
    await handle('DELETE', '/v1/byok/keys/openai', {}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(deletedKey, 'openai');

    deletedKey = null;
    res = mockRes();
    await handle('DELETE', '/v1/byok/keys/openai/', {}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(deletedKey, 'openai', 'Trailing slash must identify same provider "openai"');

    res = mockRes();
    await handle('DELETE', '/v1/byok/keys/', {}, res);
    assert.equal(res.statusCode, 400);

    deletedRecall = null;
    res = mockRes();
    await handle('DELETE', '/v1/brain/recall/my-fact', {}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(deletedRecall, 'my-fact');

    deletedRecall = null;
    res = mockRes();
    await handle('DELETE', '/v1/brain/recall/my-fact/', {}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(deletedRecall, 'my-fact');

    deletedRecall = null;
    res = mockRes();
    await handle('DELETE', '/v1/brain/recall/encoded%20fact/', {}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(deletedRecall, 'encoded fact');

    res = mockRes();
    await handle('DELETE', '/v1/brain/recall/', {}, res);
    assert.equal(res.statusCode, 400);

    deletedSkill = null;
    res = mockRes();
    await handle('DELETE', '/v1/brain/skills/python-helper', {}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(deletedSkill, 'python-helper');

    deletedSkill = null;
    res = mockRes();
    await handle('DELETE', '/v1/brain/skills/python-helper/', {}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(deletedSkill, 'python-helper');

    res = mockRes();
    await handle('DELETE', '/v1/brain/skills/', {}, res);
    assert.equal(res.statusCode, 400);
});

test('Issue 6: IPCClient cleans up pending requests and socket on disconnect, and reconnects on subsequent requests', async () => {
    let mockServerConnections = 0;
    let activeSocket = null;

    const mockHub = net.createServer((socket) => {
        mockServerConnections++;
        activeSocket = socket;

        socket.on('data', (data) => {
            for (const line of data.toString().split('\n')) {
                if (!line.trim()) continue;
                const req = JSON.parse(line);
                socket.write(JSON.stringify({ requestId: req.requestId, success: true, result: 'ok' }) + '\n');
            }
        });
    });

    await new Promise((resolve) => mockHub.listen(0, '127.0.0.1', resolve));
    const hubPort = mockHub.address().port;

    const client = new IPCClient(hubPort);

    try {
        const res1 = await client.send('testAction');
        assert.equal(res1.success, true);
        assert.equal(mockServerConnections, 1);
        assert.equal(client.connected, true);

        activeSocket.destroy();
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.equal(client.connected, false);
        assert.equal(client.socket, null, 'client.socket must be reset to null on socket close');
        assert.equal(client.responseBuffer, '', 'client.responseBuffer must be cleared on socket close');

        const res2 = await client.send('testAction2');
        assert.equal(res2.success, true);
        assert.equal(mockServerConnections, 2, 'Subsequent request must reconnect to the available peer');
        assert.equal(client.connected, true);
    } finally {
        client.disconnect();
        await new Promise((resolve) => mockHub.close(resolve));
    }
});

test('JavaScript SDK: imports and instantiates across ESM, CJS, and extensionless paths', async () => {
    const cjsWithExt = require('../../sdk/proxima.js');
    assert.equal(typeof cjsWithExt.Proxima, 'function', 'CommonJS require(.js) must export Proxima class');
    assert.equal(typeof cjsWithExt.ProximaResponse, 'function', 'CommonJS require(.js) must export ProximaResponse class');
    const cjsInst = new cjsWithExt.Proxima();
    assert.ok(cjsInst instanceof cjsWithExt.Proxima);

    const cjsNoExt = require('../../sdk/proxima');
    assert.equal(typeof cjsNoExt.Proxima, 'function', 'CommonJS require() without extension must export Proxima');

    const cjsDir = require('../../sdk');
    assert.equal(typeof cjsDir.Proxima, 'function', 'CommonJS require(sdk) directory must export Proxima');

    const esmJs = await import('../../sdk/proxima.js');
    assert.equal(typeof esmJs.Proxima, 'function', 'ESM import of proxima.js must provide named Proxima export');
    assert.equal(typeof esmJs.ProximaResponse, 'function', 'ESM import of proxima.js must provide named ProximaResponse export');
    assert.ok(esmJs.default, 'ESM import of proxima.js must provide default export');

    const esmMjs = await import('../../sdk/proxima.mjs');
    assert.equal(typeof esmMjs.Proxima, 'function', 'ESM import of proxima.mjs must provide named Proxima export');
    assert.ok(esmMjs.default, 'ESM import of proxima.mjs must provide default export');
});

test('/api/status: dynamically exposes the actual listening server port without guessing or hardcoding', async () => {
    const testPorts = [3210, 3211, 4899, 54321];

    for (const testPort of testPorts) {
        const handler = createRouteHandler({
            API_PREFIX: '/v1',
            VERSION: '5.5.0',
            MODEL_ALIASES: {},
            sendJSON: (res, code, data) => { res.statusCode = code; res.body = data; },
            sendError: () => {},
            getEnabled: () => ['claude', 'gemini'],
            resolveModel: () => 'auto',
            resolveModels: () => ({ mode: 'single' }),
            pickBestProvider: () => 'claude',
            extractMessage: () => '',
            queryProvider: async () => ({ text: '' }),
            queryMultiple: async () => ({ results: [] }),
            formatChatResponse: () => ({}),
            formatAllResponse: () => ({}),
            sendStreamResponse: () => {},
            sendStreamToolCallResponse: () => {},
            getFormattedStats: () => ({ uptime: '100s' }),
            handleMCPRequest: () => async () => ({ providers: { claude: true } }),
            loadApiKey: () => null,
            getDocsPage: () => '',
            getAPIKeyPage: () => '',
            getCLIDocsPage: () => '',
            getWSDocsPage: () => '',
            scrapeUrl: async () => '',
            searchDDG: async () => '',
            formatResultsMarkdown: () => '',
            buildToolCallingPrompt: () => '',
            parseToolCallResponse: () => null,
            formatToolCallResponse: () => ({}),
            byok: {},
            getBoundPort: () => testPort,
        });

        const mockRes = { headers: {} };
        await handler('GET', '/api/status', {}, mockRes);
        assert.equal(mockRes.statusCode, 200);
        assert.equal(mockRes.body.port, testPort, `Expected /api/status to return dynamically bound port ${testPort}`);
        assert.equal(mockRes.body.success, true);
    }
});

