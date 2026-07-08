// Proxima — Context Auto-Discovery Tests.
// Verifies working directory context file scanning, ancestor dir walking, YAML frontmatter stripping, file length truncation, and output format wrappers.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const discovery = require('../../electron/api/byok/discovery/index.cjs');

const tmpRoots = [];
function freshDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-'));
    tmpRoots.push(d);
    return d;
}
test.after(() => {
    for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test('scan finds an AGENTS.md in the working directory', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rules\nBe concise.');
    const result = discovery.scan(dir);
    assert.equal(result.cwd, dir);
    const agents = result.files.find((f) => f.name === 'AGENTS.md');
    assert.ok(agents, 'AGENTS.md discovered');
    assert.match(agents.content, /Be concise/);
});

test('scan strips YAML frontmatter from loaded files', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '.proxima.md'), '---\ntitle: x\n---\nActual body content here.');
    const result = discovery.scan(dir);
    const f = result.files.find((x) => x.name === '.proxima.md');
    assert.ok(f);
    assert.match(f.content, /Actual body content/);
    assert.ok(!f.content.includes('title: x'), 'frontmatter removed');
});

test('scan truncates files exceeding MAX_FILE_CHARS', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'a'.repeat(discovery.MAX_FILE_CHARS + 500));
    const result = discovery.scan(dir);
    const f = result.files.find((x) => x.name === 'AGENTS.md');
    assert.equal(f.truncated, true);
    assert.match(f.content, /truncated/);
});

test('scan walks up to the git root to find ancestor context files', () => {
    const root = freshDir();
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root-level rules');
    const sub = path.join(root, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const result = discovery.scan(sub);
    const f = result.files.find((x) => x.name === 'AGENTS.md');
    assert.ok(f, 'ancestor AGENTS.md found by walking up');
    assert.match(f.content, /root-level rules/);
});

test('scan loads at most MAX_FILES files', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '.proxima.md'), 'one');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'two');
    fs.writeFileSync(path.join(dir, '.cursorrules'), 'three');
    fs.mkdirSync(path.join(dir, '.github'));
    fs.writeFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'four');
    const result = discovery.scan(dir);
    assert.ok(result.files.length <= discovery.MAX_FILES);
});

test('format renders a labelled project-context block', () => {
    const block = discovery.format({ files: [{ name: 'AGENTS.md', content: 'be nice' }] });
    assert.match(block, /PROJECT CONTEXT/);
    assert.match(block, /\[AGENTS\.md\]/);
    assert.match(block, /be nice/);
});

test('format returns empty string when no files were discovered', () => {
    assert.equal(discovery.format({ files: [] }), '');
    assert.equal(discovery.format(null), '');
});
