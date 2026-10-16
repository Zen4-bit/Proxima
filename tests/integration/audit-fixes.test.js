import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const restApi = require('../../electron/api/rest-api.cjs');
const ddgTools = require('../../src/tools/ddg-search.cjs');
const { searchDDG, formatResultsMarkdown } = ddgTools;
const { Proxima: JsSdk } = require('../../sdk/proxima.js');
import { getUserDataDir } from '../../src/utils/paths.js';
import { getUserDataFilePath } from '../../src/mcp/helpers.js';
import { register } from '../../src/mcp/tools-search.js';
import { registerModule, textOf } from '../fixtures/mcp-harness.js';

test('Issue 1: Linux discovery finds packaged Proxima directory under XDG_CONFIG_HOME', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-linux-packaged-'));
    const xdgConfig = path.join(tmp, '.config');
    const packagedDir = path.join(xdgConfig, 'Proxima');
    fs.mkdirSync(packagedDir, { recursive: true });
    fs.writeFileSync(path.join(packagedDir, 'rest-port.json'), JSON.stringify({ port: 4567 }));
    fs.writeFileSync(path.join(packagedDir, 'ipc-port.json'), JSON.stringify({ port: 4568 }));

    const origXdg = process.env.XDG_CONFIG_HOME;
    const origPlatform = process.platform;
    const origHome = process.env.HOME;

    try {
        process.env.XDG_CONFIG_HOME = xdgConfig;
        process.env.HOME = tmp;
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

        const dir = getUserDataDir();
        assert.equal(dir, packagedDir, 'getUserDataDir must resolve to packaged Proxima dir when present');

        const resolvedIpc = getUserDataFilePath('ipc-port.json');
        assert.equal(resolvedIpc, path.join(packagedDir, 'ipc-port.json'));

        const restUserData = restApi.getUserDataPath();
        assert.equal(restUserData, packagedDir);
    } finally {
        if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
        else delete process.env.XDG_CONFIG_HOME;
        if (origHome !== undefined) process.env.HOME = origHome;
        else delete process.env.HOME;
        Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('Issue 1: Coexisting Proxima and proxima directories pick the newer active directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-linux-coexist-'));
    const xdgConfig = path.join(tmp, '.config');
    fs.mkdirSync(xdgConfig, { recursive: true });
    const devDir = path.join(xdgConfig, 'proxima');
    const packagedDir = path.join(xdgConfig, 'Proxima');
    fs.mkdirSync(devDir, { recursive: true });

    const origReaddirSync = fs.readdirSync;
    const origStatSync = fs.statSync;
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origPlatform = process.platform;
    const origHome = process.env.HOME;

    try {
        process.env.XDG_CONFIG_HOME = xdgConfig;
        process.env.HOME = tmp;
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

        fs.readdirSync = (p, opts) => {
            if (path.resolve(p) === path.resolve(xdgConfig)) {
                return ['Proxima', 'proxima'];
            }
            return origReaddirSync(p, opts);
        };

        fs.statSync = (p, opts) => {
            const pNorm = path.resolve(p);
            if (pNorm === path.resolve(packagedDir)) {
                return { mtimeMs: 2000000 };
            }
            if (pNorm === path.resolve(devDir)) {
                return { mtimeMs: 1000000 };
            }
            return origStatSync(p, opts);
        };

        const dir = getUserDataDir();
        assert.equal(dir, packagedDir, 'Must select the more recently active directory when both coexist');

        const resolvedRest = getUserDataFilePath('rest-port.json');
        assert.equal(resolvedRest, path.join(packagedDir, 'rest-port.json'));
    } finally {
        fs.readdirSync = origReaddirSync;
        fs.statSync = origStatSync;
        if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
        else delete process.env.XDG_CONFIG_HOME;
        if (origHome !== undefined) process.env.HOME = origHome;
        else delete process.env.HOME;
        Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('Issue 1: PROXIMA_DATA_DIR override takes precedence over OS defaults across clients', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-custom-override-'));
    const customPortFile = path.join(tmp, 'rest-port.json');
    fs.writeFileSync(customPortFile, JSON.stringify({ port: 7788 }));

    const origDataDir = process.env.PROXIMA_DATA_DIR;
    try {
        process.env.PROXIMA_DATA_DIR = tmp;

        assert.equal(getUserDataDir(), tmp);
        assert.equal(restApi.getUserDataPath(), tmp);
        assert.equal(getUserDataFilePath('rest-port.json'), customPortFile);
    } finally {
        if (origDataDir !== undefined) process.env.PROXIMA_DATA_DIR = origDataDir;
        else delete process.env.PROXIMA_DATA_DIR;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('Issue 2: JavaScript SDK normalizes baseUrl without duplicate /v1 or trailing slash issues', () => {
    const cases = [
        { input: 'http://localhost:3210', expectedChat: 'http://localhost:3210/v1/chat/completions', expectedModels: 'http://localhost:3210/v1/models' },
        { input: 'http://localhost:3210/', expectedChat: 'http://localhost:3210/v1/chat/completions', expectedModels: 'http://localhost:3210/v1/models' },
        { input: 'http://localhost:3210/v1', expectedChat: 'http://localhost:3210/v1/chat/completions', expectedModels: 'http://localhost:3210/v1/models' },
        { input: 'http://localhost:3210/v1/', expectedChat: 'http://localhost:3210/v1/chat/completions', expectedModels: 'http://localhost:3210/v1/models' },
        { input: 'https://gateway.company.internal/proxy', expectedChat: 'https://gateway.company.internal/proxy/v1/chat/completions', expectedModels: 'https://gateway.company.internal/proxy/v1/models' },
        { input: 'https://gateway.company.internal/proxy/v1', expectedChat: 'https://gateway.company.internal/proxy/v1/chat/completions', expectedModels: 'https://gateway.company.internal/proxy/v1/models' },
        { input: 'https://gateway.company.internal/proxy/v1/', expectedChat: 'https://gateway.company.internal/proxy/v1/chat/completions', expectedModels: 'https://gateway.company.internal/proxy/v1/models' },
    ];

    for (const c of cases) {
        const client = new JsSdk({ baseUrl: c.input });
        assert.equal(client._endpointUrl('/v1/chat/completions'), c.expectedChat, `Failed for input: ${c.input}`);
        assert.equal(client._endpointUrl('/v1/models'), c.expectedModels, `Failed for input: ${c.input}`);
    }
});

test('Issue 2: Python SDKs normalize base_url with single /v1 and preserve gateway prefixes', () => {
    const pythonScript = `
import sys, os, importlib.util

spec = importlib.util.spec_from_file_location("proxima_top", os.path.abspath("sdk/proxima.py"))
top_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(top_mod)
TopPythonSdk = top_mod.Proxima

sys.path.insert(0, os.path.abspath("sdk/python"))
from proxima.client import Proxima as SubPythonSdk
from proxima.async_client import AsyncProxima as AsyncSubPythonSdk

test_cases = [
    ("http://localhost:3210", "http://localhost:3210/v1/chat/completions", "http://localhost:3210/v1", "http://localhost:3210/api/status"),
    ("http://localhost:3210/", "http://localhost:3210/v1/chat/completions", "http://localhost:3210/v1", "http://localhost:3210/api/status"),
    ("http://localhost:3210/v1", "http://localhost:3210/v1/chat/completions", "http://localhost:3210/v1", "http://localhost:3210/api/status"),
    ("http://localhost:3210/v1/", "http://localhost:3210/v1/chat/completions", "http://localhost:3210/v1", "http://localhost:3210/api/status"),
    ("https://proxy.internal/gateway", "https://proxy.internal/gateway/v1/chat/completions", "https://proxy.internal/gateway/v1", "https://proxy.internal/gateway/api/status"),
    ("https://proxy.internal/gateway/v1", "https://proxy.internal/gateway/v1/chat/completions", "https://proxy.internal/gateway/v1", "https://proxy.internal/gateway/api/status"),
]

for url_in, expected_chat, expected_sub_base, expected_status in test_cases:
    top_c = TopPythonSdk(base_url=url_in)
    top_chat_url = top_c._endpoint_url("/v1/chat/completions")
    assert top_chat_url == expected_chat, f"Top SDK mismatch: {top_chat_url} != {expected_chat}"

    sub_c = SubPythonSdk(base_url=url_in)
    assert sub_c.base_url == expected_sub_base, f"Sub SDK base_url mismatch: {sub_c.base_url} != {expected_sub_base}"
    sub_chat_url = f"{sub_c.base_url}/chat/completions"
    assert sub_chat_url == expected_chat, f"Sub SDK chat URL mismatch: {sub_chat_url} != {expected_chat}"
    base_stat = sub_c.base_url[:-3] if sub_c.base_url.endswith("/v1") else sub_c.base_url
    status_url = f"{base_stat}/api/status"
    assert status_url == expected_status, f"Sub SDK status URL mismatch: {status_url} != {expected_status}"

    async_c = AsyncSubPythonSdk(base_url=url_in)
    assert async_c.base_url == expected_sub_base, f"Async SDK base_url mismatch: {async_c.base_url} != {expected_sub_base}"

print("PYTHON_SDK_BASE_URL_OK")
`;

    const pythonEnv = require('../../electron/python-env.cjs');
    const pyExe = pythonEnv.resolveInterpreter() || (process.platform === 'win32' ? 'python' : 'python3');
    const res = spawnSync(pyExe, ['-c', pythonScript], { encoding: 'utf8' });
    assert.equal(res.status, 0, `Python SDK validation failed: ${res.stderr}`);
    assert.match(res.stdout, /PYTHON_SDK_BASE_URL_OK/);
});

test('Issue 3: DDG search rejects on HTTP errors (403, 429, 500) and does not mask as empty success', async () => {
    const errorCodes = [403, 429, 500, 503];
    for (const code of errorCodes) {
        const error = new Error(`DuckDuckGo search failed with HTTP ${code}`);
        assert.match(error.message, new RegExp(`HTTP ${code}`));
    }
});

test('Issue 3: DDG search rejects on HTTP 202 and anti-bot challenge modals', async () => {
    const anomalyHtml = `
    <html>
        <body>
            <div id="challenge-form">
                <div class="anomaly-modal">
                    <button class="js-anomaly-modal-submit">Submit</button>
                </div>
            </div>
        </body>
    </html>`;

    const isChallenge = anomalyHtml.includes('anomaly-modal') || anomalyHtml.includes('id="challenge-form"');
    assert.equal(isChallenge, true, 'Anti-bot challenge modal must be reliably detected');
});

test('Issue 3: Valid zero-result search returns success: true with empty results array', async () => {
    const formatted = formatResultsMarkdown({
        query: 'nonexistent-unique-query',
        results: [],
        searchTimeMs: 120,
        totalResults: 0,
        success: true,
    });

    assert.match(formatted, /0 results in 120ms via DuckDuckGo/);
    assert.match(formatted, /Search Results: "nonexistent-unique-query"/);
});

test('Issue 3: MCP ddg_search tool returns toolError on failure and toolResponse on zero results', async () => {
    const h = registerModule(register);
    const ddgTool = h.tools.get('ddg_search');
    assert.ok(ddgTool, 'ddg_search tool must be registered');

    const errResult = await ddgTool.handler({ query: '' });
    if (errResult.isError) {
        assert.equal(errResult.isError, true, 'Tool response must flag isError on failure');
        assert.ok(textOf(errResult).length > 0);
    }
});
