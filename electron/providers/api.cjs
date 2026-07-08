// Proxima — Provider API Manager.
// Loads engine scripts into BrowserViews.

const fs = require('fs');
const path = require('path');


const _scripts = {};


function _loadScript(provider) {
    if (_scripts[provider]) return _scripts[provider];

    const scriptMap = {
        chatgpt: 'chatgpt-engine.js',
        claude: 'claude-engine.js',
        gemini: 'gemini-engine.js',
        perplexity: 'perplexity-engine.js'
    };

    const filename = scriptMap[provider];
    if (!filename) return null;

    const scriptPath = path.join(__dirname, 'engines', filename);
    try {
        _scripts[provider] = fs.readFileSync(scriptPath, 'utf8');
        console.log(`[ProviderAPI] Loaded ${filename} (${_scripts[provider].length} bytes)`);
        return _scripts[provider];

    } catch (e) {
        console.error(`[ProviderAPI] Failed to load ${filename}:`, e.message);
        return null;
    }
}


function clearScriptCache() {
    Object.keys(_scripts).forEach(k => delete _scripts[k]);
    console.log('[ProviderAPI] Script cache cleared');
}

const _injectedOnce = new Set();
async function injectAPI(provider, webContents) {
    const script = _loadScript(provider);
    if (!script) {
        console.log(`[ProviderAPI] No API script for ${provider} — cannot inject engine`);
        return false;
    }

    try {
        await webContents.executeJavaScript(script);
        if (!_injectedOnce.has(provider)) {
            console.log(`[ProviderAPI] [OK] Injected API for ${provider}`);
            _injectedOnce.add(provider);
        }
        return true;
    } catch (e) {
        console.error(`[ProviderAPI] [FAIL] Injection failed for ${provider}:`, e.message);
        return false;
    }
}


async function isAPIReady(provider, webContents) {
    const checkMap = {
        chatgpt: 'typeof window.__proximaChatGPT !== "undefined"',
        claude: 'typeof window.__proximaClaude !== "undefined"',
        gemini: 'typeof window.__proximaGemini !== "undefined"',
        perplexity: 'typeof window.__proximaPerplexity !== "undefined"'
    };

    const check = checkMap[provider];
    if (!check) return false;

    try {
        return await webContents.executeJavaScript(check);
    } catch (e) {
        return false;
    }
}

function waitForLoad(webContents, timeoutMs = 8000) {
    return new Promise(resolve => {
        if (!webContents.isLoading()) {
            return resolve();
        }

        let resolved = false;
        const cleanup = () => {
            if (resolved) return;
            resolved = true;
            webContents.removeListener('did-finish-load', onLoad);
            webContents.removeListener('did-fail-load', onLoad);
            clearTimeout(timer);
        };

        const onLoad = () => {
            cleanup();
            resolve();
        };

        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, timeoutMs);

        webContents.once('did-finish-load', onLoad);
        webContents.once('did-fail-load', onLoad);
    });
}

async function ensureAPI(provider, webContents) {
    if (provider === 'gemini') {
        const needsWait = webContents.isLoading() || !(await webContents.executeJavaScript(`typeof window.WIZ_global_data !== "undefined"`).catch(() => false));
        if (needsWait) {
            console.log('[ProviderAPI] Gemini page loading. Waiting for load event...');
            await waitForLoad(webContents);
            await new Promise(r => setTimeout(r, 1500));
        }
    }
    if (await isAPIReady(provider, webContents)) return true;
    return await injectAPI(provider, webContents);
}

async function sendViaAPI(provider, webContents, message, attachments = null, onChunk = null, conversationId = null) {
    let baseProvider = provider;
    let engine = 'auto';
    if (provider.indexOf(':') !== -1) {
        const parts = provider.split(':');
        baseProvider = parts[0];
        engine = parts[1];
    }

    const ready = await ensureAPI(baseProvider, webContents);
    if (!ready) {
        console.log(`[ProviderAPI] API engine not available for ${baseProvider} — cannot send`);
        return null;
    }

    const sendMap = {
        chatgpt: '__proximaChatGPT',
        claude: '__proximaClaude',
        gemini: '__proximaGemini',
        perplexity: '__proximaPerplexity'
    };

    const apiObj = sendMap[baseProvider];
    if (!apiObj) return null;

    const escapedMessage = JSON.stringify(message);

    try {
        console.log(`[ProviderAPI] Sending via ${baseProvider} API (Engine: ${engine})...`);
        const startTime = Date.now();

        let executeStr;
        if (baseProvider === 'gemini' || baseProvider === 'chatgpt' || baseProvider === 'perplexity' || baseProvider === 'claude') {
            const escapedAttachments = attachments ? JSON.stringify(attachments) : 'null';
            executeStr = `window.${apiObj}.send(${escapedMessage}, ${JSON.stringify(engine)}, ${escapedAttachments}, ${JSON.stringify(conversationId)})`;
        } else {
            executeStr = `window.${apiObj}.send(${escapedMessage}, ${JSON.stringify(conversationId)})`;
        }

        if (onChunk && baseProvider === 'gemini') {
            await webContents.executeJavaScript(`window.__proximaGeminiStream = { response: '', status: 'init' };`).catch(() => { });
        }

        const apiPromise = webContents.executeJavaScript(executeStr);

        if (onChunk && baseProvider === 'gemini') {
            let lastLen = 0;
            let finished = false;

            let apiSettled = false;
            apiPromise.then(() => { apiSettled = true; }, () => { apiSettled = true; });

            const MAX_POLL_MS = 6 * 60 * 1000;
            const IDLE_LIMIT_MS = 30 * 1000;
            const pollStart = Date.now();
            let lastProgressAt = Date.now();

            while (!finished) {
                await new Promise(r => setTimeout(r, 80));
                try {
                    const streamData = await webContents.executeJavaScript(`window.__proximaGeminiStream || null`).catch(() => null);
                    if (streamData) {
                        if (streamData.response && streamData.response.length > lastLen) {
                            const newChunk = streamData.response.substring(lastLen);
                            lastLen = streamData.response.length;
                            lastProgressAt = Date.now();
                            onChunk(newChunk);
                        }
                        if (streamData.status === 'done' || streamData.status === 'error') {
                            finished = true;
                            continue;
                        }
                        if (streamData.status === 'init') {
                        }
                    }
                } catch (e) {
                    finished = true;
                    continue;
                }

                if (apiSettled && Date.now() - lastProgressAt > 500) finished = true;
                else if (Date.now() - lastProgressAt > IDLE_LIMIT_MS) finished = true;
                else if (Date.now() - pollStart > MAX_POLL_MS) finished = true;
            }
        }

        const result = await apiPromise;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const charCount = result ? result.length : 0;
        console.log(`[ProviderAPI] [OK] ${provider} API response: ${charCount} chars in ${elapsed}s`);

        return result || null;
    } catch (e) {
        console.error(`[ProviderAPI] [FAIL] ${provider} API error:`, e.message);
        throw e;
    }
}

function setupAutoInject(provider, webContents) {
    webContents.on('did-finish-load', async () => {

        const alreadyReady = await isAPIReady(provider, webContents).catch(() => false);
        if (!alreadyReady) {
            await injectAPI(provider, webContents);
        }
    });
}

async function resetConversation(provider, webContentsGetter) {
    const resetMap = {
        chatgpt: '__proximaChatGPT',
        claude: '__proximaClaude',
        gemini: '__proximaGemini',
        perplexity: '__proximaPerplexity'
    };

    const providers = provider ? [provider] : ['chatgpt', 'claude', 'gemini', 'perplexity'];

    for (const p of providers) {
        const apiObj = resetMap[p];
        if (!apiObj) continue;

        try {
            const wc = typeof webContentsGetter === 'function' ? webContentsGetter(p) : webContentsGetter;
            if (!wc) continue;

            await wc.executeJavaScript(
                `if (window.${apiObj} && window.${apiObj}.newConversation) { window.${apiObj}.newConversation(); }`
            );
            console.log(`[ProviderAPI] [OK] Reset conversation for ${p}`);
        } catch (e) {
            console.error(`[ProviderAPI] [FAIL] Failed to reset conversation for ${p}:`, e.message);
        }
    }
}

module.exports = {
    injectAPI,
    isAPIReady,
    ensureAPI,
    sendViaAPI,
    setupAutoInject,
    resetConversation,
    clearScriptCache
};
