// Google retired Gemini CLI for individual plans on 2026-06-18; `gemini` now
// answers IneligibleTierError and Antigravity (agy) is the replacement. These
// cover the one piece of real parsing that goes with it.

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cli = require(path.join(HERE, '..', '..', '..', 'electron', 'providers', 'cli.cjs'));
const parse = cli.__parseAgyModels;

// Verbatim from `agy models` on a signed-in machine.
const REAL = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
    'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
    'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

test('agy models folds one id per effort back into a family', () => {
    const m = parse(REAL);
    assert.deepEqual(m.map(x => x.id),
        ['gemini-3.8-flash', 'gemini-3.1-pro', 'claude-opus-4-6-thinking', 'gpt-oss-120b']);
    // The CLI refuses a suffixed id together with --effort, so the seat carries
    // the family and Effort stays the column it is for every other CLI.
    assert.deepEqual(m[0].efforts, ['low', 'medium', 'high']);
    assert.deepEqual(m[1].efforts, ['low', 'high'], '3.1 Pro has no medium');
    assert.deepEqual(m[2].efforts, [], 'a model listed once has no effort switch');
    assert.deepEqual(m[3].efforts, ['medium'], 'a lone -medium is an effort, not part of the name');
});

test('labels lose the effort they were listed at, and noise is skipped', () => {
    const m = parse(REAL);
    assert.equal(m[0].label, 'Gemini 3.8 Flash');
    assert.equal(m[2].label, 'Claude Opus 4.6 (Thinking)', 'only the effort parenthetical goes');
    assert.ok(!m.some(x => /Fetching/.test(x.id)));
});

test('nothing in, nothing out', () => {
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse(undefined), []);
    assert.deepEqual(parse('no tabs here at all'), []);
});

test('antigravity is a CLI provider the core knows about', () => {
    const core = require(path.join(HERE, '..', '..', '..', 'electron', 'ipc', 'multiai-core.cjs'));
    assert.equal(core.CLI_PROVIDERS['antigravity-cli'].bin, 'agy');
    const [a] = core.normalizeAgents({ agents: [{ provider: 'antigravity-cli', model: 'gemini-3.8-flash', route: 'browser' }] });
    assert.equal(a.route, 'cli', 'a CLI provider is always on the CLI route');
});
