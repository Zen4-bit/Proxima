// Proxima — Local CLI providers for Multi-AI Chat.
// Runs a discussion turn through a locally installed, subscription-authenticated
// CLI instead of a browser tab or an API key:
//   - claude-cli → Claude Code:  claude -p --model <alias> --effort <level> …
//   - codex-cli  → Codex:        codex exec -m <model> -c model_reasoning_effort=<level> …
// Each call is one-shot, tool-less (as far as the CLI allows), runs in an
// empty scratch folder so no CLAUDE.md / AGENTS.md is picked up, and reads the
// prompt from stdin so long transcripts are fine on Windows. Concurrency per
// CLI is capped (protects the 5-hour usage windows). Calls are abortable:
// abort() kills the process tree.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PARALLEL = { claude: 2, codex: 2 };

const EFFORT_MAP = {
    claude: { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    codex: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
};

const DISCUSSION_SYSTEM_PROMPT =
    'You are one participant in a multi-agent discussion run through a local chat app. You have no tools and no ' +
    'filesystem; reply in plain text (light Markdown is fine). Follow the persona and instructions given in the user ' +
    'message. Do not narrate what you would do with tools; say what you think. Never run commands.';

// ---- availability ----------------------------------------------------------

const _avail = {};
function which(bin) {
    if (_avail[bin] !== undefined) return _avail[bin];
    try {
        const out = execFileSync(IS_WIN ? 'where' : 'which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
        const first = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] || null;
        _avail[bin] = first;
    } catch {
        _avail[bin] = null;
    }
    return _avail[bin];
}

function availability() {
    return {
        claude: !!which('claude'),
        codex: !!which('codex'),
    };
}

function resetAvailabilityCache() {
    for (const k of Object.keys(_avail)) delete _avail[k];
}

// ---- concurrency ----------------------------------------------------------

const _running = { claude: 0, codex: 0 };
const _waiters = { claude: [], codex: [] };

function acquire(kind) {
    if (_running[kind] < (MAX_PARALLEL[kind] || 2)) { _running[kind]++; return Promise.resolve(); }
    return new Promise(res => _waiters[kind].push(res)).then(() => { _running[kind]++; });
}

function release(kind) {
    _running[kind] = Math.max(0, _running[kind] - 1);
    const next = _waiters[kind].shift();
    if (next) next();
}

// ---- process helpers ------------------------------------------------------

function scratchDir(base) {
    const dir = path.join(base || os.tmpdir(), 'multiai-cli');
    fs.mkdirSync(dir, { recursive: true });
    const empty = path.join(dir, 'mcp_empty.json');
    if (!fs.existsSync(empty)) fs.writeFileSync(empty, '{"mcpServers":{}}', 'utf-8');
    return dir;
}

function killTree(child) {
    if (!child || child.killed) return;
    try {
        if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        else child.kill('SIGKILL');
    } catch { /* ignore */ }
}

// Windows needs a shell to run the npm .cmd/.ps1 shims (claude); quote args.
function spawnCli(bin, args, cwd) {
    if (IS_WIN) {
        const q = (a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
        return spawn(`${bin} ${args.map(q).join(' ')}`, { cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    return spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

// Runs a process with the prompt on stdin. Returns { promise, abort }.
function runProcess(kind, bin, args, { cwd, prompt, timeoutMs }) {
    let child = null;
    let aborted = false;
    let timer = null;
    const promise = (async () => {
        await acquire(kind);
        if (aborted) { release(kind); throw Object.assign(new Error('Cancelled by user'), { cancelled: true }); }
        try {
            return await new Promise((resolve, reject) => {
                child = spawnCli(bin, args, cwd);
                let stdout = '';
                let stderr = '';
                child.stdout.on('data', d => { stdout += d.toString('utf8'); });
                child.stderr.on('data', d => { stderr += d.toString('utf8'); if (stderr.length > 200000) stderr = stderr.slice(-100000); });
                child.on('error', reject);
                child.on('close', (code) => {
                    if (timer) clearTimeout(timer);
                    if (aborted) return reject(Object.assign(new Error('Cancelled by user'), { cancelled: true }));
                    resolve({ code, stdout, stderr });
                });
                timer = setTimeout(() => { aborted = true; killTree(child); reject(new Error(`${bin} timed out after ${Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`)); }, timeoutMs || DEFAULT_TIMEOUT_MS);
                try {
                    child.stdin.on('error', () => { /* EPIPE when the CLI exits early — the exit code will explain */ });
                    child.stdin.write(prompt, 'utf8');
                    child.stdin.end();
                } catch (e) { reject(e); }
            });
        } finally {
            release(kind);
        }
    })();
    return {
        promise,
        abort() { aborted = true; if (child) killTree(child); },
    };
}

function tailOf(s, n = 600) {
    const t = String(s || '').trim();
    return t.length > n ? '…' + t.slice(-n) : t;
}

// ---- Claude Code ------------------------------------------------------------

function runClaude({ model, effort, prompt, systemPrompt, cwd, timeoutMs }) {
    const dir = scratchDir(cwd);
    const sysFile = path.join(dir, `system-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(sysFile, systemPrompt || DISCUSSION_SYSTEM_PROMPT, 'utf-8');
    const args = ['-p', '--output-format', 'json', '--disallowedTools', '*', '--permission-mode', 'dontAsk',
        '--strict-mcp-config', '--mcp-config', path.join(dir, 'mcp_empty.json'), '--max-turns', '3', '--system-prompt-file', sysFile];
    if (model) args.push('--model', String(model));
    const eff = effort && EFFORT_MAP.claude[effort];
    if (eff) args.push('--effort', eff);
    const run = runProcess('claude', 'claude', args, { cwd: dir, prompt, timeoutMs });
    const promise = run.promise.then(({ code, stdout, stderr }) => {
        try { fs.unlinkSync(sysFile); } catch { /* ignore */ }
        let parsed = null;
        const text = stdout.trim();
        try { parsed = JSON.parse(text); } catch {
            // Sometimes the JSON is preceded by log lines: take the last {...} block.
            const i = text.lastIndexOf('\n{');
            if (i !== -1) { try { parsed = JSON.parse(text.slice(i + 1)); } catch { /* ignore */ } }
        }
        if (parsed && typeof parsed === 'object') {
            if (parsed.is_error || parsed.subtype === 'error' || (parsed.subtype && /error/.test(parsed.subtype) && !parsed.result)) {
                throw new Error(`Claude Code: ${parsed.result || parsed.error || parsed.subtype || 'error'}`);
            }
            const result = typeof parsed.result === 'string' ? parsed.result : (parsed.result && parsed.result.text) || '';
            if (!result.trim()) throw new Error(`Claude Code returned no text (subtype ${parsed.subtype || '?'})`);
            return { text: result, model: parsed.model || model || null, sessionId: parsed.session_id || null, costUsd: parsed.total_cost_usd || null };
        }
        if (code !== 0) throw new Error(`Claude Code exited ${code}: ${tailOf(stderr || stdout)}`);
        if (!text) throw new Error('Claude Code returned no output');
        return { text, model: model || null };
    });
    return { promise, abort: run.abort };
}

// ---- Codex --------------------------------------------------------------------

function runCodex({ model, effort, prompt, systemPrompt, cwd, timeoutMs }) {
    const dir = scratchDir(cwd);
    const outFile = path.join(dir, `codex-last-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
    // No "no tools" switch exists for codex exec; the sandbox helper is also
    // missing on some Windows installs, so approvals/sandbox are bypassed and
    // the scratch folder is empty. The system prompt tells the model not to
    // run anything; it is prepended because exec has no system-prompt flag.
    const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', dir, '--output-last-message', outFile];
    if (model) args.push('-m', String(model));
    const eff = effort && EFFORT_MAP.codex[effort];
    if (eff) args.push('-c', `model_reasoning_effort=${eff}`);
    const full = `${systemPrompt || DISCUSSION_SYSTEM_PROMPT}\n\n${prompt}`;
    const run = runProcess('codex', 'codex', args, { cwd: dir, prompt: full, timeoutMs });
    const promise = run.promise.then(({ code, stdout, stderr }) => {
        let text = '';
        try { text = fs.readFileSync(outFile, 'utf8').trim(); fs.unlinkSync(outFile); } catch { /* no file */ }
        if (!text) {
            const all = `${stdout}\n${stderr}`;
            const m = /"type":"error"[^\n]*"message":"((?:[^"\\]|\\.)*)"/.exec(all);
            const why = m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : tailOf(stderr || stdout);
            throw new Error(`Codex${code ? ` exited ${code}` : ''}: ${why || 'no output'}`);
        }
        return { text, model: model || null };
    });
    return { promise, abort: run.abort };
}

function run(provider, opts) {
    const base = String(provider || '').split(':')[0];
    if (base === 'claude-cli') return runClaude(opts);
    if (base === 'codex-cli') return runCodex(opts);
    return { promise: Promise.reject(new Error(`Unknown CLI provider: ${provider}`)), abort() { } };
}

module.exports = { run, runClaude, runCodex, availability, resetAvailabilityCache, which, EFFORT_MAP, DISCUSSION_SYSTEM_PROMPT, MAX_PARALLEL };
