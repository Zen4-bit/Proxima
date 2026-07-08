// Proxima — Codebase Packer and Grep Tests.
// Verifies directory scanning, extension lists, file size limits, secret detection, and line-numbered grep matching with context.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    scanDirectory,
    scanForSecrets,
    packCodebase,
    grepContent,
} from '../../src/utils/codebase-packer.js';

const tmpRoots = [];
function makeTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packer-'));
    tmpRoots.push(root);
    return root;
}
test.after(() => {
    for (const d of tmpRoots) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
});



test('scanForSecrets: detects an AWS access key and a GitHub token', () => {
    const content = 'const k = "AKIAIOSFODNN7EXAMPLE";\nconst t = "ghp_' + 'a'.repeat(36) + '";';
    const found = scanForSecrets(content, 'x.js');
    assert.ok(found.includes('AWS Access Key'), 'AWS key detected');
    assert.ok(found.includes('GitHub Token'), 'GitHub token detected');
});

test('scanForSecrets: clean code produces no false positives', () => {
    const content = 'function add(a, b) { return a + b; }\nconst msg = "hello world";';
    assert.deepEqual(scanForSecrets(content, 'x.js'), []);
});



test('scanDirectory: collects code files, skips node_modules and hidden entries', () => {
    const root = makeTree();
    fs.writeFileSync(path.join(root, 'index.js'), 'console.log(1);');
    fs.writeFileSync(path.join(root, 'README.md'), '# hi');
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'a.js'), 'x');
    fs.writeFileSync(path.join(root, '.secret'), 'hidden');

    const { files } = scanDirectory(root);
    const rels = files.map((f) => f.relativePath).sort();
    assert.deepEqual(rels, ['README.md', 'index.js']);
    assert.ok(!rels.some((r) => r.startsWith('node_modules')), 'node_modules skipped');
    assert.ok(!rels.includes('.secret'), 'hidden file skipped');
});

test('scanDirectory: ignores files with unsupported extensions', () => {
    const root = makeTree();
    fs.writeFileSync(path.join(root, 'keep.py'), 'x = 1');
    fs.writeFileSync(path.join(root, 'skip.bin'), 'binary');
    const { files } = scanDirectory(root);
    assert.deepEqual(files.map((f) => f.relativePath), ['keep.py']);
});

test('scanDirectory: skips files exceeding maxFileSizeKB and reports them', () => {
    const root = makeTree();
    fs.writeFileSync(path.join(root, 'big.js'), 'x'.repeat(3 * 1024));
    fs.writeFileSync(path.join(root, 'small.js'), 'ok');
    const { files, skipped } = scanDirectory(root, { maxFileSizeKB: 1 });
    assert.deepEqual(files.map((f) => f.relativePath), ['small.js']);
    assert.ok(skipped.some((s) => s.includes('big.js')), 'oversized file reported as skipped');
});

test('scanDirectory: respects maxFiles cap', () => {
    const root = makeTree();
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.js`), 'x');
    const { files } = scanDirectory(root, { maxFiles: 2 });
    assert.equal(files.length, 2);
});



test('packCodebase: error when the directory does not exist', () => {
    const res = packCodebase(path.join(os.tmpdir(), 'no-such-dir-xyz-123'));
    assert.equal(res.success, false);
    assert.match(res.error, /not found/i);
});

test('packCodebase: error when the path is a file, not a directory', () => {
    const root = makeTree();
    const file = path.join(root, 'a.js');
    fs.writeFileSync(file, 'x');
    const res = packCodebase(file);
    assert.equal(res.success, false);
    assert.match(res.error, /not a directory/i);
});

test('packCodebase: error when no supported files are present', () => {
    const root = makeTree();
    fs.writeFileSync(path.join(root, 'data.bin'), 'x');
    const res = packCodebase(root);
    assert.equal(res.success, false);
    assert.match(res.error, /no supported files/i);
});

test('packCodebase: success returns markdown, metrics, and secret warnings', () => {
    const root = makeTree();
    fs.writeFileSync(path.join(root, 'app.js'), 'function main() {\n  return 42;\n}\n');
    fs.writeFileSync(path.join(root, 'leak.js'), 'const key = "AKIAIOSFODNN7EXAMPLE";\n');

    const res = packCodebase(root);
    assert.equal(res.success, true);
    assert.equal(res.metrics.totalFiles, 2);
    assert.ok(res.metrics.totalTokens > 0);
    assert.ok(res.packed.includes('## 📄 File Contents'));
    assert.ok(res.packed.includes('app.js'));
    assert.equal(res.secretWarnings.length, 1);
    assert.equal(res.secretWarnings[0].file, 'leak.js');
    assert.ok(res.packed.includes('Security Warnings'));
});



test('grepContent: returns line-numbered matches', () => {
    const content = 'alpha\nbeta needle\ngamma\nneedle again';
    const res = grepContent(content, { pattern: 'needle' });
    assert.equal(res.totalMatches, 2);
    assert.deepEqual(res.matches.map((m) => m.lineNumber), [2, 4]);
});

test('grepContent: contextLines includes surrounding lines', () => {
    const content = 'l1\nl2\nTARGET\nl4\nl5';
    const res = grepContent(content, { pattern: 'TARGET', contextLines: 1 });
    const joined = res.formattedOutput.join('\n');
    assert.ok(joined.includes('2-l2'));
    assert.ok(joined.includes('3:TARGET'));
    assert.ok(joined.includes('4-l4'));
});

test('grepContent: ignoreCase matches regardless of case', () => {
    const res = grepContent('Hello WORLD', { pattern: 'world', ignoreCase: true });
    assert.equal(res.totalMatches, 1);
});

test('grepContent: invalid regex returns an error, not a throw', () => {
    const res = grepContent('abc', { pattern: '(' });
    assert.match(res.error, /invalid regex/i);
    assert.equal(res.totalMatches, 0);
});

test('grepContent: empty pattern short-circuits to zero matches', () => {
    const res = grepContent('anything', {});
    assert.equal(res.totalMatches, 0);
    assert.deepEqual(res.matches, []);
});
