// Proxima — Symbol Extractor Tests.
// Verifies JS and Python def/class/method captures, tool registrations, indent block detections, escape regex helpers, and line range mergers.

import test from 'node:test';
import assert from 'node:assert';
import {
    extractSymbols,
    escapeRegex,
    mergeRanges,
    EXT_TO_LANG,
} from '../../src/utils/symbol-extractor.js';

const byName = (syms, name) => syms.find((s) => s.name === name);

test('extractSymbols: JS function declarations get correct name/type/lines', () => {
    const src = [
        'export function foo(a, b) {',
        '  return a + b;',
        '}',
    ].join('\n');
    const syms = extractSymbols(src, 'x.js');
    const foo = byName(syms, 'foo');
    assert.ok(foo, 'foo found');
    assert.equal(foo.type, 'function');
    assert.equal(foo.startLine, 1);
    assert.equal(foo.endLine, 3);
    assert.equal(foo.lineCount, 3);
    assert.equal(foo.signature, 'export function foo(a, b) {');
});

test('extractSymbols: arrow-function consts are detected as functions', () => {
    const src = 'const handler = async (req) => {\n  return 1;\n};\n';
    const syms = extractSymbols(src, 'x.js');
    const h = byName(syms, 'handler');
    assert.ok(h);
    assert.equal(h.type, 'function');
});

test('extractSymbols: classes and their methods are both captured', () => {
    const src = [
        'class Widget {',
        '  render() {',
        '    return this.x;',
        '  }',
        '}',
    ].join('\n');
    const syms = extractSymbols(src, 'x.js');
    assert.equal(byName(syms, 'Widget').type, 'class');
    const render = byName(syms, 'render');
    assert.ok(render, 'method render captured');
    assert.equal(render.type, 'method');
});

test('extractSymbols: JS keywords like if/for/switch are NOT treated as methods', () => {
    const src = [
        'function run() {',
        '  if (x) {',
        '    for (let i = 0; i < 3;) {',
        '      doThing();',
        '    }',
        '  }',
        '}',
    ].join('\n');
    const syms = extractSymbols(src, 'x.js');
    const names = syms.map((s) => s.name);
    assert.ok(!names.includes('if'), 'if must not be a symbol');
    assert.ok(!names.includes('for'), 'for must not be a symbol');
    assert.ok(names.includes('run'), 'the real function is still found');
});

test('extractSymbols: server.tool/registerTool("name") registrations are captured as tools', () => {
    const src = [
        `server.registerTool('deep_search', { schema }, handler);`,
        `server.tool('ask_chatgpt', { schema }, handler);`,
    ].join('\n');
    const syms = extractSymbols(src, 'server.js');
    const toolSyms = syms.filter((s) => s.type === 'tool');
    const toolNames = toolSyms.map((s) => s.name);
    assert.ok(toolNames.includes('deep_search'), 'server.registerTool name extracted');
    assert.ok(toolNames.includes('ask_chatgpt'), 'legacy server.tool name extracted');
});

test('extractSymbols: Python def/class use indentation for block end', () => {
    const src = [
        'class Foo:',
        '    def bar(self):',
        '        return 1',
        '',
        '    def baz(self):',
        '        return 2',
        '',
        'x = 1',
    ].join('\n');
    const syms = extractSymbols(src, 'm.py');
    const foo = byName(syms, 'Foo');
    assert.ok(foo);
    assert.equal(foo.type, 'class');
    assert.equal(foo.endLine, 6);
    const bar = byName(syms, 'bar');
    assert.equal(bar.type, 'method');
    assert.equal(bar.startLine, 2);
    assert.equal(bar.endLine, 3);
});

test('extractSymbols: unsupported extension returns [] without throwing', () => {
    assert.deepEqual(extractSymbols('anything at all', 'file.unknownext'), []);
    assert.deepEqual(extractSymbols('plain text', 'notes'), []);
});

test('extractSymbols: symbols are sorted by start line', () => {
    const src = [
        'function second() { return 2; }',
        'function first() { return 1; }',
    ].join('\n');
    const syms = extractSymbols(src, 'x.js').filter((s) => s.type === 'function');
    assert.deepEqual(syms.map((s) => s.startLine), [1, 2]);
});

test('escapeRegex: escapes all regex metacharacters so names match literally', () => {
    const escaped = escapeRegex('a.b(c)[d]{e}+*?^$|\\');
    const re = new RegExp(escaped);
    assert.ok(re.test('a.b(c)[d]{e}+*?^$|\\'));
    assert.ok(!re.test('axbxcx'), 'dot is escaped, not a wildcard');
});

test('mergeRanges: merges ranges within 5-line gap, keeps distant ones separate', () => {
    const merged = mergeRanges([
        { start: 1, end: 5 },
        { start: 8, end: 10 },
        { start: 40, end: 50 },
    ]);
    assert.equal(merged.length, 2);
    assert.deepEqual({ start: merged[0].start, end: merged[0].end }, { start: 1, end: 10 });
    assert.deepEqual({ start: merged[1].start, end: merged[1].end }, { start: 40, end: 50 });
});

test('mergeRanges: single or empty input is returned unchanged', () => {
    assert.deepEqual(mergeRanges([]), []);
    const one = [{ start: 3, end: 9 }];
    assert.deepEqual(mergeRanges(one), one);
});

test('EXT_TO_LANG: maps TypeScript and CommonJS variants onto the JS ruleset', () => {
    assert.equal(EXT_TO_LANG['.ts'], 'js');
    assert.equal(EXT_TO_LANG['.cjs'], 'js');
    assert.equal(EXT_TO_LANG['.py'], 'py');
});
