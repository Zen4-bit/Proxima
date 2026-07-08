// Proxima — File Tree Renderer Tests.
// Verifies forward/backward slash splitting, node reuse, indentation, line count annotations, and tree statistics.

import test from 'node:test';
import assert from 'node:assert';
import {
    generateFileTree,
    treeToString,
    treeToStringWithLineCounts,
    generateTreeString,
    generateTreeStringWithLineCounts,
    getTreeStats,
} from '../../src/utils/file-tree.js';

test('generateFileTree: shared prefixes reuse the same directory node (no dupes)', () => {
    const root = generateFileTree(['src/a.js', 'src/b.js', 'src/sub/c.js']);
    assert.equal(root.children.length, 1, 'single top-level dir "src"');
    const src = root.children[0];
    assert.equal(src.name, 'src');
    assert.equal(src.isDirectory, true);
    assert.equal(src.children.length, 3);
    const dirs = src.children.filter((c) => c.isDirectory).map((c) => c.name);
    assert.deepEqual(dirs, ['sub']);
});

test('generateFileTree: splits on both forward and back slashes', () => {
    const root = generateFileTree(['a\\b\\c.js']);
    const a = root.children[0];
    assert.equal(a.name, 'a');
    assert.equal(a.isDirectory, true);
    const b = a.children[0];
    assert.equal(b.name, 'b');
    assert.equal(b.isDirectory, true);
    assert.equal(b.children[0].name, 'c.js');
    assert.equal(b.children[0].isDirectory, false);
});

test('generateFileTree: empty input yields an empty root', () => {
    const root = generateFileTree([]);
    assert.equal(root.name, 'root');
    assert.equal(root.isDirectory, true);
    assert.deepEqual(root.children, []);
});

test('treeToString: directories sort before files, both alphabetical', () => {
    const out = generateTreeString(['zebra.js', 'alpha.js', 'lib/util.js', 'app/main.js']);
    const lines = out.split('\n');
    assert.equal(lines[0], 'app/');
    assert.equal(lines[1], '  main.js');
    assert.equal(lines[2], 'lib/');
    assert.equal(lines[3], '  util.js');
    assert.equal(lines[4], 'alpha.js');
    assert.equal(lines[5], 'zebra.js');
});

test('treeToString: nested directories are indented two spaces per level', () => {
    const out = generateTreeString(['a/b/c.js']);
    assert.equal(out, ['a/', '  b/', '    c.js'].join('\n'));
});

test('treeToStringWithLineCounts: annotates files, leaves dirs bare', () => {
    const out = generateTreeStringWithLineCounts(
        ['src/index.js', 'README.md'],
        { 'src/index.js': 42, 'README.md': 5 },
    );
    const lines = out.split('\n');
    assert.equal(lines[0], 'src/');
    assert.equal(lines[1], '  index.js (42 lines)');
    assert.equal(lines[2], 'README.md (5 lines)');
});

test('treeToStringWithLineCounts: files with no known count get no suffix', () => {
    const out = generateTreeStringWithLineCounts(['a.js'], {});
    assert.equal(out, 'a.js');
});

test('getTreeStats: counts files and directories across the full tree', () => {
    const tree = generateFileTree(['src/a.js', 'src/sub/b.js', 'src/sub/c.js', 'top.js']);
    const stats = getTreeStats(tree);
    assert.deepEqual(stats, { files: 4, directories: 2 });
});

test('treeToString is idempotent on repeated calls (sort mutates in place safely)', () => {
    const tree = generateFileTree(['b.js', 'a.js']);
    const first = treeToString(tree);
    const second = treeToString(tree);
    assert.equal(first, second);
    assert.equal(first, 'a.js\nb.js\n');
});
