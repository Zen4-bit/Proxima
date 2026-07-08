// Proxima Provider Sender — API-only message dispatch.
// Chains and queues message requests to provider engines and handles transient retries.

let browserManager, providerAPI;
function init(d) { browserManager = d.browserManager; providerAPI = d.providerAPI; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Chain sends to the same provider sequentially to prevent BrowserView execution collisions.
const _sendQueues = {};

function sendMessageToProvider(provider, message, attachments = null, onChunk = null, conversationId = null) {
    const baseProvider = (provider || '').split(':')[0];
    const run = () => _sendMessageToProviderImpl(provider, message, attachments, onChunk, conversationId);
    const prior = _sendQueues[baseProvider] || Promise.resolve();
    const next = prior.then(run, run);
    _sendQueues[baseProvider] = next.then(() => { }, () => { });
    return next;
}

async function _sendMessageToProviderImpl(provider, message, attachments = null, onChunk = null, conversationId = null) {
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

module.exports = { init, sendMessageToProvider };
