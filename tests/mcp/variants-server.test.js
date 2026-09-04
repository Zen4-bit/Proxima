// Proxima — standalone variants MCP server.
// It wires the shared tools-cli module to an in-process backend (no IPC):
// the tools register, read the library from a store file, and run the CLIs.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBackend, loadLibraryFrom, createServer, userDataDir } from '../../src/mcp/variants-server.js';
import { register } from '../../src/mcp/tools-cli.js';
import { makeHarness, textOf } from '../fixtures/mcp-harness.js';

const require = createRequire(import.meta.url);
const core = require('../../electron/ipc/multiai-core.cjs');
const { createVariants } = require('../../electron/providers/variants.cjs');

test('loadLibraryFrom: reads uiPrefs.agentLibrary from the store file, empty otherwise', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
    assert.deepEqual(loadLibraryFrom(dir), []);
    fs.mkdirSync(path.join(dir, 'multiai'));
    fs.writeFileSync(path.join(dir, 'multiai', 'chats.json'), JSON.stringify({ projects: [], uiPrefs: { agentLibrary: [{ uid: 'u1', name: 'Opus max', provider: 'claude-cli', model: 'opus', effort: 'max' }] } }));
    assert.equal(loadLibraryFrom(dir)[0].name, 'Opus max');
    assert.ok(userDataDir().length > 0);
});

test('createBackend + createServer: the three tools register and run without IPC', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
    fs.mkdirSync(path.join(dir, 'multiai'));
    fs.writeFileSync(path.join(dir, 'multiai', 'chats.json'), JSON.stringify({ projects: [], uiPrefs: { agentLibrary: [{ uid: 'u1', name: 'GPT low', provider: 'codex-cli', model: 'gpt-5.5', effort: 'low' }] } }));
    const backend = createBackend({ userData: dir });
    assert.equal(typeof backend.askVariant, 'function');
    const server = createServer(backend);
    assert.ok(server, 'server constructed');

    // Same tools, fake CLI backend, no ipcClient at all.
    const fakeCli = { availability: () => ({ claude: true, codex: true, gemini: false }), discover: async () => ({ codex: { available: true, version: '0.142.5', models: [{ id: 'gpt-5.5', efforts: ['low', 'high'] }] } }), discovered: () => null,
        run: (provider, opts) => ({ promise: Promise.resolve({ text: `${provider} ${opts.model}/${opts.effort}` }), abort() { } }) };
    const direct = createVariants({ cli: fakeCli, core, loadLibrary: () => loadLibraryFrom(dir), dataDir: () => dir });
    const h = makeHarness({ ipcReply: () => { throw new Error('IPC must not be used'); } });
    register(h.server, Object.assign({}, h.deps, { ipcClient: null, variantsBackend: direct }));
    const list = textOf(await h.tools.get('cli_variants').handler({}));
    assert.match(list, /codex 0\.142\.5/);
    assert.match(list, /- GPT low \[gpt-low\]: codex-cli · gpt-5\.5 · low/);
    const ask = textOf(await h.tools.get('ask_variant').handler({ message: 'hi', variant: 'GPT low' }));
    assert.match(ask, /^\[GPT low · codex-cli · gpt-5\.5 · low · 0\.0s\]\ncodex-cli gpt-5\.5\/low$/);
    assert.equal(h.ipcCalls.length, 0, 'nothing went over IPC');
});
