// Proxima — Settings & Cookie IPC Handlers.
// Registers handlers for cookie management, API key management, and BYOK settings.

const { ipcMain, session } = require('electron');

function registerSettingsHandlers(deps) {
    const { browserManager, loadSettings, saveSettings, startRestAPI, stopRestAPI, isRestAPIRunning, generateApiKey, revokeApiKey, loadApiKey, getFileReferenceEnabled, setFileReferenceEnabled } = deps;

    ipcMain.handle('set-cookies', async (event, provider, cookiesJson) => {
        try {
            const config = browserManager.providers[provider];
            if (!config) {
                return { success: false, error: 'Unknown provider' };
            }

            let cookies;
            try {
                cookies = JSON.parse(cookiesJson);
            } catch (e) {
                return { success: false, error: 'Invalid JSON format. Please paste valid cookie JSON.' };
            }

            if (!Array.isArray(cookies)) {
                return { success: false, error: 'Cookies should be an array. Try exporting from EditThisCookie or Cookie-Editor extension.' };
            }

            const ses = session.fromPartition(config.partition, { cache: true });

            const existingCookies = await ses.cookies.get({});
            for (const cookie of existingCookies) {
                try {
                    const url = `http${cookie.secure ? 's' : ''}://${cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain}${cookie.path || '/'}`;
                    await ses.cookies.remove(url, cookie.name);
                } catch (e) { }
            }

            const oneYearFromNow = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);

            let setCount = 0;
            let errorCount = 0;
            for (const cookie of cookies) {
                try {
                    const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;

                    let sameSite = (cookie.sameSite || 'no_restriction').toLowerCase();
                    if (sameSite === 'none') sameSite = 'no_restriction';
                    if (!['no_restriction', 'lax', 'strict'].includes(sameSite)) {
                        sameSite = 'no_restriction';
                    }

                    const secure = sameSite === 'no_restriction'
                        ? true
                        : cookie.secure !== false;

                    const url = `http${secure ? 's' : ''}://${domain}${cookie.path || '/'}`;

                    const cookieDetails = {
                        url: url,
                        name: cookie.name,
                        value: cookie.value,
                        domain: cookie.domain,
                        path: cookie.path || '/',
                        secure: secure,
                        httpOnly: cookie.httpOnly === true,
                        sameSite: sameSite
                    };

                    if (cookie.expirationDate && cookie.expirationDate > Date.now() / 1000) {
                        cookieDetails.expirationDate = cookie.expirationDate;
                    } else {
                        cookieDetails.expirationDate = oneYearFromNow;
                    }

                    await ses.cookies.set(cookieDetails);
                    setCount++;
                } catch (e) {
                    console.error(`[Cookie] Failed to set cookie ${cookie.name}:`, e.message);
                    errorCount++;
                }
            }

            console.log(`[Cookie] Set ${setCount} cookies for ${provider}, ${errorCount} failed`);

            await ses.cookies.flushStore();

            const view = browserManager.views.get(provider);
            if (view && !view.webContents.isDestroyed()) {
                await view.webContents.loadURL(config.url);
            }

            return {
                success: true,
                message: `Successfully set ${setCount} cookies. ${errorCount > 0 ? `(${errorCount} failed)` : ''} Reloading...`,
                setCount,
                errorCount
            };
        } catch (e) {
            console.error('[Cookie] Error:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('clear-provider-cache', async (event, provider) => {
        try {
            const config = browserManager.providers[provider];
            if (!config) {
                return { success: false, error: 'Unknown provider' };
            }

            const ses = session.fromPartition(config.partition, { cache: true });
            await ses.clearCache();
            await ses.clearStorageData({
                storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'cachestorage', 'shadercache', 'serviceworkers']
            });
            await ses.cookies.flushStore();

            const view = browserManager.views.get(provider);
            if (view && !view.webContents.isDestroyed()) {
                await view.webContents.loadURL(config.url);
            }

            console.log(`[Cache] Cleared all cache & session data for ${provider}`);
            return { success: true, message: `Successfully cleared all session and cache data for ${provider.charAt(0).toUpperCase() + provider.slice(1)}.` };
        } catch (e) {
            console.error(`[Cache] Error clearing cache for ${provider}:`, e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('get-cookies', async (event, provider) => {
        try {
            const config = browserManager.providers[provider];
            if (!config) {
                return { success: false, error: 'Unknown provider' };
            }

            const ses = session.fromPartition(config.partition, { cache: true });
            const cookies = await ses.cookies.get({});

            const providerDomains = {
                perplexity: 'perplexity.ai',
                chatgpt: 'openai.com',
                claude: 'claude.ai',
                gemini: 'google.com'
            };

            const domain = providerDomains[provider];
            const filteredCookies = cookies.filter(c => c.domain.includes(domain));

            return {
                success: true,
                cookies: filteredCookies,
                count: filteredCookies.length
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('set-file-reference-enabled', (event, enabled) => {
        if (typeof setFileReferenceEnabled === 'function') {
            setFileReferenceEnabled(enabled);
        }
        console.log('[FileReference] File reference:', enabled ? 'ENABLED' : 'DISABLED');
        return { success: true, enabled: !!enabled };
    });

    ipcMain.handle('get-file-reference-enabled', () => {
        const enabled = typeof getFileReferenceEnabled === 'function' ? getFileReferenceEnabled() : true;
        return { success: true, enabled };
    });

    ipcMain.handle('set-rest-api-enabled', (event, enabled) => {
        const settings = loadSettings();
        settings.restApiEnabled = enabled;
        saveSettings(settings);

        if (enabled) {
            if (!isRestAPIRunning()) {
                startRestAPI();
            }
            console.log('[REST API] REST API ENABLED — http://localhost:3210');
        } else {
            stopRestAPI();
            console.log('[REST API] REST API DISABLED');
        }
        return { success: true, enabled, running: isRestAPIRunning() };
    });

    ipcMain.handle('get-rest-api-enabled', () => {
        const settings = loadSettings();
        return { success: true, enabled: !!settings.restApiEnabled, running: isRestAPIRunning() };
    });

    ipcMain.handle('generate-api-key', () => {
        try {
            const keyData = generateApiKey();
            return { success: true, ...keyData };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('get-api-key', () => {
        try {
            const keyData = loadApiKey();
            return { success: true, hasKey: !!keyData, ...(keyData || {}) };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('revoke-api-key', () => {
        try {
            revokeApiKey();
            return { success: true, message: 'API key revoked. API is now open access.' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    const byokKeys = require('../api/byok/keys.cjs');
    const { callProvider: callBYOKProvider } = require('../api/byok/router.cjs');

    ipcMain.handle('byok-save-key', (_, provider, key) => {
        try {
            byokKeys.saveKey(provider, key);
            return { success: true, provider };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('byok-remove-key', (_, provider) => {
        try {
            byokKeys.removeKey(provider);
            return { success: true, provider };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('byok-get-status', () => {
        try {
            return { success: true, providers: byokKeys.getStatus(), enabled: byokKeys.isEnabled() };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('byok-set-enabled', (_, enabled) => {
        try {
            byokKeys.setEnabled(!!enabled);
            return { success: true, enabled: byokKeys.isEnabled() };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('byok-test-key', async (_, provider, key) => {
        try {
            const effectiveKey = (key && key.trim()) || byokKeys.getKey(provider);
            if (!effectiveKey) {
                return { success: false, error: `No API key configured for ${provider}.` };
            }
            const result = await callBYOKProvider(provider, effectiveKey, 'Say "hello" in one word.', {});
            return { success: true, provider, response: result.text.slice(0, 100), responseTimeMs: result.responseTimeMs };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    const { fetchModels: fetchBYOKModels } = require('../api/byok/model-fetcher.cjs');

    ipcMain.handle('byok-fetch-models', async (_, provider, key) => {
        try {
            const effectiveKey = (key && key.trim()) || byokKeys.getKey(provider);
            if (!effectiveKey) {
                return { success: false, models: [], error: `No API key for ${provider}.` };
            }
            return await fetchBYOKModels(provider, effectiveKey);
        } catch (e) {
            return { success: false, models: [], error: e.message };
        }
    });

    ipcMain.handle('byok-save-model', (_, provider, modelId) => {
        try {
            byokKeys.saveSelectedModel(provider, modelId || null);
            return { success: true, provider, model: modelId || null };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('byok-get-model', (_, provider) => {
        try {
            const model = byokKeys.getSelectedModel(provider);
            return { success: true, provider, model };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('byok-get-models', (_, provider) => {
        try {
            const models = byokKeys.getModels(provider);
            return { success: true, provider, models };
        } catch (e) {
            return { success: false, models: [], error: e.message };
        }
    });

    ipcMain.handle('byok-add-model', (_, provider, modelId) => {
        try {
            const added = byokKeys.addModel(provider, modelId);
            return { success: true, provider, model: modelId, added };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('byok-remove-model', (_, provider, modelId) => {
        try {
            byokKeys.removeModel(provider, modelId);
            return { success: true, provider, model: modelId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('byok-toggle-model', (_, provider, modelId, enabled) => {
        try {
            byokKeys.toggleModel(provider, modelId, enabled);
            return { success: true, provider, model: modelId, enabled };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

}

module.exports = { registerSettingsHandlers };
