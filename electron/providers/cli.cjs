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

const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const NEWLINE_RE = new RegExp('\r?\n');
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

// Which codex binary to run. Candidates: the desktop app's bundle (has the
// Windows sandbox helpers, usually newest) and the codex on PATH. The newest
// version wins; a tie or unknown versions go to the bundle, since only it can
// sandbox read/write turns. Resolved once (async: it runs `--version`),
// cached; before the first resolution the bundle is preferred when present.
let _codexPick = null;
let _codexPickPromise = null;
function parseVersion(v) {
    const m = String(v || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
function cmpVersion(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}
function codexCandidates({ force = false } = {}) {
    const out = [];
    const b = codexSandboxBundle({ force });
    if (b) out.push({ exe: b.exe, source: 'bundle', helpers: true });
    const p = which('codex');
    if (p && !(b && p.toLowerCase() === b.exe.toLowerCase())) out.push({ exe: p, source: 'path', helpers: !IS_WIN || hasCodexHelpers(path.dirname(p)) });
    return out;
}
function resolveCodex({ force = false } = {}) {
    if (_codexPick && !force) return Promise.resolve(_codexPick);
    if (_codexPickPromise && !force) return _codexPickPromise;
    _codexPickPromise = (async () => {
        const cands = codexCandidates({ force });
        for (const c of cands) {
            const r = await runQuick('codex', ['--version'], 8000, c.exe);
            c.version = (r.stdout.trim().replace(/^codex-cli\s*/i, '').split(/\s+/)[0] || '').trim();
            c.semver = parseVersion(c.version);
        }
        cands.sort((a, b) => cmpVersion(b.semver, a.semver) || (a.source === 'bundle' ? -1 : (b.source === 'bundle' ? 1 : 0)));
        _codexPick = cands[0] ? Object.assign({}, cands[0], { alternatives: cands.slice(1) }) : null;
        _codexPickPromise = null;
        return _codexPick;
    })();
    return _codexPickPromise;
}
// Sync view: the resolved pick, else the best guess (bundle, then PATH).
function codexExe() {
    if (_codexPick) return _codexPick.exe;
    const c = codexCandidates();
    return c.length ? c[0].exe : null;
}
// Kept for callers of the old API: how a sandboxed (read/write) turn can run.
function codexSandboxSupport() {
    if (!IS_WIN) return { mode: 'native', exe: null };
    const exe = codexExe();
    if (!exe || !hasCodexHelpers(path.dirname(exe))) return { mode: 'missing', exe };
    const b = codexSandboxBundle();
    return { mode: b && exe.toLowerCase() === b.exe.toLowerCase() ? 'bundle' : 'native', exe };
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

// execFileSync blocks the Electron main process — and in Electron that means
// the window, every provider BrowserView, the REST server and the IPC bridge
// freeze together, for up to 5s per lookup on a long PATH or a PATH entry on a
// disconnected share. Three of those fire from the refresh button. So the cache
// is warmed asynchronously here, and the synchronous which() below only ever
// runs on a cold miss.
function whichAsync(bin) {
    if (_avail[bin] !== undefined) return Promise.resolve(_avail[bin]);
    return new Promise(resolve => {
        execFile(IS_WIN ? 'where' : 'which', [bin], { encoding: 'utf8', timeout: 5000, env: childEnv(), windowsHide: true }, (err, stdout) => {
            let found = err ? null : (String(stdout).split(NEWLINE_RE).map(l => l.trim()).filter(Boolean)[0] || null);
            if (!found) found = knownLocations(bin).find(f => { try { return fs.existsSync(f); } catch { return false; } }) || null;
            _avail[bin] = found;
            resolve(found);
        });
    });
}

async function warmAvailability() {
    await Promise.all(Object.values(BINS).map(b => whichAsync(b).catch(() => null)));
}

function availability() {
    return {
        claude: !!which('claude'),
        codex: !!which('codex') || !!codexSandboxBundle(),
        gemini: !!which('gemini'),
    };
}

function resetAvailabilityCache() {
    for (const k of Object.keys(_avail)) delete _avail[k];
    _discovered = null;
    // Also drop an in-flight (possibly rejected) discovery, so ↻ genuinely
    // starts over rather than re-awaiting the run that just failed.
    _discovering = null;
    _codexPick = null;
    _codexBundleCache = undefined;
}

// ---- discovery ------------------------------------------------------------

function runQuick(bin, args, timeoutMs = 8000, exe) {
    return new Promise((resolve) => {
        let child;
        try { child = spawnCli(bin, args, os.tmpdir(), exe); } catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e.message || e) }); }
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
    // `force` has to beat the in-flight check too, or ↻ cannot recover from a
    // discovery that failed — the rejected promise would be handed back forever.
    if (_discovering && !force) return _discovering;
    _discovering = (async () => {
        const home = os.homedir();
        const out = { claude: null, codex: null, gemini: null, at: Date.now() };
        await warmAvailability();
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
            const pick = await resolveCodex({ force: true });
            const cacheJson = readJson(path.join(home, '.codex', 'models_cache.json'));
            const cache = parseCodexModelsCache(cacheJson);
            const cfg = parseCodexConfig(readText(path.join(home, '.codex', 'config.toml')));
            // models_cache.json is written by whichever codex the *user* last
            // ran interactively, which need not be the binary we resolved (the
            // newest of the bundle and PATH). When they disagree the cached
            // list can be missing models the running binary supports, the
            // account's own default among them, so a "not in its list" warning
            // would be about stale data and effort clamping silently stops
            // applying. Report the list as stale instead of blaming the model.
            const cacheVersion = cacheJson && cacheJson.client_version ? String(cacheJson.client_version) : '';
            const cacheStale = !!(cacheVersion && pick && pick.version && cacheVersion !== pick.version);
            const efforts = [];
            cache.forEach(m => m.efforts.forEach(e => { if (!efforts.includes(e)) efforts.push(e); }));
            out.codex = {
                available: true, label: LABELS.codex,
                version: pick ? pick.version : '',
                efforts: efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh'],
                models: cache,
                defaultModel: cfg.model, defaultEffort: cfg.effort,
                profiles: cfg.profiles,
                defaultModelListed: !cfg.model || cacheStale || cache.some(m => m.id === cfg.model),
                cacheVersion, cacheStale,
                // Which binary runs the seats (newest of the desktop app's
                // bundle and the codex on PATH) and whether it can sandbox
                // read/write turns on Windows; `full` always works.
                exe: pick ? pick.exe : undefined,
                source: pick ? pick.source : undefined,
                alternatives: pick ? pick.alternatives.map(a => ({ exe: a.exe, source: a.source, version: a.version })) : [],
                sandbox: !IS_WIN ? 'native' : (pick && pick.helpers ? 'native' : 'missing'),
                note: !cache.length ? 'No model list cached yet — run codex once.'
                    : (cacheStale
                        ? `Model list was cached by codex ${cacheVersion}, but seats run ${pick.version} — it may be out of date. Run codex once to refresh it.`
                        : 'Models from your account\'s list (~/.codex/models_cache.json).'),
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
        return out;
    })();
    // Clearing in a finally, not on the success path: one throw in the body
    // (a permission-denied readdir under %LOCALAPPDATA%, a which() failure)
    // used to leave a permanently rejected promise here, and every later call
    // — including the ↻ button's — got that same rejection until restart. The
    // agent editor then silently lost the CLI version, the login state and the
    // "no sandbox helpers" warning while still looking healthy, and
    // GET /v1/multiai/variants and the cli_variants MCP tool failed outright.
    const inflight = _discovering;
    inflight.finally(() => { if (_discovering === inflight) _discovering = null; }).catch(() => {});
    return inflight;
}

function discovered() { return _discovered; }

// Codex: the effort the model actually supports (falls back to the highest
// supported level when the requested one is above it).
// `models` defaults to whatever discovery found; it is a parameter so the
// clamping arithmetic can be tested without reaching into module state or
// depending on which CLIs happen to be installed on the machine.
function codexEffortFor(model, effort, models) {
    const eff = effort && EFFORT_MAP.codex[effort];
    if (!eff) return null;
    const list = models || (_discovered && _discovered.codex && _discovered.codex.models) || null;
    const info = list ? list.find(m => m.id === model) : null;
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

// One private folder per run. It used to be a single shared directory, which
// broke in three ways: the system-prompt filename was pid + milliseconds with
// no random part, so seats starting in the same tick (normal in a parallel
// first round) overwrote each other's prompt — handing a `none` seat the
// workspace prompt, or the reverse, which is a privilege-label mix-up rather
// than a cosmetic race; failed turns left their prompt on disk forever; and
// mcp_empty.json — what --strict-mcp-config points at — sat in a directory a
// Codex `none` seat runs inside with its sandbox bypassed, so a seat that
// wrote real MCP servers into it changed what the next Claude seat loaded.
function scratchDir(base) {
    const root = path.join(base || os.tmpdir(), 'multiai-cli');
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 'run-'));
    fs.writeFileSync(path.join(dir, 'mcp_empty.json'), '{"mcpServers":{}}', 'utf-8');
    return dir;
}

function removeScratch(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function killTree(child) {
    if (!child || child.killed) return;
    try {
        if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        else child.kill('SIGKILL');
    } catch { /* ignore */ }
}

// Every live CLI child, so quitting the app does not leave them running. A
// `full` seat that outlives Proxima keeps editing the user's repo with no
// parent, no timeout (its timer died with us) and no attribution — and the
// next workspace.prepare() commits whatever it produced as "WIP left by an
// interrupted turn". On Windows nothing else reaps these.
const _live = new Set();

function killAll() {
    for (const child of _live) killTree(child);
    _live.clear();
}

// Quote one token for CommandLineToArgvW: wrap in quotes, double the run of
// backslashes that precedes a quote (or ends the token), escape inner quotes.
function winQuote(arg) {
    const s = String(arg);
    return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

// Windows only: a command line for `cmd.exe /d /s /c`. Every token is quoted,
// which is what stops cmd interpreting & | < > ( ) ^ inside it.
//
// A literal double quote is refused rather than escaped: cmd has no in-quote
// escape for it (\" is a C convention cmd does not honour), so any encoding
// silently mangles the argument. Windows filenames cannot contain one and the
// validated model/effort fields cannot either, so this only ever fires on input
// that was already malformed. `%` is deliberately left alone — ^% does not
// escape inside quotes and would corrupt the value; %VAR% expansion can
// substitute an environment value but cannot execute anything.
function cmdCommandLine(exe, args) {
    for (const a of [exe, ...args]) {
        if (String(a).includes('"')) throw new Error('cannot pass a double quote to a Windows CLI shim');
    }
    return [exe, ...args].map(winQuote).join(' ');
}

// The resolved path from which() is a real path, so an .exe is spawned directly
// with an argv array and no shell — nothing on that path can be reinterpreted
// as a command. Only npm's .cmd/.bat shims (claude) need cmd.exe, and those get
// an explicitly quoted command line rather than a concatenated string.
function spawnCli(bin, args, cwd, exeOverride) {
    const exe = exeOverride || (bin === 'codex' ? codexExe() : null) || which(bin) || bin;
    const opts = { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(bin) };
    if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
        return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdCommandLine(exe, args)}"`],
            { ...opts, windowsVerbatimArguments: true });
    }
    return spawn(exe, args, opts);
}

// Runs a process with the prompt on stdin. Returns { promise, abort }.
// `onState` is how the UI learns the difference between a seat that is waiting
// for a concurrency slot and one that is actually thinking — the two look
// identical otherwise, and a seat can sit queued for a full CLI timeout while
// the user decides whether to wait or press Stop. Optional: cli.cjs must stay
// Electron-free for the standalone variants server, which omits it.
function runProcess(kind, bin, args, { cwd, prompt, timeoutMs, exe, onState }) {
    const state = (s) => { try { if (onState) onState(s); } catch { /* never let the UI break a run */ } };
    let child = null;
    let aborted = false;
    let timer = null;
    const promise = (async () => {
        state('queued');
        await acquire(kind);
        if (aborted) { release(kind); throw Object.assign(new Error('Cancelled by user'), { cancelled: true }); }
        try {
            const exeResolved = typeof exe === 'function' ? await exe() : exe;
            // Resolving the executable can take seconds (resolveCodex runs
            // --version on two candidates), so re-check: a Stop during that
            // window would otherwise spawn a process abort() can no longer
            // reach, which then runs to its full timeout writing to the repo.
            if (aborted) throw Object.assign(new Error('Cancelled by user'), { cancelled: true });
            return await new Promise((resolve, reject) => {
                child = spawnCli(bin, args, cwd, exeResolved);
                state('running');
                _live.add(child);
                child.once('close', () => _live.delete(child));
                let stdout = '';
                let stderr = '';
                // Keep the tail: all three CLIs put their JSON envelope at the end,
                // and an unbounded buffer lets a chatty seat grow main-process memory.
                child.stdout.on('data', d => { stdout += d.toString('utf8'); if (stdout.length > 4000000) stdout = stdout.slice(-2000000); });
                child.stderr.on('data', d => { stderr += d.toString('utf8'); if (stderr.length > 200000) stderr = stderr.slice(-100000); });
                child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
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
        // Returns a promise that settles once the child is actually gone (or
        // after a short deadline). Callers that commit the workspace must await
        // it: killTree only *asks* Windows to kill the tree, so a fire-and-forget
        // abort left `git add -A` racing a process that was still writing —
        // committing half-written files, and releasing the writer lock while a
        // zombie kept editing, which defeats the serialisation the workspace
        // design rests on.
        abort() {
            aborted = true;
            if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
            const gone = new Promise(resolve => {
                child.once('close', resolve);
                setTimeout(resolve, 5000).unref?.();
            });
            killTree(child);
            return gone;
        },
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

function runClaude({ model, effort, prompt, systemPrompt, cwd, workspace, timeoutMs, onState }) {
    const dir = scratchDir(cwd);
    const level = workspace && workspace.root && workspace.tools && workspace.tools !== 'none' ? workspace.tools : 'none';
    const sysFile = path.join(dir, 'system.txt');
    fs.writeFileSync(sysFile, systemPrompt || (level !== 'none' ? workspaceSystemPrompt(workspace) : DISCUSSION_SYSTEM_PROMPT), 'utf-8');
    const args = claudeArgs({ model, effort, workspace: level !== 'none' ? workspace : null }, dir, sysFile);
    const run = runProcess('claude', 'claude', args, { cwd: level !== 'none' ? workspace.root : dir, prompt, timeoutMs, onState });
    // finally, not then: an aborted or timed-out turn used to leave its system
    // prompt behind forever.
    run.promise.finally(() => removeScratch(dir)).catch(() => {});
    const promise = run.promise.then(({ code, stdout, stderr }) => {
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

function runCodex({ model, effort, prompt, systemPrompt, cwd, workspace, timeoutMs, onState }) {
    const dir = scratchDir(cwd);
    const level = workspace && workspace.root && workspace.tools && workspace.tools !== 'none' ? workspace.tools : 'none';
    const outFile = path.join(dir, 'codex-last.txt');
    const args = codexArgs({ model, effort, workspace: level !== 'none' ? workspace : null }, dir, outFile);
    // The system prompt is prepended because exec has no system-prompt flag.
    const full = `${systemPrompt || (level !== 'none' ? workspaceSystemPrompt(workspace) : DISCUSSION_SYSTEM_PROMPT)}\n\n${prompt}`;
    // spawnCli runs the resolved codex (newest of the desktop app's bundle and
    // the one on PATH — see resolveCodex); resolve first so the first turn
    // after startup doesn't guess.
    const run = runProcess('codex', 'codex', args, { cwd: level !== 'none' ? workspace.root : dir, prompt: full, timeoutMs, onState, exe: () => resolveCodex().then(p => (p ? p.exe : undefined)) });
    run.promise.finally(() => removeScratch(dir)).catch(() => {});
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

function runGemini({ model, prompt, systemPrompt, cwd, workspace, timeoutMs, onState }) {
    const dir = scratchDir(cwd);
    const level = workspace && workspace.root && workspace.tools && workspace.tools !== 'none' ? workspace.tools : 'none';
    const args = geminiArgs({ model, workspace: level !== 'none' ? workspace : null });
    const full = `${systemPrompt || (level !== 'none' ? workspaceSystemPrompt(workspace) : DISCUSSION_SYSTEM_PROMPT)}\n\n${prompt}`;
    const run = runProcess('gemini', 'gemini', args, { cwd: level !== 'none' ? workspace.root : dir, prompt: full, timeoutMs, onState });
    run.promise.finally(() => removeScratch(dir)).catch(() => {});
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
    codexCandidates, resolveCodex, codexExe, parseVersion, cmpVersion, spawnCli, winQuote, cmdCommandLine, killAll, whichAsync, warmAvailability,
    EFFORT_MAP, DISCUSSION_SYSTEM_PROMPT, MAX_PARALLEL, KINDS, BINS, LABELS, TOOLS_LEVELS, CLAUDE_TOOLS,
};
