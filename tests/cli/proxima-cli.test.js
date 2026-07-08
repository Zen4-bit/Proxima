// Proxima — CLI Tests.
// Verifies behavior of stdin reading, API requests, message builders, and CLI usage/failure exits.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TEST_PORT = 39217;
process.env.PROXIMA_PORT = String(TEST_PORT);
delete process.env.PROXIMA_REST_PORT; // ensure PROXIMA_PORT is the one honored

const cli = require('../../cli/proxima-cli.cjs');


function fakeStdin({ isTTY = false } = {}) {
    const e = new EventEmitter();
    e.isTTY = isTTY;
    e.setEncoding = () => {};
    return e;
}

function setStdin(fake) {
    const desc = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
    return () => Object.defineProperty(process, 'stdin', desc);
}

function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(TEST_PORT, '127.0.0.1', () => resolve(server));
    });
}

function closeServer(server) {
    return new Promise((resolve) => server.close(resolve));
}


let sharedServer = null;
let currentHandler = null;

test.before(async () => {
    sharedServer = await startServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            if (currentHandler) currentHandler(req, res);
            else { res.writeHead(200); res.end('{}'); }
        });
    });
});

test.after(async () => {
    if (sharedServer) await closeServer(sharedServer);
});


test('parseArgs: ask with model + multi-word message', () => {
    const r = cli.parseArgs(['node', 'proxima', 'ask', 'claude', 'hello', 'world']);
    assert.equal(r.command, 'ask');
    assert.deepEqual(r.positional, ['claude', 'hello', 'world']);
});

test('parseArgs: long + short flags', () => {

    const r = cli.parseArgs(['node', 'proxima', 'ask', '-m', 'gemini', 'hi', '--json']);
    assert.equal(r.flags.model, 'gemini');
    assert.equal(r.flags.json, true);
    assert.deepEqual(r.positional, ['hi']);
});

test('parseArgs: code subcommand is scoped to `code` only', () => {
    const r = cli.parseArgs(['node', 'proxima', 'code', 'review', 'x']);
    assert.equal(r.subcommand, 'review');
    // "explain" as ordinary prompt content must NOT be swallowed as a subcommand.
    const r2 = cli.parseArgs(['node', 'proxima', 'ask', 'claude', 'explain', 'recursion']);
    assert.equal(r2.subcommand, null);
    assert.ok(r2.positional.includes('explain'));
});

test('parseArgs: rawCommand preserves original case for quick-ask', () => {
    const r = cli.parseArgs(['node', 'proxima', 'Tell', 'me']);
    assert.equal(r.command, 'tell');
    assert.equal(r.rawCommand, 'Tell');
});


test('buildMessage: stdin-only becomes a "Help me with this" prompt', () => {
    const m = cli.buildMessage('', 'piped data', null);
    assert.match(m, /Help me with this/);
    assert.match(m, /piped data/);
});

test('buildMessage: message + stdin appends piped context block', () => {
    const m = cli.buildMessage('do x', 'ctx', null);
    assert.match(m, /do x/);
    assert.match(m, /Piped Context/);
    assert.match(m, /ctx/);
});

test('buildMessage: bare --file (boolean true) is ignored, never throws', () => {
    const m = cli.buildMessage('hi', '', true);
    assert.equal(m, 'hi');
});

test('isBinaryOrMultimodal: type-safe + extension detection', () => {
    assert.equal(cli.isBinaryOrMultimodal('shot.png'), true);
    assert.equal(cli.isBinaryOrMultimodal('notes.txt'), false);
    assert.equal(cli.isBinaryOrMultimodal(true), false);
    assert.equal(cli.isBinaryOrMultimodal(null), false);
});


test('readFileContext: reads text file into a fenced block', () => {
    const f = path.join(os.tmpdir(), `cli-rfc-${Date.now()}.txt`);
    fs.writeFileSync(f, 'hello content', 'utf8');
    try {
        const out = cli.readFileContext(f);
        assert.match(out, /--- File:/);
        assert.match(out, /hello content/);
    } finally {
        fs.rmSync(f, { force: true });
    }
});

test('readFileContext: missing file returns null', () => {
    assert.equal(cli.readFileContext(path.join(os.tmpdir(), `nope-${Date.now()}`)), null);
});


test('readStdin: TTY resolves empty immediately', async () => {
    const restore = setStdin(fakeStdin({ isTTY: true }));
    try {
        assert.equal(await cli.readStdin(), '');
    } finally {
        restore();
    }
});

test('readStdin: no data → resolves empty without hanging', async () => {
    const restore = setStdin(fakeStdin());
    try {
        assert.equal(await cli.readStdin(), '');
    } finally {
        restore();
    }
});

test('readStdin: slow chunk past 500ms is NOT truncated', async () => {

    const fake = fakeStdin();
    const restore = setStdin(fake);
    try {
        const p = cli.readStdin();
        fake.emit('data', 'PART1 ');
        setTimeout(() => fake.emit('data', 'PART2'), 600);
        setTimeout(() => fake.emit('end'), 660);
        assert.equal(await p, 'PART1 PART2');
    } finally {
        restore();
    }
});


test('apiRequest: resolves parsed body on 200', async () => {
    currentHandler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    };
    const { status, data } = await cli.apiRequest('GET', '/v1/models');
    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });
});

test('apiRequest: rejects on 5xx and includes gateway error detail', async () => {
    currentHandler = (req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'boom' } }));
    };
    await assert.rejects(
        () => cli.apiRequest('POST', '/v1/chat/completions', { a: 1 }),
        /HTTP 500.*boom/,
    );
});

test('apiRequest: rejects on 4xx/5xx even with an empty body', async () => {
    currentHandler = (req, res) => {
        res.writeHead(502);
        res.end();
    };
    await assert.rejects(() => cli.apiRequest('GET', '/x'), /HTTP 502/);
});


test('fail(): sets process.exitCode = 1', () => {
    const prev = process.exitCode;
    const origErr = console.error;
    process.exitCode = 0;
    console.error = () => {};
    try {
        cli.fail({ stop() {} }, new Error('nope'));
        assert.equal(process.exitCode, 1);
    } finally {
        console.error = origErr;
        process.exitCode = prev;
    }
});

test('usageError(): sets process.exitCode = 1', () => {
    const prev = process.exitCode;
    const origErr = console.error;
    process.exitCode = 0;
    console.error = () => {};
    try {
        cli.usageError('Usage: proxima ask [model] "message"');
        assert.equal(process.exitCode, 1);
    } finally {
        console.error = origErr;
        process.exitCode = prev;
    }
});
