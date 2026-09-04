// Proxima — Local CLI providers for Multi-AI Chat.
// Runs a discussion turn through a locally installed, subscription-authenticated
// CLI instead of a browser tab or an API key:
//   - claude-cli → Claude Code:  claude -p --model <alias> --effort <level> …
//   - codex-cli  → Codex:        codex exec -m <model> -c model_reasoning_effort=<level> …
//   - gemini-cli → Gemini CLI:   gemini -p … -m <model> -o json --approval-mode plan
// Each call is one-shot, tool-less (as far as the CLI allows), runs in an
// empty scratch folder so no CLAUDE.md / AGENTS.md is picked up, and reads the
// prompt from stdin so long transcripts are fine on Windows. Concurrency per
// CLI is capped (protects the 5-hour usage windows). Calls are abortable:
// abort() kills the process tree.
//
// discover() pulls what each CLI actually offers on this machine — version,
// the models ("variants") and effort levels it accepts, its configured
// defaults, and whether it is logged in — so the agent editor can offer real
// choices instead of a hard-coded list:
//   - Claude Code: `--effort` levels and model aliases parsed from `claude --help`;
//   - Codex: the account's model list from ~/.codex/models_cache.json (slug,
//     display name, supported reasoning levels, default level) and the
//     defaults / [profiles.*] from ~/.codex/config.toml;
//   - Gemini CLI: version and the auth method from ~/.gemini/settings.json.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PARALLEL = { claude: 2, codex: 2, gemini: 2 };

const KINDS = { 'claude-cli': 'claude', 'codex-cli': 'codex', 'gemini-cli': 'gemini' };
const BINS = { claude: 'claude', codex: 'codex', gemini: 'gemini' };
const LABELS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };

const EFFORT_MAP = {
    claude: { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    codex: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
    gemini: {},   // the CLI has no effort switch
};
const CLAUDE_KNOWN_ALIASES = ['opus', 'sonnet', 'haiku'];

const DISCUSSION_SYSTEM_PROMPT =
    'You are one participant in a multi-agent discussion run through a local chat app. You have no tools and no ' +
    'filesystem; reply in plain text (light Markdown is fine). Follow the persona and instructions given in the user ' +
    'message. Do not narrate what you would do with tools; say what you think. Never run commands.';

// Workspace seats: the CLI runs inside a git folder with real tools.
const TOOLS_LEVELS = ['none', 'read', 'write', 'full'];
function workspaceSystemPrompt({ root, branch, tools }) {
    const base = 'You are one participant in a multi-agent discussion run through a local chat app, and you are running inside ' +
        `the shared workspace ${root} (git branch ${branch || 'multiai'}). Reply in plain text (light Markdown is fine); ` +
        'follow the persona and instructions given in the user message. ';
    if (tools === 'read') {
        return base + 'You have READ-ONLY tools: read, list and search files to verify claims and ground your points, and cite paths. ' +
            'Do not try to edit files or run commands that change anything.';
    }
    return base + 'You have file tools' + (tools === 'full' ? ' and a shell' : '') + '. When the discussion calls for it, make the change directly in the files: ' +
        'keep it minimal and focused, do not touch unrelated files, do not commit (your turn is committed automatically and ' +
        'shown to the others as a diff), and finish with a short report of exactly what you changed and why. If nothing should ' +
        'change yet, say so and discuss instead.';
}

const CLAUDE_TOOLS = {
    read: 'Read,Glob,Grep,LS',
    write: 'Read,Glob,Grep,LS,Edit,MultiEdit,Write,NotebookEdit,Bash(git status*),Bash(git diff*),Bash(git log*)',
};

// ---- availability ----------------------------------------------------------

// Environment for child processes. MCP clients often spawn servers with a
// trimmed environment (the MCP SDK keeps PATH but drops PATHEXT), and without
// PATHEXT `where codex` cannot match codex.exe and cmd.exe cannot run .cmd
// shims by bare name — so PATHEXT is restored when missing.
function childEnv(bin) {
    const env = Object.assign({}, process.env);
    if (IS_WIN && !env.PATHEXT) env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1';
    // Codex's Windows sandbox (--sandbox read-only / workspace-write) spawns
    // codex-windows-sandbox-setup.exe by name. The desktop app installs it
    // under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\ but not on PATH, so a
    // codex.exe launched from here reports "program not found" and the seat
    // gets no tools. Put the newest helper folder on the child's PATH.
    if (IS_WIN && bin === 'codex') {
        const dir = codexSandboxHelperDir();
        if (dir && !String(env.PATH || env.Path || '').toLowerCase().includes(dir.toLowerCase())) {
            const key = 'PATH' in env ? 'PATH' : ('Path' in env ? 'Path' : 'PATH');
            env[key] = `${dir};${env[key] || ''}`;
        }
    }
    return env;
}

// Codex's Windows sandbox needs two helpers next to codex.exe:
// codex-windows-sandbox-setup.exe and codex-command-runner.exe. The
// standalone CLI installer ships without them; the Codex desktop app bundles
// a complete set (codex.exe + helpers) under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\.
const CODEX_HELPERS = ['codex-windows-sandbox-setup.exe', 'codex-command-runner.exe'];
function hasCodexHelpers(dir) {
    try { return !!dir && CODEX_HELPERS.every(f => fs.existsSync(path.join(dir, f))); } catch { return false; }
}

// Newest desktop-app bundle folder (codex.exe + both helpers), or null.
let _codexBundleCache;
function codexSandboxBundle({ force = false } = {}) {
    if (!IS_WIN) return null;
    if (_codexBundleCache !== undefined && !force) return _codexBundleCache;
    _codexBundleCache = null;
    try {
        const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const bin = path.join(local, 'OpenAI', 'Codex', 'bin');
        const found = fs.readdirSync(bin, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => path.join(bin, d.name))
            .filter(d => hasCodexHelpers(d) && fs.existsSync(path.join(d, 'codex.exe')))
            .map(d => ({ d, t: fs.statSync(path.join(d, 'codex.exe')).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        if (found.length) _codexBundleCache = { dir: found[0].d, exe: path.join(found[0].d, 'codex.exe') };
    } catch { /* no desktop app install */ }
    return _codexBundleCache;
}
function codexSandboxHelperDir(opts) { const b = codexSandboxBundle(opts); return b ? b.dir : null; }

// How a sandboxed (read/write) Codex turn can run on this machine:
//   native  — the codex on PATH has its helpers (or not Windows)
//   bundle  — run the desktop app's bundled codex.exe instead
//   missing — neither; read/write cannot be enforced (full still works)
function codexSandboxSupport({ force = false } = {}) {
    if (!IS_WIN) return { mode: 'native', exe: null };
    const exe = which('codex');
    if (exe && hasCodexHelpers(path.dirname(exe))) return { mode: 'native', exe: null };
    const b = codexSandboxBundle({ force });
    if (b) return { mode: 'bundle', exe: b.exe };
    return { mode: 'missing', exe: null };
}

// Where the CLIs usually live when they are not on PATH at all.
function knownLocations(bin) {
    const home = os.homedir();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const win = {
        claude: [path.join(home, '.local', 'bin', 'claude.exe'), path.join(appData, 'npm', 'claude.cmd')],
        codex: [path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), path.join(appData, 'npm', 'codex.cmd')],
        gemini: [path.join(appData, 'npm', 'gemini.cmd')],
    };
    const nix = {
        claude: [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'],
        codex: [path.join(home, '.local', 'bin', 'codex'), '/usr/local/bin/codex', '/opt/homebrew/bin/codex'],
        gemini: [path.join(home, '.local', 'bin', 'gemini'), '/usr/local/bin/gemini', '/opt/homebrew/bin/gemini'],
    };
    return (IS_WIN ? win : nix)[bin] || [];
}

const _avail = {};
// Resolved path of a CLI (PATH first, then the usual install folders), or null.
function which(bin) {
    if (_avail[bin] !== undefined) return _avail[bin];
    let found = null;
    try {
        const out = execFileSync(IS_WIN ? 'where' : 'which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: childEnv() });
        found = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] || null;
    } catch { found = null; }
    if (!found) found = knownLocations(bin).find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
    _avail[bin] = found;
    return found;
}

function availability() {
    return {
        claude: !!which('claude'),
        codex: !!which('codex'),
        gemini: !!which('gemini'),
    };
}

function resetAvailabilityCache() {
    for (const k of Object.keys(_avail)) delete _avail[k];
    _discovered = null;
}

// ---- discovery ------------------------------------------------------------

function runQuick(bin, args, timeoutMs = 8000) {
    return new Promise((resolve) => {
        let child;
        try { child = spawnCli(bin, args, os.tmpdir()); } catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e.message || e) }); }
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { killTree(child); resolve({ code: -1, stdout, stderr: stderr + '\n(timed out)' }); }, timeoutMs);
        child.stdout.on('data', d => { stdout += d.toString('utf8'); });
        child.stderr.on('data', d => { stderr += d.toString('utf8'); });
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e.message || e) }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        try { child.stdin.end(); } catch { /* ignore */ }
    });
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readText(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// `claude --help` → { efforts: [...], aliases: [...] }. The help text wraps,
// so the description of a flag is everything up to the next flag.
function parseClaudeHelp(text) {
    const t = String(text || '').replace(/\r/g, '');
    const section = (flag) => {
        const m = new RegExp(`\\n\\s+${flag}\\s+<[^>]+>([\\s\\S]*?)(?=\\n\\s+-{1,2}[A-Za-z]|$)`).exec(t);
        return m ? m[1].replace(/\s+/g, ' ') : '';
    };
    const effortSec = section('--effort');
    const em = /\(([a-z][a-z0-9, ]*)\)/i.exec(effortSec);
    const efforts = em ? em[1].split(',').map(x => x.trim()).filter(Boolean) : [];
    const modelSec = section('--model');
    const aliases = [];
    const re = /'([a-z][a-z0-9-]*)'/g;
    let m;
    while ((m = re.exec(modelSec)) !== null) {
        const a = m[1];
        if (!/^claude-/.test(a) && !aliases.includes(a)) aliases.push(a);
    }
    for (const a of CLAUDE_KNOWN_ALIASES) if (!aliases.includes(a)) aliases.push(a);
    return { efforts, aliases };
}

// ~/.codex/models_cache.json → listed models with their reasoning levels.
function parseCodexModelsCache(json) {
    const models = (json && Array.isArray(json.models)) ? json.models : [];
    return models
        .filter(m => m && m.slug && (m.visibility === undefined || m.visibility === 'list'))
        .sort((a, b) => (a.priority || 0) - (b.priority || 0))
        .map(m => ({
            id: m.slug,
            label: m.display_name || m.slug,
            description: m.description || '',
            efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map(l => (typeof l === 'string' ? l : l.effort)).filter(Boolean) : [],
            defaultEffort: m.default_reasoning_level || '',
        }));
}

// ~/.codex/config.toml → top-level model / model_reasoning_effort and any
// [profiles.<name>] with their own model / effort ("variants" by another name).
function parseCodexConfig(toml) {
    const out = { model: '', effort: '', profiles: [] };
    const lines = String(toml || '').replace(/\r/g, '').split('\n');
    let section = '';
    let profile = null;
    const kv = (line) => {
        const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))/.exec(line);
        return m ? { key: m[1], value: m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]) } : null;
    };
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const sec = /^\[([^\]]+)\]$/.exec(line);
        if (sec) {
            section = sec[1].trim();
            const pm = /^profiles\.(.+)$/.exec(section);
            profile = pm ? { name: pm[1].replace(/^"|"$/g, ''), model: '', effort: '' } : null;
            if (profile) out.profiles.push(profile);
            continue;
        }
        const pair = kv(line);
        if (!pair) continue;
        if (!section) {
            if (pair.key === 'model') out.model = pair.value;
            if (pair.key === 'model_reasoning_effort') out.effort = pair.value;
        } else if (profile) {
            if (pair.key === 'model') profile.model = pair.value;
            if (pair.key === 'model_reasoning_effort') profile.effort = pair.value;
        }
    }
    return out;
}

// ~/.gemini/settings.json → is an auth method configured?
function geminiAuthFrom(settings, env) {
    const e = env || process.env;
    if (e.GEMINI_API_KEY || e.GOOGLE_GENAI_USE_VERTEXAI || e.GOOGLE_GENAI_USE_GCA) return 'env';
    const s = settings || {};
    const t = s.selectedAuthType || (s.security && s.security.auth && s.security.auth.selectedType) || (s.auth && s.auth.selectedType) || '';
    return t ? String(t) : '';
}

let _discovered = null;
let _discovering = null;

// What each CLI offers on this machine. Cached; force to re-probe.
async function discover({ force = false } = {}) {
    if (_discovered && !force) return _discovered;
    if (_discovering) return _discovering;
    _discovering = (async () => {
        const home = os.homedir();
        const out = { claude: null, codex: null, gemini: null, at: Date.now() };
        const avail = availability();
        if (avail.claude) {
            const [ver, help] = await Promise.all([runQuick('claude', ['--version']), runQuick('claude', ['--help'])]);
            const parsed = parseClaudeHelp(help.stdout);
            const settings = readJson(path.join(home, '.claude', 'settings.json')) || {};
            out.claude = {
                available: true, label: LABELS.claude,
                version: (ver.stdout.trim().split(/\s+/)[0] || '').trim(),
                efforts: parsed.efforts.length ? parsed.efforts : ['low', 'medium', 'high', 'xhigh', 'max'],
                models: parsed.aliases.map(a => ({ id: a, label: a, efforts: null })),
                defaultModel: settings.model || '',
                defaultEffort: '',
                note: 'Aliases or full model names (claude-…); add [1m] for the 1M-context variant where offered.',
            };
        } else out.claude = { available: false, label: LABELS.claude };
        if (avail.codex) {
            const ver = await runQuick('codex', ['--version']);
            const cache = parseCodexModelsCache(readJson(path.join(home, '.codex', 'models_cache.json')));
            const cfg = parseCodexConfig(readText(path.join(home, '.codex', 'config.toml')));
            const efforts = [];
            cache.forEach(m => m.efforts.forEach(e => { if (!efforts.includes(e)) efforts.push(e); }));
            out.codex = {
                available: true, label: LABELS.codex,
                version: (ver.stdout.trim().replace(/^codex-cli\s*/i, '').split(/\s+/)[0] || '').trim(),
                efforts: efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh'],
                models: cache,
                defaultModel: cfg.model, defaultEffort: cfg.effort,
                profiles: cfg.profiles,
                defaultModelListed: !cfg.model || cache.some(m => m.id === cfg.model),
                // Windows: read/write workspace levels need the sandbox helper
                // (see childEnv); `full` bypasses the sandbox and always works.
                sandbox: codexSandboxSupport({ force: true }).mode,
                sandboxBundle: (() => { const b = codexSandboxBundle(); return b ? b.dir : undefined; })(),
                note: cache.length ? 'Models from your account\'s list (~/.codex/models_cache.json).' : 'No model list cached yet — run codex once.',
            };
        } else out.codex = { available: false, label: LABELS.codex };
        if (avail.gemini) {
            const ver = await runQuick('gemini', ['--version']);
            const settings = readJson(path.join(home, '.gemini', 'settings.json')) || {};
            const auth = geminiAuthFrom(settings);
            out.gemini = {
                available: true, label: LABELS.gemini,
                version: (ver.stdout.trim().split(/\s+/).pop() || '').trim(),
                efforts: [],
                models: [],
                defaultModel: (settings.model && (settings.model.name || settings.model)) || '',
                defaultEffort: '',
                auth,
                loggedIn: !!auth,
                note: auth ? 'Model ids as the CLI accepts them (blank = its default). No effort switch.' : 'Not configured: run `gemini` once and choose a login method (Google account or API key).',
            };
        } else out.gemini = { available: false, label: LABELS.gemini };
        _discovered = out;
        _discovering = null;
        return out;
    })();
    return _discovering;
}

function discovered() { return _discovered; }

// Codex: the effort the model actually supports (falls back to the highest
// supported level when the requested one is above it).
function codexEffortFor(model, effort) {
    const eff = effort && EFFORT_MAP.codex[effort];
    if (!eff) return null;
    const info = _discovered && _discovered.codex && _discovered.codex.models ? _discovered.codex.models.find(m => m.id === model) : null;
    if (!info || !info.efforts.length) return eff;
    if (info.efforts.includes(eff)) return eff;
    const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const want = order.indexOf(eff);
    const supported = info.efforts.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return supported.filter(e => order.indexOf(e) <= want).pop() || supported[0];
}

// ---- concurrency ----------------------------------------------------------

const _running = {};
const _waiters = {};

function acquire(kind) {
    if (_running[kind] === undefined) { _running[kind] = 0; _waiters[kind] = []; }
    if (_running[kind] < (MAX_PARALLEL[kind] || 2)) { _running[kind]++; return Promise.resolve(); }
    return new Promise(res => _waiters[kind].push(res)).then(() => { _running[kind]++; });
}

function release(kind) {
    if (_running[kind] === undefined) return;
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
// The resolved path is used when the binary is not on PATH.
function spawnCli(bin, args, cwd, exeOverride) {
    const exe = exeOverride || which(bin) || bin;
    if (IS_WIN) {
        const q = (a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
        return spawn(`${q(exe)} ${args.map(q).join(' ')}`, { cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(bin) });
    }
    return spawn(exe, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(bin) });
}

// Runs a process with the prompt on stdin. Returns { promise, abort }.
function runProcess(kind, bin, args, { cwd, prompt, timeoutMs, exe }) {
    let child = null;
    let aborted = false;
    let timer = null;
    const promise = (async () => {
        await acquire(kind);
        if (aborted) { release(kind); throw Object.assign(new Error('Cancelled by user'), { cancelled: true }); }
        try {
            return await new Promise((resolve, reject) => {
                child = spawnCli(bin, args, cwd, exe);
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

// Command line for one Claude Code turn. `workspace` = { root, branch, tools }
// puts it inside the folder with the tools that level allows; otherwise it
// runs tool-less in the scratch folder.
function claudeArgs({ model, effort, workspace }, dir, sysFile) {
    const level = workspace && TOOLS_LEVELS.includes(workspace.tools) ? workspace.tools : 'none';
    const args = ['-p', '--output-format', 'json', '--strict-mcp-config', '--mcp-config', path.join(dir, 'mcp_empty.json'), '--system-prompt-file', sysFile];
    if (level === 'none') args.push('--disallowedTools', '*', '--permission-mode', 'dontAsk', '--max-turns', '3');
    else if (level === 'read') args.push('--allowedTools', CLAUDE_TOOLS.read, '--permission-mode', 'dontAsk', '--max-turns', '15');
    else if (level === 'write') args.push('--allowedTools', CLAUDE_TOOLS.write, '--permission-mode', 'acceptEdits', '--max-turns', '30');
    else args.push('--dangerously-skip-permissions', '--max-turns', '40');
    if (model) args.push('--model', String(model));
    const eff = effort && EFFORT_MAP.claude[effort];
    if (eff) args.push('--effort', eff);
    return args;
}

function runClaude({ model, effort, prompt, systemPrompt, cwd, workspace, timeoutMs }) {
    const dir = scratchDir(cwd);
    const level = workspace && workspace.root && workspace.tools && workspace.tools !== 'none' ? workspace.tools : 'none';
    const sysFile = path.join(dir, `system-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(sysFile, systemPrompt || (level !== 'none' ? workspaceSystemPrompt(workspace) : DISCUSSION_SYSTEM_PROMPT), 'utf-8');
    const args = claudeArgs({ model, effort, workspace: level !== 'none' ? workspace : null }, dir, sysFile);
    const run = runProcess('claude', 'claude', args, { cwd: level !== 'none' ? workspace.root : dir, prompt, timeoutMs });
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

// Command line for one Codex turn. Discussion seats: approvals/sandbox
// bypassed in the empty scratch folder (no "no tools" switch exists; the
// sandbox helper is missing on some Windows installs). Workspace seats:
// read → read-only sandbox, write → workspace-write sandbox, full → bypass.
function codexArgs({ model, effort, workspace }, dir, outFile) {
    const level = workspace && TOOLS_LEVELS.includes(workspace.tools) ? workspace.tools : 'none';
    const args = ['exec', '--skip-git-repo-check', '--output-last-message', outFile];
    // `codex exec` is non-interactive (no --ask-for-approval): a command the
    // sandbox blocks simply fails, which is what we want for read/write.
    if (level === 'read') args.push('--sandbox', 'read-only', '-C', workspace.root);
    else if (level === 'write') args.push('--sandbox', 'workspace-write', '-C', workspace.root);
    else if (level === 'full') args.push('--dangerously-bypass-approvals-and-sandbox', '-C', workspace.root);
    else args.push('--dangerously-bypass-approvals-and-sandbox', '-C', dir);
    if (model) args.push('-m', String(model));
    const eff = codexEffortFor(model, effort);
    if (eff) args.push('-c', `model_reasoning_effort=${eff}`);
    return args;
}

function runCodex({ model, effort, prompt, systemPrompt, cwd, workspace, timeoutMs }) {
    const dir = scratchDir(cwd);
    const level = workspace && workspace.root && workspace.tools && workspace.tools !== 'none' ? workspace.tools : 'none';
    const outFile = path.join(dir, `codex-last-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
    const args = codexArgs({ model, effort, workspace: level !== 'none' ? workspace : null }, dir, outFile);
    // The system prompt is prepended because exec has no system-prompt flag.
    const full = `${systemPrompt || (level !== 'none' ? workspaceSystemPrompt(workspace) : DISCUSSION_SYSTEM_PROMPT)}\n\n${prompt}`;
    // read/write rely on Codex's sandbox; on Windows that may only exist in
    // the desktop app's bundled codex.exe (see codexSandboxSupport).
    const sandboxed = level === 'read' || level === 'write';
    const support = sandboxed ? codexSandboxSupport() : null;
    const run = runProcess('codex', 'codex', args, { cwd: level !== 'none' ? workspace.root : dir, prompt: full, timeoutMs, exe: support && support.mode === 'bundle' ? support.exe : undefined });
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

// ---- Gemini CLI ----------------------------------------------------------------

// Command line for one Gemini CLI turn. Headless mode: `-p` is appended to
// whatever arrives on stdin, so the system prompt + transcript go on stdin
// and -p carries the cue. Approval mode is the tools level: plan (read-only),
// auto_edit (write), yolo (full). No effort switch. The workspace folder must
// be trusted in Gemini CLI, or it falls back to prompting and headless
// tool calls are denied.
function geminiArgs({ model, workspace }) {
    const level = workspace && TOOLS_LEVELS.includes(workspace.tools) ? workspace.tools : 'none';
    const mode = level === 'write' ? 'auto_edit' : (level === 'full' ? 'yolo' : 'plan');
    const args = ['-p', 'Follow the instructions above and reply now.', '-o', 'json', '--approval-mode', mode];
    if (model) args.push('-m', String(model));
    return args;
}

function runGemini({ model, prompt, systemPrompt, cwd, workspace, timeoutMs }) {
    const dir = scratchDir(cwd);
    const level = workspace && workspace.root && workspace.tools && workspace.tools !== 'none' ? workspace.tools : 'none';
    const args = geminiArgs({ model, workspace: level !== 'none' ? workspace : null });
    const full = `${systemPrompt || (level !== 'none' ? workspaceSystemPrompt(workspace) : DISCUSSION_SYSTEM_PROMPT)}\n\n${prompt}`;
    const run = runProcess('gemini', 'gemini', args, { cwd: level !== 'none' ? workspace.root : dir, prompt: full, timeoutMs });
    const promise = run.promise.then(({ code, stdout, stderr }) => {
        const text = stdout.trim();
        let parsed = null;
        // The JSON envelope may be preceded by warnings, and on failure it can
        // land on stderr instead of stdout.
        for (const src of [text, stderr.trim()]) {
            const i = src.indexOf('{');
            if (i !== -1) { try { parsed = JSON.parse(src.slice(i)); break; } catch { /* not JSON */ } }
        }
        if (parsed && typeof parsed === 'object') {
            if (parsed.error) {
                const msg = parsed.error.message || parsed.error.type || 'error';
                throw new Error(`Gemini CLI: ${/auth method/i.test(msg) ? 'not logged in — run `gemini` once and choose a login method (Google account or API key)' : msg}`);
            }
            const response = typeof parsed.response === 'string' ? parsed.response : '';
            if (!response.trim()) throw new Error('Gemini CLI returned no text');
            return { text: response, model: (parsed.stats && parsed.stats.models && Object.keys(parsed.stats.models)[0]) || model || null };
        }
        if (code !== 0) throw new Error(`Gemini CLI exited ${code}: ${tailOf(stderr || stdout)}`);
        if (!text) throw new Error('Gemini CLI returned no output');
        return { text, model: model || null };
    });
    return { promise, abort: run.abort };
}

function run(provider, opts) {
    const base = String(provider || '').split(':')[0];
    if (base === 'claude-cli') return runClaude(opts);
    if (base === 'codex-cli') return runCodex(opts);
    if (base === 'gemini-cli') return runGemini(opts);
    return { promise: Promise.reject(new Error(`Unknown CLI provider: ${provider}`)), abort() { } };
}

module.exports = {
    run, runClaude, runCodex, runGemini, availability, resetAvailabilityCache, which, discover, discovered, childEnv, knownLocations,
    parseClaudeHelp, parseCodexModelsCache, parseCodexConfig, geminiAuthFrom, codexEffortFor,
    claudeArgs, codexArgs, geminiArgs, workspaceSystemPrompt, codexSandboxHelperDir, codexSandboxBundle, codexSandboxSupport, hasCodexHelpers,
    EFFORT_MAP, DISCUSSION_SYSTEM_PROMPT, MAX_PARALLEL, KINDS, BINS, LABELS, TOOLS_LEVELS, CLAUDE_TOOLS,
};
