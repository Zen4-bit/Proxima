// Proxima Provider Sender — API-only message dispatch.
// Chains and queues message requests to provider engines and handles transient retries.

let browserManager, providerAPI;
function init(d) { browserManager = d.browserManager; providerAPI = d.providerAPI; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Chain sends to the same provider sequentially to prevent BrowserView execution collisions.
const _sendQueues = {};
// The send currently executing per base provider: { conversationId }.
const _active = {};

// options.shouldRun: called right before the queued send actually starts;
// return false to skip it (rejects with 'Cancelled by user') — so a Stop
// that lands while the call is still waiting in the queue never reaches the
// provider at all.
function sendMessageToProvider(provider, message, attachments = null, onChunk = null, conversationId = null, options = null) {
    const baseProvider = (provider || '').split(':')[0];
    const run = () => {
        if (options && typeof options.shouldRun === 'function' && !options.shouldRun()) {
            return Promise.reject(new Error('Cancelled by user'));
        }
        return _sendMessageToProviderImpl(provider, message, attachments, onChunk, conversationId);
    };
    const prior = _sendQueues[baseProvider] || Promise.resolve();
    const next = prior.then(run, run);
    _sendQueues[baseProvider] = next.then(() => { }, () => { });
    return next;
}

// Abort the send in flight for a provider — only if it is the one identified
// by `conversationId` (pass null to abort whatever is active). Queued sends
// are untouched; use options.shouldRun for those.
async function abortActive(provider, conversationId = null) {
    const baseProvider = (provider || '').split(':')[0];
    const active = _active[baseProvider];
    if (!active) return false;
    if (conversationId && active.conversationId !== conversationId) return false;
    const webContents = browserManager && browserManager.getWebContents(baseProvider);
    if (!webContents || !providerAPI.abortActive) return false;
    return providerAPI.abortActive(baseProvider, webContents);
}

async function _sendMessageToProviderImpl(provider, message, attachments = null, onChunk = null, conversationId = null) {
    const baseProvider = provider.split(':')[0];
    _active[baseProvider] = { conversationId };
    try {
        return await _sendMessageToProviderImplInner(provider, message, attachments, onChunk, conversationId);
    } finally {
        if (_active[baseProvider] && _active[baseProvider].conversationId === conversationId) delete _active[baseProvider];
    }
}

async function _sendMessageToProviderImplInner(provider, message, attachments = null, onChunk = null, conversationId = null) {
    const baseProvider = provider.split(':')[0];
    let webContents = browserManager.getWebContents(baseProvider);
    if (!webContents) {
        // Wait for the BrowserView to initialize on startup before failing.
        const _deadline = Date.now() + 30000;
        while (!webContents && Date.now() < _deadline) {
            await sleep(500);
            webContents = browserManager.getWebContents(baseProvider);
        }
        if (!webContents) {
            throw new Error(`Provider ${baseProvider} not initialized`);
        }
        console.log(`[${baseProvider}] Provider ready after waiting for initialization.`);
    }

    const MAX_TRANSIENT_RETRIES = 2;
    const RETRY_DELAY_MS = 2000;
    const _isTransient = (m) => /timeout|timed out|\babort|network|econn|socket|disconnect|navigat|context (was )?destroyed|cannot find context|execution context|script failed|render(er)? (gone|crash)/i.test(m || '');

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
        try {
            console.log(`[${provider}] API attempt ${attempt}/${MAX_TRANSIENT_RETRIES}...`);
            const apiResponse = await providerAPI.sendViaAPI(provider, webContents, message, attachments, onChunk, conversationId);

            if (apiResponse && apiResponse.length > 0) {
                console.log(`[${provider}] [OK] API response captured (${apiResponse.length} chars) on attempt ${attempt}`);
                return { response: apiResponse };
            }

            console.log(`[${provider}] API returned empty (deterministic — engine already retried). Not looping.`);
            throw new Error(`${provider} returned an empty response`);

        } catch (apiErr) {
            lastError = apiErr.message;
            const transient = _isTransient(apiErr.message);
            console.log(`[${provider}] API attempt ${attempt} failed (${transient ? 'transient' : 'terminal'}): ${apiErr.message}`);
            if (!transient || attempt >= MAX_TRANSIENT_RETRIES) break;

            console.log(`[${provider}] Transient — retrying in ${RETRY_DELAY_MS}ms...`);
            await sleep(RETRY_DELAY_MS);
        }
    }

    throw new Error(`API failed: ${lastError}`);
}


// What model is that tab actually set to? The engines cannot drive a web UI's
// model menu, so a browser seat answers on whatever the user last picked there
// — and until now the transcript simply omitted it, which meant a five-round
// debate recorded nothing about what half the seats were. Reading it makes the
// record honest without pretending we control it.
//
// This scrapes a menu button's label, so it is best-effort by construction:
// these sites restyle often, and every failure returns null rather than a guess.
// The value is only ever used as a label, never to route a request.
const MODEL_LABEL_SELECTORS = {
    chatgpt: ['[data-testid="model-switcher-dropdown-button"]', 'button[aria-label*="odel"]'],
    claude: ['[data-testid="model-selector-dropdown"]', 'button[aria-haspopup="menu"][aria-label*="odel"]'],
    gemini: ['button.gds-mode-switch-button', 'bard-mode-switcher button'],
    perplexity: ['button[aria-label*="odel"]'],
};

async function readTabModel(provider) {
    const base = String(provider || '').split(':')[0];
    const sel = MODEL_LABEL_SELECTORS[base];
    if (!sel || !browserManager || !browserManager.getWebContents(base)) return null;
    const script = `(() => {
        const sels = ${JSON.stringify(sel)};
        for (const s of sels) {
            const el = document.querySelector(s);
            const t = el && (el.innerText || el.textContent || '').trim();
            if (t) return t.split(String.fromCharCode(10))[0].slice(0, 60);
        }
        return null;
    })()`;
    try {
        const raw = await browserManager.executeScript(base, script);
        if (!raw || typeof raw !== 'string') return null;
        // Menu buttons often carry chrome around the name ("Claude Opus 5 ▾").
        const cleaned = raw.replace(/[▾▼⌄˅]/g, '').replace(/\s+/g, ' ').trim();
        return cleaned && cleaned.length <= 60 ? cleaned : null;
    } catch {
        return null;                                    // tab closed, navigating, or restyled
    }
}

module.exports = { init, sendMessageToProvider, abortActive, readTabModel };
