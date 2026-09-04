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

// Make the workspace ready for a run: must be a git repo; switches to the
// chat's branch (created from the current HEAD the first time). Uncommitted
// changes on another branch are the user's — refuse rather than sweep them
// into the chat's branch; leftovers on our own branch (an interrupted writer
// turn) are committed as WIP.
async function prepare(root, branch) {
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
        const exists = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
        const r = await git(root, exists ? ['checkout', branch] : ['checkout', '-b', branch]);
        if (!r.ok) return { ok: false, error: `Could not switch to branch ${branch}: ${r.error}` };
        return { ok: true, branch, created: !exists, from: cur, head: await head(root) };
    }
    let wip = null;
    if (dirty) {
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

module.exports = { TOOLS_LEVELS, DIFF_LIMIT, git, branchFor, isRepo, head, currentBranch, isDirty, prepare, commitAll, describeChange };
