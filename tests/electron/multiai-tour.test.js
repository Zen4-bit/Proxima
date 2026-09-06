// The tour points at live elements, which is the reason it exists — a recorded
// video of a UI is wrong the first time a label moves and says nothing about
// it. That only holds if the selectors are checked against the markup, so these
// tests read every selector out of the step definitions and look for it.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EL = path.join(HERE, '..', '..', 'electron');
const tourSrc = fs.readFileSync(path.join(EL, 'multiai-tour.js'), 'utf8');
const html = fs.readFileSync(path.join(EL, 'index-v2.html'), 'utf8');
const renderer = fs.readFileSync(path.join(EL, 'multiai-renderer.js'), 'utf8');

function steps() {
    const sandbox = { console, document: { addEventListener() {} }, window: { addEventListener() {} } };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(tourSrc + ';globalThis.__steps = MULTIAI_TOUR_STEPS;', sandbox, { filename: 'multiai-tour.js' });
    return sandbox.__steps;
}

// Every id / selector / optab a step reaches for, read out of its own source.
function refsOf(step) {
    const src = String(step.target) + (step.before ? String(step.before) : '');
    return {
        ids: [...src.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
        selectors: [...src.matchAll(/querySelector(?:All)?\('([^']+)'\)/g)].map(m => m[1]),
        optabs: [...src.matchAll(/multiaiSelectOptab\('([^']+)'\)/g)].map(m => m[1]),
    };
}

test('every step is a real step', () => {
    const s = steps();
    assert.equal(s.length, 9);
    for (const step of s) {
        assert.ok(step.title && step.title.length < 60, step.title);
        assert.ok(step.text && step.text.length > 40, step.title);
        assert.equal(typeof step.target, 'function', step.title);
    }
    assert.equal(new Set(s.map(x => x.title)).size, s.length, 'titles are distinct');
});

test('every id a step points at exists in the page', () => {
    for (const step of steps()) {
        for (const id of refsOf(step).ids) {
            assert.ok(html.includes(`id="${id}"`), `${step.title}: no #${id} in index-v2.html`);
        }
    }
});

test('every selector a step points at exists in the page or is rendered by the roster', () => {
    // A selector is either static markup or something multiaiRenderParticipants
    // writes; either way the string has to appear in one of the two files.
    const anchor = (sel) => (sel.match(/#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]/g) || [sel]);
    for (const step of steps()) {
        for (const sel of refsOf(step).selectors) {
            for (const part of anchor(sel)) {
                const bare = part.replace(/^[#.]/, '').replace(/^\[|\]$/g, '');
                assert.ok(html.includes(bare) || renderer.includes(bare),
                    `${step.title}: "${bare}" (from "${sel}") is in neither index-v2.html nor multiai-renderer.js`);
            }
        }
    }
});

test('every options tab a step opens is a tab that exists', () => {
    const known = new Set([...html.matchAll(/data-optab="([^"]+)"/g)].map(m => m[1]));
    assert.ok(known.size >= 6, [...known].join(','));
    for (const step of steps()) {
        for (const t of refsOf(step).optabs) {
            assert.ok(known.has(t), `${step.title}: no options tab "${t}"`);
        }
    }
});

test('the roster columns a step points at are the columns it names', () => {
    // multiaiTourCell(n) indexes the roster's cells, so a column inserted before
    // one of them would silently move the spotlight onto its neighbour.
    const head = renderer.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/);
    assert.ok(head, 'roster header not found in the renderer');
    const cols = [...head[1].matchAll(/<th[^>]*>(?:<span[^>]*>)?([^<]*)/g)].map(m => m[1].trim());
    assert.deepEqual(cols.slice(2, 7), ['Provider', 'Route', 'Model', 'Effort', 'Tools']);
    const byCol = {};
    for (const step of steps()) {
        const m = String(step.target).match(/multiaiTourCell\((\d+)\)/);
        if (m) byCol[Number(m[1])] = step.title;
    }
    // Provider(2), Route(3), Model(4), Tools(6) each get a step, and each step's
    // title names the column it lands on.
    for (const [col, title] of Object.entries(byCol)) {
        assert.ok(title.toLowerCase().startsWith(cols[col].toLowerCase()),
            `step "${title}" points at column ${col} (${cols[col]})`);
    }
    assert.deepEqual(Object.keys(byCol).map(Number).sort((a, b) => a - b), [2, 3, 4, 6]);
});

test('the tour is loaded by the page, after the renderer it calls into', () => {
    const r = html.indexOf('src="multiai-renderer.js"');
    const t = html.indexOf('src="multiai-tour.js"');
    assert.ok(r !== -1 && t !== -1, 'both scripts are on the page');
    assert.ok(t > r, 'the tour uses multiaiSelectOptab / multiaiUiPrefs at call time');
    assert.ok(html.includes('multiaiStartTour()'), 'something starts it');
});
