// Proxima — keyless model catalogue (tier 1 of three).
//
// The CLIs are poor at describing themselves. Claude Code's --help lists only
// its aliases even though it accepts full claude-… ids, Gemini CLI enumerates
// nothing, and Codex's list comes from a cache written by whichever binary the
// user last ran. So a public catalogue fills the gaps: models.dev is git-backed
// (sst/models.dev), needs no API key, and is the only free source found that
// enumerates *effort values* rather than merely saying an effort knob exists.
//
// It is tier 1 because it is a candidate list, not an entitlement list, and it
// can be wrong in both directions — measured against this machine it offered
// `none` for gpt-5.6-sol (which the binary does not accept) and omitted
// `ultra` (which it does). Local CLI truth overrides it; a model verified by an
// actual run outranks both. Never let it fail a run: every path here degrades
// to "no catalogue" rather than throwing.

const fs = require('fs');
const path = require('path');
const os = require('os');

const URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;
// The cache stores the *shaped* result, so a change to what shape() keeps or
// drops must invalidate it — otherwise an old machine keeps serving models a
// newer filter would have excluded. Bump on any change to shape().
const SHAPE_VERSION = 2;
const FETCH_TIMEOUT_MS = 20000;

// models.dev groups by API provider; these are the ones our CLI kinds speak.
const PROVIDER_FOR_KIND = { claude: 'anthropic', codex: 'openai', gemini: 'google' };

// Same provider, different product. Gemma is open-weights and is not served
// by the Gemini CLI, and the image / computer-use / deep-research variants are
// task-specific surfaces rather than models a discussion seat can drive. They
// pass the text+tools test above, so they need naming explicitly.
const EXCLUDE = /^gemma|-image$|computer-use|deep-research/;

let _cacheDir = null;
let _mem = null;
let _inflight = null;

function setCacheDir(dir) { _cacheDir = dir || null; }
function cacheFile() {
    return path.join(_cacheDir || os.tmpdir(), 'models-dev.json');
}

function readCache() {
    try {
        const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
        if (raw && raw.at && raw.byKind && raw.v === SHAPE_VERSION) return raw;
    } catch { /* no cache yet, or unreadable */ }
    return null;
}

function writeCache(entry) {
    try {
        fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
        fs.writeFileSync(cacheFile(), JSON.stringify(entry), 'utf8');
    } catch { /* a cache we cannot write is not an error, just a slower next start */ }
}

// Pull out { id, name, efforts[] } per CLI kind. Everything else models.dev
// carries (pricing, modalities, limits) is deliberately dropped — the roster
// only needs something to offer in a dropdown.
function shape(api) {
    const byKind = {};
    for (const [kind, provider] of Object.entries(PROVIDER_FOR_KIND)) {
        const models = (api && api[provider] && api[provider].models) || {};
        byKind[kind] = Object.keys(models).map(id => {
            const m = models[id] || {};
            const effort = (m.reasoning_options || []).find(o => o && o.type === 'effort');
            const out = (m.modalities && m.modalities.output) || [];
            return {
                id,
                label: m.name || id,
                efforts: Array.isArray(effort && effort.values) ? effort.values.slice() : [],
                // These decide whether the model could plausibly drive a coding
                // CLI at all. models.dev lists a provider's whole API surface,
                // which for OpenAI and Google includes image, audio and
                // open-weights models — a music model in the roster's model
                // picker is worse than a short list.
                textOut: out.includes('text'),
                toolCall: m.tool_call === true,
            };
        }).filter(m => m.id && m.textOut && m.toolCall && !EXCLUDE.test(m.id))
          .map(({ id, label, efforts }) => ({ id, label, efforts }));
    }
    return byKind;
}

async function fetchCatalog() {
    if (typeof fetch !== 'function') return null;      // very old Node: skip quietly
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    if (t.unref) t.unref();
    try {
        const res = await fetch(URL, { signal: ctl.signal, headers: { accept: 'application/json' } });
        if (!res.ok) return null;
        return shape(await res.json());
    } catch {
        return null;                                    // offline, blocked, slow — all the same here
    } finally {
        clearTimeout(t);
    }
}

// Returns { byKind, at, stale } or null. Never throws, never blocks a run:
// a cached copy is served immediately and refreshed in the background when it
// ages out, so only the very first call on a new machine waits on the network.
async function load({ force = false } = {}) {
    if (_mem && !force && (Date.now() - _mem.at) < TTL_MS) return _mem;
    if (!_mem) _mem = readCache();

    const fresh = _mem && (Date.now() - _mem.at) < TTL_MS;
    if (fresh && !force) return _mem;

    if (!_inflight) {
        _inflight = fetchCatalog()
            .then(byKind => {
                if (byKind) { _mem = { byKind, at: Date.now(), v: SHAPE_VERSION }; writeCache(_mem); }
                return _mem;
            })
            .finally(() => { _inflight = null; });
    }
    // With a usable (if stale) copy in hand, don't make the caller wait.
    if (_mem) { _inflight.catch(() => {}); return Object.assign({}, _mem, { stale: !fresh }); }
    return _inflight;
}

// Synchronous read of whatever is already loaded, for callers that cannot await.
function loaded() { return _mem; }

module.exports = { load, loaded, setCacheDir, shape, PROVIDER_FOR_KIND, URL };
