// Proxima — workspace (git folder for CLI seats with tools) tests.
// Runs real git in temp repos: branch naming, prepare() guards, per-turn
// commits and the change description shown to the other participants.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ws = require('../../../electron/providers/workspace.cjs');

const gitOk = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const git = (root, args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function repo({ commit = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiai-ws-'));
    git(root, ['init', '-q']);
    git(root, ['checkout', '-q', '-b', 'main']);
    if (commit) {
        fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'initial', '--no-verify']);
    }
    return root;
}

test('branchFor derives a stable, git-safe branch name from the chat id', () => {
    assert.equal(ws.branchFor('chat_1725000000000_ab12cd'), 'multiai/0000000-ab12cd', 'last 14 chars of the id, separators dashed');
    assert.equal(ws.branchFor('chat_1725000000000_ab12cd'), ws.branchFor('chat_1725000000000_ab12cd'));
    assert.equal(ws.branchFor(''), 'multiai/chat');
    assert.ok(!/[^a-z0-9/-]/i.test(ws.branchFor('weird id!! with spaces')));
    assert.equal(ws.TOOLS_LEVELS.join(','), 'none,read,write,full');
});

test('prepare: refuses a missing folder and a plain (non-git) folder', { skip: !gitOk && 'git not installed' }, async () => {
    const r1 = await ws.prepare('', 'multiai/x');
    assert.equal(r1.ok, false);
    const r2 = await ws.prepare(path.join(os.tmpdir(), 'does-not-exist-' + Date.now()), 'multiai/x');
    assert.match(r2.error, /does not exist/);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'multiai-plain-'));
    const r3 = await ws.prepare(plain, 'multiai/x');
    assert.equal(r3.ok, false);
    assert.match(r3.error, /git repository/);
    assert.equal(await ws.isRepo(plain), false);
});

test('prepare: creates the chat branch from HEAD, is idempotent, and seeds an empty repo with an initial commit', { skip: !gitOk && 'git not installed' }, async () => {
    const root = repo();
    const base = git(root, ['rev-parse', 'HEAD']);
    const r = await ws.prepare(root, 'multiai/abc');
    assert.deepEqual([r.ok, r.branch, r.created, r.from], [true, 'multiai/abc', true, 'main']);
    assert.equal(await ws.currentBranch(root), 'multiai/abc');
    assert.equal(r.head, base, 'the branch starts where the folder was');
    const again = await ws.prepare(root, 'multiai/abc');
    assert.deepEqual([again.ok, again.created, again.wip], [true, false, null]);

    // switching back to main and preparing again re-uses the existing branch
    git(root, ['checkout', '-q', 'main']);
    const third = await ws.prepare(root, 'multiai/abc');
    assert.deepEqual([third.ok, third.created, third.from], [true, false, 'main']);

    const empty = repo({ commit: false });
    const e = await ws.prepare(empty, 'multiai/new');
    assert.equal(e.ok, true, e.error);
    assert.ok(await ws.head(empty), 'an initial commit exists now');
    assert.equal(await ws.currentBranch(empty), 'multiai/new');
});

test('prepare: refuses to move uncommitted work from another branch, but commits leftovers on its own branch as WIP', { skip: !gitOk && 'git not installed' }, async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, 'notes.txt'), 'mine\n');
    const r = await ws.prepare(root, 'multiai/abc');
    assert.equal(r.ok, false);
    assert.match(r.error, /uncommitted changes on branch "main"/);
    assert.equal(await ws.currentBranch(root), 'main', 'nothing was switched');
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf-8'), 'mine\n', 'the file is untouched');

    git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'mine', '--no-verify']);
    assert.equal((await ws.prepare(root, 'multiai/abc')).ok, true);

    // A run leaves the folder on the chat's branch, so the user's next piece of
    // work lands here too. Leftovers are only committed as "an interrupted
    // turn" when a writer turn really was interrupted — which is what `pending`
    // records. Without that marker they are the user's and the run refuses.
    fs.writeFileSync(path.join(root, 'half.txt'), 'interrupted turn\n');
    const unclaimed = await ws.prepare(root, 'multiai/abc');
    assert.equal(unclaimed.ok, false, 'work Proxima did not make is not swept up');
    assert.match(unclaimed.error, /Proxima did not make/);
    assert.equal(await ws.isDirty(root), true, 'and it is still there');

    const pending = { head: await ws.head(root), agent: 'A', at: Date.now() };
    const wip = await ws.prepare(root, 'multiai/abc', { pending });
    assert.equal(wip.ok, true);
    assert.ok(wip.wip, 'leftovers from a turn we started are committed');
    assert.equal(await ws.isDirty(root), false);
    assert.match(git(root, ['log', '-1', '--format=%s']), /WIP left by an interrupted turn/);

    // A stale marker from before some other commit does not license a sweep.
    fs.writeFileSync(path.join(root, 'later.txt'), 'user work\n');
    const stale = await ws.prepare(root, 'multiai/abc', { pending });
    assert.equal(stale.ok, false, 'the marker must match the current HEAD');
});

test('inspect: warns about uncommitted changes on the chat\'s own branch, not just another branch', { skip: !gitOk && 'git not installed' }, async () => {
    const root = repo();
    assert.equal((await ws.prepare(root, 'multiai/abc')).ok, true);
    assert.equal((await ws.inspect(root, 'multiai/abc')).warning, undefined, 'clean tree, nothing to say');
    fs.writeFileSync(path.join(root, 'mine.txt'), 'still working\n');
    const info = await ws.inspect(root, 'multiai/abc');
    assert.equal(info.dirty, true);
    assert.match(info.warning, /this chat's own branch/, 'the likelier dirty case used to be silent');
});

test('commitAll: commits everything under the Proxima identity and reports files, stat and a bounded patch', { skip: !gitOk && 'git not installed' }, async () => {
    const root = repo();
    await ws.prepare(root, 'multiai/abc');
    assert.deepEqual(await ws.commitAll(root, 'nothing'), { committed: false }, 'a clean tree commits nothing');

    fs.appendFileSync(path.join(root, 'README.md'), 'world\n');
    fs.writeFileSync(path.join(root, 'src.js'), 'x'.repeat(20000) + '\n');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'new.txt'), 'new\n');
    const c = await ws.commitAll(root, 'Writer [0101WR]');
    assert.equal(c.committed, true);
    assert.equal(c.short, c.hash.slice(0, 8));
    assert.deepEqual(c.files.map(f => `${f.status} ${f.path}`).sort(), ['A src.js', 'A sub/new.txt', 'M README.md']);
    assert.match(c.stat, /3 files changed/);
    assert.ok(c.patch.includes('+world'));
    assert.equal(c.truncated, true, 'a huge patch is cut for the transcript');
    assert.ok(c.patch.length <= ws.DIFF_LIMIT + 40 && /diff truncated/.test(c.patch));
    assert.match(git(root, ['log', '-1', '--format=%an <%ae> %s']), /^Proxima Multi-AI <multiai@proxima\.local> Writer \[0101WR\]$/);
    assert.equal(await ws.isDirty(root), false);
    assert.equal(git(root, ['rev-parse', 'main']) !== c.hash, true, 'main did not move');

    const text = ws.describeChange('Writer', c);
    assert.match(text, /^Writer changed 3 files \(commit [0-9a-f]{8}\):\n/);
    assert.ok(text.includes('```diff\n') && text.trimEnd().endsWith('```'));
    assert.equal(ws.describeChange('Writer', { committed: false }), null);
});

test('fresh start: a new chat branch is cut from the base branch, never from another chat\'s branch; inspect() says so up front', { skip: !gitOk && 'git not installed' }, async () => {
    const root = repo();
    // chat A works and leaves the folder on its branch with an extra file
    assert.equal((await ws.prepare(root, 'multiai/chat-a')).ok, true);
    fs.writeFileSync(path.join(root, 'a.txt'), 'from chat A\n');
    assert.equal((await ws.commitAll(root, 'A [0101AA]')).committed, true);
    assert.equal(await ws.currentBranch(root), 'multiai/chat-a');

    // what chat B would see before running
    const before = await ws.inspect(root, 'multiai/chat-b');
    assert.deepEqual([before.ok, before.isRepo, before.branch, before.dirty, before.chatBranchExists, before.base], [true, true, 'multiai/chat-a', false, false, 'main']);
    assert.equal(await ws.baseBranch(root), 'main');

    // chat B starts from main: no a.txt
    const r = await ws.prepare(root, 'multiai/chat-b');
    assert.deepEqual([r.ok, r.created, r.from], [true, true, 'main']);
    assert.equal(await ws.currentBranch(root), 'multiai/chat-b');
    assert.equal(fs.existsSync(path.join(root, 'a.txt')), false, 'chat A\'s work is not carried over');
    assert.equal(git(root, ['rev-parse', 'multiai/chat-b']), git(root, ['rev-parse', 'main']));

    // a folder parked on a user branch (not multiai/*) is the base itself
    git(root, ['checkout', '-q', '-b', 'feature-x', 'main']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'feature\n'); git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'feature', '--no-verify']);
    assert.equal(await ws.baseBranch(root), 'feature-x');
    const c = await ws.prepare(root, 'multiai/chat-c');
    assert.deepEqual([c.created, c.from], [true, 'feature-x']);
    assert.ok(fs.existsSync(path.join(root, 'f.txt')));

    // inspect: existing chat branch, dirty folder elsewhere → warning, no base needed
    git(root, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'x\n');
    const insp = await ws.inspect(root, 'multiai/chat-a');
    assert.deepEqual([insp.branch, insp.dirty, insp.chatBranchExists, insp.base], ['main', true, true, null]);
    assert.match(insp.warning, /Uncommitted changes on "main"/);
    assert.equal((await ws.inspect(path.join(os.tmpdir(), 'nope-' + Date.now()), 'multiai/x')).exists, false);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'multiai-plain-'));
    assert.deepEqual([(await ws.inspect(plain, 'multiai/x')).isRepo, (await ws.inspect(plain, 'multiai/x')).ok], [false, false]);
});

test('baseBranch: master and "first non-chat branch" fallbacks; a repo whose only branch is a chat branch', { skip: !gitOk && 'git not installed' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiai-ws-'));
    git(root, ['init', '-q']); git(root, ['checkout', '-q', '-b', 'master']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hi\n'); git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'init', '--no-verify']);
    git(root, ['checkout', '-q', '-b', 'multiai/old']);
    assert.equal(await ws.baseBranch(root), 'master');
    git(root, ['branch', '-m', 'master', 'trunk']);
    assert.equal(await ws.baseBranch(root), 'trunk', 'no main/master → the first branch that is not a chat branch');
    git(root, ['branch', '-D', 'trunk']);
    assert.equal(await ws.baseBranch(root), 'multiai/old', 'nothing else exists → the current branch, rather than failing');
});
