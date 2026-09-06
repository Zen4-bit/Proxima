#!/usr/bin/env node
// Hand a code review to a panel of local CLI agents, through the running
// Proxima's REST port.
//
// The point is the disagreement. One model reviewing a diff gives you one
// model's blind spots; four of them answering the same brief blind to each
// other, then reading each other's findings in round two, gives you the union
// of what they catch and — more useful — the short list they argue about.
// Independent rounds are what make that worth doing: without them the later
// seats mostly agree with whoever went first.
//
//   node scripts/review-panel.mjs                     # plan only, spends nothing
//   node scripts/review-panel.mjs --base main --go    # actually run it
//   node scripts/review-panel.mjs --paths "src/**" --rounds 3 --go
//
// Seats are whichever CLIs are installed and signed in, discovered through
// Proxima's own provider layer rather than assumed. Nothing runs without --go.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = require(path.join(ROOT, 'electron', 'providers', 'cli.cjs'));

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);

const BASE = flag('base', 'HEAD~1');
const PATHS = flag('paths', '');
const ROUNDS = Math.max(1, Math.min(6, Number(flag('rounds', 2))));
const PORT = Number(flag('port', 3210));
const OUT = flag('out', '');
const WORKSPACE = flag('workspace', '');
const GO = has('go');

// Antigravity takes its prompt on the command line and refuses past ~28k
// characters, and every seat pays for what it is sent on every round. So the
// brief carries the shape of the change and the seats read the rest themselves:
// they are given the repo with read-only file tools.
const DIFF_BUDGET = Number(flag('diff-budget', 12000));

const git = (...args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
    return r.stdout;
};

function target() {
    if (PATHS) return { label: `paths ${PATHS}`, args: ['--', ...PATHS.split(/\s+/)] };
    git('rev-parse', '--verify', BASE);                   // fail early on a bad ref
    return { label: `${BASE}..HEAD`, args: [`${BASE}...HEAD`] };
}

function brief(t) {
    const stat = git('diff', '--stat', ...t.args).trim();
    const log = PATHS ? '' : git('log', '--oneline', `${BASE}..HEAD`).trim();
    let diff = git('diff', ...t.args);
    let truncated = false;
    if (diff.length > DIFF_BUDGET) { diff = diff.slice(0, DIFF_BUDGET); truncated = true; }
    return [
        `Review the change below in ${path.basename(ROOT)} (${t.label}).`,
        '',
        'You have read-only file tools on this repository. Open the files you are',
        'reviewing — the diff here is context, not the whole story, and a hunk that',
        'looks fine in isolation is exactly where the interesting bugs are.',
        '',
        'Report only defects you can point at: file, line, what breaks and the input',
        'or state that breaks it. Rank by severity. If you have nothing, say PASS —',
        'a list padded with style opinions buries the one real finding.',
        '',
        log ? `Commits:\n${log}\n` : '',
        `Files:\n${stat}\n`,
        '```diff',
        diff,
        '```',
        truncated ? `\n(diff truncated at ${DIFF_BUDGET} characters — read the files for the rest)` : '',
    ].filter(Boolean).join('\n');
}

// Whoever is actually installed and signed in. Two Claude Code seats at
// different models is deliberate: the cheapest way to see whether a finding is
// the model or the code is to ask the same family twice.
// A model the account is known to have. Discovery pads a CLI's own list with a
// public catalogue, and those entries are candidates — picking models[0] blindly
// once chose gpt-6-astra for a Codex seat, which is in the catalogue and not on
// this account. Prefer what the CLI itself reported, then its configured
// default, then nothing at all: blank means "the CLI's own default", which is
// always right.
function entitled(info, match) {
    const own = (info.models || []).filter(m => m.source !== 'catalog');
    const hit = match ? own.find(m => match.test(m.id)) : null;
    return (hit || own[0] || {}).id || info.defaultModel || '';
}

async function seats() {
    const d = await cli.discover({ force: true });
    const pick = [];
    const add = (name, provider, model, effort) => pick.push({ name, provider, model, effort, tools: 'read' });
    if (d.claude && d.claude.available) {
        add('Claude · opus', 'claude-cli', 'opus', 'high');
        add('Claude · sonnet', 'claude-cli', 'sonnet', 'high');
    }
    if (d.codex && d.codex.available) {
        add('Codex', 'codex-cli', entitled(d.codex), 'high');
    }
    if (d.antigravity && d.antigravity.available && d.antigravity.loggedIn) {
        const id = entitled(d.antigravity, /pro/);
        const m = (d.antigravity.models || []).find(x => x.id === id);
        if (id) add('Antigravity', 'antigravity-cli', id, (m && (m.efforts || []).includes('high')) ? 'high' : '');
    }
    // Gemini CLI is deliberately absent: Google stopped serving individual plans
    // on 2026-06-18 and it answers IneligibleTierError. Add it by hand if you
    // are on an enterprise licence.
    return pick;
}

const api = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
};

// ---------------------------------------------------------------------------
const t = target();
const panel = await seats();
const prompt = brief(t);

console.log(`\nReview target : ${t.label}`);
console.log(`Workspace     : ${WORKSPACE || 'a throwaway worktree at HEAD'}  (read-only tools)`);
console.log(`Brief         : ${prompt.length.toLocaleString()} characters`);
console.log(`Rounds        : ${ROUNDS}  (independent — each round is blind to itself)`);
console.log('Panel         :');
for (const s of panel) console.log(`  - ${s.name.padEnd(16)} ${s.provider} ${s.model || '(default)'}${s.effort ? ' · ' + s.effort : ''}`);
if (!panel.length) { console.error('\nNo CLI is installed and signed in — nothing to run.'); process.exit(1); }
console.log(`\nThat is ${panel.length * ROUNDS} turns on your subscriptions.`);

if (!GO) {
    console.log('\nPlan only. Add --go to create the chat and run it.\n');
    process.exit(0);
}

try {
    await api('GET', '/v1/multiai/chats');
} catch {
    console.error(`\nProxima is not answering on 127.0.0.1:${PORT}. Start it, or pass --port.`);
    process.exit(1);
}

// A seat with any tools level — read included — makes Proxima cut and check out
// a multiai/... branch in the folder it is given. That is right for a writing
// seat and wrong for a review, which would move your checkout out from under you
// just for reading. So the panel reads a throwaway worktree at the same commit
// unless told otherwise, and it is removed afterwards.
let workspaceRoot = WORKSPACE ? path.resolve(WORKSPACE) : '';
let temporary = '';
if (!workspaceRoot) {
    temporary = path.join(path.dirname(ROOT), `.${path.basename(ROOT)}-review-${Date.now()}`);
    git('worktree', 'add', '--detach', temporary, 'HEAD');
    workspaceRoot = temporary;
    console.log(`Worktree      : ${temporary}`);
}

const { chat } = await api('POST', '/v1/multiai/chats', {
    title: `Review · ${t.label}`,
    agents: panel,
    discussMode: 'discuss',
    rounds: ROUNDS,
    brevity: 'as long as needed',
    contextMode: 'bounded',
    independentRounds: 'all',
    stopWhenAllAgree: true,
    workspace: { root: workspaceRoot },
});
console.log(`\nChat ${chat.id} created. Watch it in the Multi-AI tab.`);

let messages = [];
try {
    ({ messages } = await api('POST', `/v1/multiai/chats/${chat.id}/run`, { text: prompt, who: 'You', rounds: ROUNDS, wait: true }));
} finally {
    // Even on a failed run: a worktree left behind is a second checkout of the
    // repo that git will keep reporting until someone prunes it.
    if (temporary) { try { git('worktree', 'remove', '--force', temporary); } catch { /* prune later */ } }
}
const replies = (messages || []).filter(m => m.role === 'assistant');
console.log(`Done: ${replies.length} replies.`);

if (OUT) {
    const md = [`# Review · ${t.label}`, '', ...replies.map(m => `## ${m.who}${m.model ? ` (${m.model})` : ''}\n\n${m.text}\n`)].join('\n');
    fs.mkdirSync(path.dirname(path.resolve(ROOT, OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, OUT), md, 'utf8');
    console.log(`Written to ${OUT}`);
}
