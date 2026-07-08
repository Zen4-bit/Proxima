// Proxima — MCP Utility Tools Tests.
// Verifies utility tool registration, cache clearing, file analysis/review prompts, and window IPC triggers.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from '../../src/mcp/tools-utility.js';
import { registerModule, textOf } from '../fixtures/mcp-harness.js';

const tmpFiles = [];
function tmpFile(name, content) {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-util-')), name);
    fs.writeFileSync(p, content);
    tmpFiles.push(p);
    return p;
}
test.after(() => { for (const f of tmpFiles) { try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch {} } });

test('tools-utility: registers the 7 documented utility tools', () => {
    const { tools } = registerModule(register);
    assert.deepEqual(
        [...tools.keys()].sort(),
        ['analyze_file', 'clear_cache', 'hide_window', 'review_code_file', 'set_headless_mode', 'show_window', 'toggle_window'],
    );
});

test('clear_cache: empties every provider cache and reports success', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('clear_cache').handler({});
    assert.match(textOf(res), /Cache cleared/);
    for (const p of Object.values(h.deps.allProviders)) assert.equal(p.cache.size, 0);
});

test('analyze_file: reads a small file, sends it to smartChat, returns a header + reply', async () => {
    const file = tmpFile('sample.js', 'export const x = 1;\n');
    const h = registerModule(register);
    const res = await h.tools.get('analyze_file').handler({ filePath: file, question: 'what is this?' });
    assert.match(textOf(res), /sample\.js/);
    assert.match(textOf(res), /reply:claude/);
    assert.match(h.smartChatCalls[0].msg, /what is this\?/);
});

test('analyze_file: rejects image files with a clear not-supported message', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('analyze_file').handler({ filePath: 'C:/x/pic.png' });
    assert.match(textOf(res), /Image analysis is not available/);
    assert.equal(h.smartChatCalls.length, 0);
});

test('review_code_file: returns a message when the file cannot be read', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('review_code_file').handler({ filePath: '/nope.js' });
    assert.match(textOf(res), /Could not read file/);
});

test('review_code_file: reviews readable content with the focus applied', async () => {
    const h = registerModule(register, { deps: { readFileContents: () => 'function f(){}' } });
    const res = await h.tools.get('review_code_file').handler({ filePath: '/a.js', focus: 'security' });
    assert.match(textOf(res), /Code Review/);
    assert.match(textOf(res), /Focus: security/);
    assert.match(h.smartChatCalls[0].msg, /Focus on: security/);
});

test('show_window / hide_window: send the matching IPC action and report success', async () => {
    const h = registerModule(register);
    const showRes = await h.tools.get('show_window').handler({});
    assert.match(textOf(showRes), /visible/);
    await h.tools.get('hide_window').handler({});
    const actions = h.ipcCalls.map((c) => c[0]);
    assert.deepEqual(actions, ['showWindow', 'hideWindow']);
});

test('toggle_window: reflects the visibility returned by the gateway', async () => {
    const h = registerModule(register, { ipcReply: () => ({ visible: false }) });
    const res = await h.tools.get('toggle_window').handler({});
    assert.match(textOf(res), /Window hidden/);
});

test('set_headless_mode: forwards the enabled flag via IPC', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('set_headless_mode').handler({ enabled: true });
    assert.match(textOf(res), /Headless mode enabled/);
    const call = h.ipcCalls.find((c) => c[0] === 'setHeadlessMode');
    assert.deepEqual(call[2], { enabled: true });
});
