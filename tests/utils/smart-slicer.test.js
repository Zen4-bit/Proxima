// Proxima — Smart Slicer Tests.
// Verifies symbol mapping, full-file vs smart-slice vs truncated modes, partial name matches, and dependency symbol resolution.

import test from 'node:test';
import assert from 'node:assert';
import {
    buildSymbolMap,
    smartSlice,
    sliceBySymbols,
    getFileOverview,
    extractSymbols,
} from '../../src/utils/smart-slicer.js';

function makeBigJs(names, body = 8) {
    const parts = [];
    for (const name of names) {
        parts.push(`function ${name}(x) {`);
        for (let i = 0; i < body; i++) parts.push(`  const v${i} = x + ${i};`);
        parts.push('  return x;');
        parts.push('}');
        parts.push('');
    }
    return parts.join('\n');
}

test('extractSymbols is re-exported from smart-slicer for back-compat', () => {
    const syms = extractSymbols('function a() {}', 'x.js');
    assert.equal(syms[0].name, 'a');
});

test('buildSymbolMap: groups symbols by type with line ranges', () => {
    const src = 'class Foo {\n  bar() {\n    return 1;\n  }\n}\nfunction baz() { return 2; }';
    const map = buildSymbolMap(src, 'x.js');
    assert.ok(map.includes('Symbol Map'));
    assert.ok(map.includes('Foo'));
    assert.ok(map.includes('baz'));
    assert.ok(/Classes/.test(map));
    assert.ok(/Functions/.test(map));
});

test('buildSymbolMap: reports no symbols for unsupported languages', () => {
    const map = buildSymbolMap('plain content', 'notes.unknownext');
    assert.match(map, /No symbols found/i);
});

test('smartSlice: small file is returned whole (mode full-file)', () => {
    const src = 'function a() { return 1; }\nfunction b() { return 2; }';
    const res = smartSlice(src, 'x.js', 'anything', { maxLines: 500 });
    assert.equal(res.mode, 'full-file');
    assert.equal(res.sliced, src);
    assert.equal(res.savings, '0%');
});

test('smartSlice: large file with no symbols is truncated (mode truncated)', () => {
    const src = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const res = smartSlice(src, 'notes.txt', 'x', { maxLines: 10 });
    assert.equal(res.mode, 'truncated');
    assert.ok(res.sliced.includes('truncated'));
    assert.equal(res.sentLines, 10);
});

test('smartSlice: large file + keyword keeps only the matching function', () => {
    const names = Array.from({ length: 10 }, (_, i) => `handler${i}`);
    names.push('authenticateUser');
    const src = makeBigJs(names);
    const res = smartSlice(src, 'x.js', 'authenticate user login', { maxLines: 30 });
    assert.equal(res.mode, 'smart-slice');
    // The relevant function's body must be present.
    assert.ok(res.sliced.includes('function authenticateUser'));
    // Real savings because we did not send the whole file.
    assert.ok(res.sentLines < res.totalLines);
});

test('sliceBySymbols: exact name match extracts that symbol', () => {
    const names = Array.from({ length: 6 }, (_, i) => `fn${i}`);
    const src = makeBigJs(names);
    const res = sliceBySymbols(src, 'x.js', ['fn3'], { resolveDeps: false });
    assert.equal(res.mode, 'symbol-select');
    assert.ok(res.found.includes('fn3'));
    assert.ok(res.sliced.includes('function fn3'));
    assert.deepEqual(res.notFound, []);
});

test('sliceBySymbols: partial name match still resolves', () => {
    const src = makeBigJs(['calculateTotalPrice', 'other']);
    const res = sliceBySymbols(src, 'x.js', ['calculateTotal'], { resolveDeps: false });
    assert.ok(res.found.some((n) => n.includes('calculateTotalPrice')));
});

test('sliceBySymbols: unknown symbol goes to notFound / not-found mode', () => {
    const src = makeBigJs(['realOne']);
    const res = sliceBySymbols(src, 'x.js', ['doesNotExist'], { resolveDeps: false });
    assert.equal(res.mode, 'not-found');
    assert.deepEqual(res.notFound, ['doesNotExist']);

    assert.ok(res.sliced.includes('realOne'));
});

test('sliceBySymbols: auto-resolves a called dependency function', () => {
    const src = [
        'function helper(y) {',
        '  return y * 2;',
        '}',
        '',
        'function caller(x) {',
        '  return helper(x) + 1;',
        '}',
        '',
    ].join('\n');
    const res = sliceBySymbols(src, 'x.js', ['caller'], { resolveDeps: true, includeMap: false });
    assert.ok(res.found.includes('caller'));
    assert.ok(
        res.found.some((n) => n.startsWith('helper')),
        'helper must be auto-included as a dependency',
    );
    assert.ok(res.sliced.includes('function helper'));
});

test('getFileOverview: includes filename, line count and the symbol map', () => {
    const src = 'function a() { return 1; }';
    const overview = getFileOverview(src, 'mod.js');
    assert.ok(overview.includes('mod.js'));
    assert.ok(overview.includes('lines'));
    assert.ok(overview.includes('a'));
});
