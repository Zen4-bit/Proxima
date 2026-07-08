// Proxima — MCP Helpers Tests.
// Verifies enabled provider config lookups, hub tokens/ports, file reference loaders, and toolResponse/toolError formatters.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    getEnabledProviders, getByokStorePath, isProviderEnabled,
    getAgentHubToken, getAgentHubPort, getFileReferenceEnabled,
    readFileContents, buildMessageWithFiles, toolResponse, toolError, checkDisabled,
} from '../../src/mcp/helpers.js';


function platformCfg(root) {
    if (process.platform === 'win32') return { envVar: 'APPDATA', dir: path.join(root, 'proxima') };
    if (process.platform === 'darwin') return { envVar: 'HOME', dir: path.join(root, 'Library', 'Application Support', 'proxima') };
    return { envVar: 'HOME', dir: path.join(root, '.config', 'proxima') };
}

let root;
let cfg;
let savedEnv;
const tmpRoots = [];

test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-helpers-'));
    tmpRoots.push(root);
    cfg = platformCfg(root);
    savedEnv = process.env[cfg.envVar];
    process.env[cfg.envVar] = root;
    fs.mkdirSync(cfg.dir, { recursive: true });
});

test.afterEach(() => {
    if (savedEnv === undefined) delete process.env[cfg.envVar];
    else process.env[cfg.envVar] = savedEnv;
});

test.after(() => {
    for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function write(name, obj) {
    fs.writeFileSync(path.join(cfg.dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}


test('getEnabledProviders: returns the 4 core providers by default when no config exists', () => {
    const set = getEnabledProviders();
    assert.deepEqual([...set].sort(), ['chatgpt', 'claude', 'gemini', 'perplexity']);
});

test('getEnabledProviders: session mode reads enabled-providers.json', () => {
    write('enabled-providers.json', { enabled: ['claude', 'gemini'] });
    assert.deepEqual([...getEnabledProviders()].sort(), ['claude', 'gemini']);
});

test('getEnabledProviders: BYOK mode (enabled + keyed) overrides session list', () => {
    write('enabled-providers.json', { enabled: ['claude'] });
    write('byok.json', { _meta: { enabled: true }, groq: { key: 'k1' }, mistral: { key: 'k2' } });
    assert.deepEqual([...getEnabledProviders()].sort(), ['groq', 'mistral']);
});

test('getEnabledProviders: BYOK enabled but with NO keyed providers falls back to session', () => {
    write('enabled-providers.json', { enabled: ['perplexity'] });
    write('byok.json', { _meta: { enabled: true } });
    assert.deepEqual([...getEnabledProviders()], ['perplexity']);
});

test('isProviderEnabled: reflects the enabled set', () => {
    write('enabled-providers.json', { enabled: ['claude'] });
    assert.equal(isProviderEnabled('claude'), true);
    assert.equal(isProviderEnabled('chatgpt'), false);
});


test('getAgentHubToken: returns the token when the file is valid, else null', () => {
    assert.equal(getAgentHubToken(), null);
    write('ipc-token.json', { token: 'abc123' });
    assert.equal(getAgentHubToken(), 'abc123');
    write('ipc-token.json', { token: '' });
    assert.equal(getAgentHubToken(), null, 'empty token is treated as absent');
});

test('getAgentHubPort: returns a valid port, null for invalid/out-of-range', () => {
    assert.equal(getAgentHubPort(), null);
    write('ipc-port.json', { port: 19233 });
    assert.equal(getAgentHubPort(), 19233);
    write('ipc-port.json', { port: 99999 });
    assert.equal(getAgentHubPort(), null, 'ports > 65535 are rejected');
});

test('getByokStorePath: points at proxima/byok.json under the OS config dir', () => {
    const p = getByokStorePath();
    assert.match(p, /byok\.json$/);
    assert.ok(p.includes('proxima'));
});


test('getFileReferenceEnabled: default true; false only when explicitly disabled', () => {
    assert.equal(getFileReferenceEnabled(), true);
    write('settings.json', { fileReferenceEnabled: false });
    assert.equal(getFileReferenceEnabled(), false);
    write('settings.json', { fileReferenceEnabled: true });
    assert.equal(getFileReferenceEnabled(), true);
});

test('readFileContents: formats a code file as a fenced block with a File header', () => {
    const f = path.join(root, 'sample.js');
    fs.writeFileSync(f, 'const x = 1;\n');
    const out = readFileContents([f]);
    assert.match(out, /```js/);
    assert.match(out, /\/\/ File: sample\.js/);
    assert.match(out, /const x = 1;/);
});

test('readFileContents: honors the line-range suffix path:start-end', () => {
    const f = path.join(root, 'multi.txt');
    fs.writeFileSync(f, 'L1\nL2\nL3\nL4\nL5\n');
    const out = readFileContents([`${f}:2-3`]);
    assert.match(out, /lines 2-3 of 6/);
    assert.match(out, /L2\nL3/);
    assert.ok(!out.includes('L1'));
});

test('readFileContents: reports missing files and skips binary extensions', () => {
    const missing = path.join(root, 'nope.js');
    assert.match(readFileContents([missing]), /\[File not found:/);

    const img = path.join(root, 'pic.png');
    fs.writeFileSync(img, 'binary');
    assert.equal(readFileContents([img]), '');
});

test('readFileContents: returns empty string when file reference is disabled', () => {
    write('settings.json', { fileReferenceEnabled: false });
    const f = path.join(root, 'a.js');
    fs.writeFileSync(f, 'x');
    assert.equal(readFileContents([f]), '');
});

test('buildMessageWithFiles: prepends file content, or returns the message unchanged when none', () => {
    assert.equal(buildMessageWithFiles('hi', []), 'hi');
    const f = path.join(root, 'a.md');
    fs.writeFileSync(f, 'notes');
    const out = buildMessageWithFiles('question', [f]);
    assert.ok(out.endsWith('question'));
    assert.match(out, /notes/);
});


test('toolResponse: wraps a string directly and an object as pretty JSON', () => {
    assert.deepEqual(toolResponse('hello'), { content: [{ type: 'text', text: 'hello' }] });
    const obj = toolResponse({ a: 1 });
    assert.equal(obj.content[0].text, JSON.stringify({ a: 1 }, null, 2));
});

test('toolError: sets isError and prefixes the message', () => {
    const r = toolError(new Error('boom'));
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'Error: boom');
    assert.equal(toolError('plain string').content[0].text, 'Error: plain string');
});

test('checkDisabled: returns a response when disabled, null when enabled', () => {
    write('enabled-providers.json', { enabled: ['claude'] });
    assert.equal(checkDisabled('claude'), null);
    const disabled = checkDisabled('chatgpt');
    assert.match(disabled.content[0].text, /disabled/i);
});
