// Proxima — Workspace: a git folder that CLI seats may read or edit.
// Every writer turn is committed on a chat-specific branch and shown to the
// other participants as a diff, so "modify files" stays reviewable and
// reversible. Plain Node (no Electron) — shared by the app and tests.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOOLS_LEVELS = ['none', 'read', 'write', 'full'];
const DIFF_LIMIT = 12000;          // chars of patch shown in the transcript
const GIT_TIMEOUT_MS = 30000;
// Commits are made under the app's own identity, so they work on machines with
// no global git user configured and are easy to tell apart in the log.
const IDENTITY = ['-c', 'user.name=Proxima Multi-AI', '-c', 'user.email=multiai@proxima.local'];

function git(root, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd: root, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? (String(stderr || '').trim() || err.message) : null });
        });
    });
}

function branchFor(chatId) {
    const tail = String(chatId || '').replace(/^chat_/, '').replace(/[^a-z0-9]+/gi, '-').slice(-14) || 'chat';
    return `multiai/${tail}`;
}

async function isRepo(root) {
    if (!root || !fs.existsSync(root)) return false;
    const r = await git(root, ['rev-parse', '--is-inside-work-tree']);
    return r.ok && r.stdout.trim() === 'true';
}

async function head(root) {
    const r = await git(root, ['rev-parse', 'HEAD']);
    return r.ok ? r.stdout.trim() : null;
}

async function currentBranch(root) {
    const r = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return r.ok ? r.stdout.trim() : null;
}

async function isDirty(root) {
    const r = await git(root, ['status', '--porcelain']);
    return r.ok && r.stdout.trim().length > 0;
}

const CHAT_BRANCH_RE = /^multiai\//;

async function branchExists(root, name) {
    return (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok;
}

// The branch a *new* chat branch starts from — a fresh start every time:
// the folder's own branch if it is on one (main, master, feature-x…), else,
// when it is parked on another chat's multiai/* branch, the repo's base
// branch: origin's default, then main, then master, then the first local
// branch that is not a chat branch. Never another chat's branch.
async function baseBranch(root) {
    const cur = await currentBranch(root);
    if (cur && cur !== 'HEAD' && !CHAT_BRANCH_RE.test(cur)) return cur;
    const origin = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (origin.ok) {
        const name = origin.stdout.trim().replace(/^origin\//, '');
        if (name && await branchExists(root, name)) return name;
    }
    for (const name of ['main', 'master']) if (await branchExists(root, name)) return name;
    const list = await git(root, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads/']);
    const first = list.ok ? list.stdout.split(/\r?\n/).map(x => x.trim()).filter(x => x && !CHAT_BRANCH_RE.test(x))[0] : null;
    return first || cur || 'HEAD';
}

// What the Workspace tab shows before any run: is it a repo, where is it,
// is it clean, and where would this chat's branch start.
async function inspect(root, branch) {
    if (!root) return { ok: false, error: 'No workspace folder chosen.' };
    if (!fs.existsSync(root)) return { ok: false, exists: false, error: `Folder does not exist: ${root}` };
    if (!(await isRepo(root))) return { ok: false, exists: true, isRepo: false, error: 'Not a git repository — run `git init` there first.' };
    const cur = await currentBranch(root);
    const dirty = await isDirty(root);
    const exists = branch ? await branchExists(root, branch) : false;
    const base = exists ? null : await baseBranch(root);
    const out = { ok: true, exists: true, isRepo: true, branch: cur, dirty, chatBranch: branch || null, chatBranchExists: exists, base, head: await head(root) };
    if (dirty && cur !== branch) out.warning = `Uncommitted changes on "${cur}" — commit or stash them before running, Proxima will not touch them.`;
    // The other dirty case used to be silent, and it is the more likely one:
    // a run leaves the folder checked out on the chat's branch, so the user's
    // next piece of work lands there. Say what will happen to it.
    else if (dirty && cur === branch) out.warning = `Uncommitted changes on this chat's own branch "${cur}". If Proxima left them behind mid-turn it will commit them as WIP on the next run; if they are yours, commit or stash them first.`;
    return out;
}

// Make the workspace ready for a run: must be a git repo; switches to the
// chat's branch, created from the base branch (see baseBranch) the first
// time — a fresh start, never another chat's leftovers.
//
// Uncommitted changes are only ever committed as "WIP left by an interrupted
// turn" when they really could be that. `pending` is the marker a writer turn
// sets before it starts and clears once it has committed, carrying the HEAD it
// saw; if it is present and still matches HEAD, an interrupted turn is the
// explanation and the leftovers are ours to commit. Without it the changes are
// the user's — the run refuses rather than committing their work under the
// app's identity with --no-verify. This matters because a run deliberately
// leaves the folder on the chat's branch, so the user's later work lands
// exactly here.
async function prepare(root, branch, { pending = null } = {}) {
    if (!root) return { ok: false, error: 'No workspace folder chosen.' };
    if (!fs.existsSync(root)) return { ok: false, error: `Workspace folder does not exist: ${root}` };
    if (!(await isRepo(root))) return { ok: false, error: `Workspace must be a git repository (run \`git init\` in ${root}) so every turn is committed and diffable.` };
    const noCommits = !(await head(root));
    if (noCommits) {
        const r = await git(root, [...IDENTITY, 'commit', '--allow-empty', '-m', 'multiai: initial commit', '--no-verify']);
        if (!r.ok) return { ok: false, error: `Could not create an initial commit: ${r.error}` };
    }
    const cur = await currentBranch(root);
    const dirty = await isDirty(root);
    if (cur !== branch) {
        if (dirty) return { ok: false, error: `Workspace has uncommitted changes on branch "${cur}". Commit or stash them first — Proxima only edits on its own branch (${branch}).` };
        const exists = await branchExists(root, branch);
        const from = exists ? cur : await baseBranch(root);
        const r = await git(root, exists ? ['checkout', branch] : ['checkout', '-b', branch, from]);
        if (!r.ok) return { ok: false, error: `Could not switch to branch ${branch}: ${r.error}` };
        return { ok: true, branch, created: !exists, from, head: await head(root) };
    }
    let wip = null;
    if (dirty) {
        const at = await head(root);
        const ours = pending && pending.head && pending.head === at;
        if (!ours) {
            return {
                ok: false,
                error: `Uncommitted changes on this chat's branch "${branch}" that Proxima did not make. `
                    + 'A run leaves the folder on this branch, so these are probably yours — commit or stash them first.',
            };
        }
        const c = await commitAll(root, 'multiai: WIP left by an interrupted turn');
        wip = c.committed ? c.hash : null;
    }
    return { ok: true, branch, created: false, from: cur, head: await head(root), wip };
}

// Commit everything changed in the working tree; returns what changed.
async function commitAll(root, message) {
    if (!(await isDirty(root))) return { committed: false };
    const add = await git(root, ['add', '-A']);
    if (!add.ok) return { committed: false, error: add.error };
    const c = await git(root, [...IDENTITY, 'commit', '-q', '-m', message, '--no-verify']);
    if (!c.ok) return { committed: false, error: c.error };
    const hash = await head(root);
    const stat = (await git(root, ['show', '--stat', '--format=', 'HEAD'])).stdout.trim();
    const filesOut = (await git(root, ['show', '--name-status', '--format=', 'HEAD'])).stdout.trim();
    const files = filesOut.split(/\r?\n/).filter(Boolean).map(l => { const [status, ...rest] = l.split(/\t/); return { status, path: rest.join('\t') }; });
    let patch = (await git(root, ['show', '--format=', '--no-color', 'HEAD'])).stdout;
    let truncated = false;
    if (patch.length > DIFF_LIMIT) { patch = patch.slice(0, DIFF_LIMIT) + '\n… (diff truncated)'; truncated = true; }
    return { committed: true, hash, short: hash ? hash.slice(0, 8) : '', stat, files, patch, truncated };
}

// Text shown to the other participants for one writer turn.
function describeChange(agentName, change) {
    if (!change || !change.committed) return null;
    const head = `${agentName} changed ${change.files.length} file${change.files.length === 1 ? '' : 's'} (commit ${change.short}):\n${change.stat}`;
    return `${head}\n\n\`\`\`diff\n${change.patch.trim()}\n\`\`\``;
}

module.exports = { TOOLS_LEVELS, DIFF_LIMIT, git, branchFor, isRepo, head, currentBranch, isDirty, branchExists, baseBranch, inspect, prepare, commitAll, describeChange };
