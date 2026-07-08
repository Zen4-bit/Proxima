// Proxima — Core IPC Handlers.
// Registers ipcMain event handlers for renderer-to-main process settings and browser views management.

const { ipcMain, app, shell, clipboard } = require('electron');
const path = require('path');

function registerCoreHandlers(deps) {
    const { mainWindow, browserManager, loadSettings, saveSettings, saveEnabledProviders, startRestAPI, stopRestAPI, isRestAPIRunning, generateApiKey, revokeApiKey, loadApiKey } = deps;

ipcMain.handle('get-settings', () => {
    return loadSettings();
});

ipcMain.handle('save-settings', (event, settings) => {
    saveSettings(settings);
    return { success: true };
});

ipcMain.handle('save-enabled-providers', () => {
    const settings = loadSettings();
    saveEnabledProviders(settings);
    return { success: true };
});

ipcMain.handle('init-provider', async (event, provider) => {
    try {
        browserManager.createView(provider);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('show-provider', async (event, provider) => {
    try {
        const win = typeof mainWindow === 'function' ? mainWindow() : mainWindow;
        const bounds = await win.webContents.executeJavaScript(`
            (function() {
                const container = document.getElementById('browser-container');
                if (container) {
                    const rect = container.getBoundingClientRect();
                    return {
                        x: Math.round(rect.left),
                        y: Math.round(rect.top),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    };
                }
                return { x: 0, y: 100, width: 1200, height: 700 };
            })()
        `);

        browserManager.showProvider(provider, bounds);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('hide-browser', () => {
    browserManager.hideCurrentView();
    return { success: true };
});

ipcMain.handle('check-login-status', async (event, provider) => {
    try {
        const loggedIn = await browserManager.isLoggedIn(provider);
        return { success: true, provider, loggedIn };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('reload-provider', async (event, provider) => {
    try {
        await browserManager.reload(provider);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-mcp-config', () => {
    const resourcesPath = process.resourcesPath || path.join(__dirname, '..');
    const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked', 'src', 'mcp', 'index.js');

    const isDev = !app.isPackaged;
    const serverPath = isDev
        ? path.join(__dirname, '..', '..', 'src', 'mcp', 'index.js')
        : unpackedPath;

    return {
        mcpServers: {
            'proxima': {
                command: 'node',
                args: [serverPath.replace(/\\/g, '/')]
            }
        }
    };
});

ipcMain.handle('copy-to-clipboard', (event, text) => {
    clipboard.writeText(text);
    return { success: true };
});

ipcMain.handle('open-external', (event, url) => {
    try {
        const u = new URL(String(url || ''));
        // Allow only safe web and mail protocols to prevent local code execution.
        if (!['https:', 'http:', 'mailto:'].includes(u.protocol)) {
            return { success: false, error: 'Blocked non-web URL scheme' };
        }
        shell.openExternal(u.href);
        return { success: true };
    } catch (e) {
        return { success: false, error: 'Invalid URL' };
    }
});

ipcMain.handle('get-ipc-port', () => {
    const settings = loadSettings();
    return settings.ipcPort || 19222;
});

ipcMain.handle('get-env-status', async () => {
    try {
        const pythonEnv = require('../python-env.cjs');
        const envCheck = require('../env-check.cjs');
        const pyStatus = pythonEnv.getStatus();
        return { success: true, python: pyStatus, checks: await envCheck.runChecks(pyStatus) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('setup-python-env', async () => {
    try {
        const pythonEnv = require('../python-env.cjs');
        const win = typeof mainWindow === 'function' ? mainWindow() : mainWindow;
        const result = await pythonEnv.ensureEnvironmentAsync((line) => {
            if (win && !win.isDestroyed()) win.webContents.send('python-env-progress', line);
        });
        return { success: result.ok, ...result, status: pythonEnv.getStatus() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('open-in-system-browser', (event, provider) => {
    const urls = {
        perplexity: 'https://www.perplexity.ai/',
        chatgpt: 'https://chat.openai.com/',
        claude: 'https://claude.ai/',
        gemini: 'https://gemini.google.com/'
    };
    if (urls[provider]) {
        shell.openExternal(urls[provider]);
        return { success: true, provider };
    }
    return { success: false, error: 'Unknown provider' };
});

}

module.exports = { registerCoreHandlers };
