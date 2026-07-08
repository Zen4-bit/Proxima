// Proxima — Preload Bridge.
// Exposes agentHub context API to the sandboxed renderer to securely trigger main-process IPC handlers.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHub', {

    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    saveEnabledProviders: () => ipcRenderer.invoke('save-enabled-providers'),

    initProvider: (provider) => ipcRenderer.invoke('init-provider', provider),
    showProvider: (provider) => ipcRenderer.invoke('show-provider', provider),
    hideBrowser: () => ipcRenderer.invoke('hide-browser'),
    checkLoginStatus: (provider) => ipcRenderer.invoke('check-login-status', provider),
    reloadProvider: (provider) => ipcRenderer.invoke('reload-provider', provider),
    openInSystemBrowser: (provider) => ipcRenderer.invoke('open-in-system-browser', provider),

    getMcpConfig: () => ipcRenderer.invoke('get-mcp-config'),
    getIpcPort: () => ipcRenderer.invoke('get-ipc-port'),

    getEnvStatus: () => ipcRenderer.invoke('get-env-status'),
    setupPythonEnv: () => ipcRenderer.invoke('setup-python-env'),
    onPythonEnvProgress: (callback) => {
        // Detach existing listeners to prevent handler leaks on registration.
        ipcRenderer.removeAllListeners('python-env-progress');
        ipcRenderer.on('python-env-progress', (event, line) => callback(line));
    },
    onEnvStatus: (callback) => {
        ipcRenderer.removeAllListeners('env-status');
        ipcRenderer.on('env-status', (event, report) => callback(report));
    },

    setCookies: (provider, cookiesJson) => ipcRenderer.invoke('set-cookies', provider, cookiesJson),
    getCookies: (provider) => ipcRenderer.invoke('get-cookies', provider),
    clearProviderCache: (provider) => ipcRenderer.invoke('clear-provider-cache', provider),

    setFileReferenceEnabled: (enabled) => ipcRenderer.invoke('set-file-reference-enabled', enabled),
    getFileReferenceEnabled: () => ipcRenderer.invoke('get-file-reference-enabled'),

    setRestApiEnabled: (enabled) => ipcRenderer.invoke('set-rest-api-enabled', enabled),
    getRestApiEnabled: () => ipcRenderer.invoke('get-rest-api-enabled'),

    generateApiKey: () => ipcRenderer.invoke('generate-api-key'),
    getApiKey: () => ipcRenderer.invoke('get-api-key'),
    revokeApiKey: () => ipcRenderer.invoke('revoke-api-key'),

    byokSaveKey: (provider, key) => ipcRenderer.invoke('byok-save-key', provider, key),
    byokRemoveKey: (provider) => ipcRenderer.invoke('byok-remove-key', provider),
    byokGetStatus: () => ipcRenderer.invoke('byok-get-status'),
    byokSetEnabled: (enabled) => ipcRenderer.invoke('byok-set-enabled', enabled),
    byokTestKey: (provider, key) => ipcRenderer.invoke('byok-test-key', provider, key),

    byokFetchModels: (provider, key) => ipcRenderer.invoke('byok-fetch-models', provider, key),
    byokSaveModel: (provider, modelId) => ipcRenderer.invoke('byok-save-model', provider, modelId),
    byokGetModel: (provider) => ipcRenderer.invoke('byok-get-model', provider),

    byokGetModels: (provider) => ipcRenderer.invoke('byok-get-models', provider),
    byokAddModel: (provider, modelId) => ipcRenderer.invoke('byok-add-model', provider, modelId),
    byokRemoveModel: (provider, modelId) => ipcRenderer.invoke('byok-remove-model', provider, modelId),
    byokToggleModel: (provider, modelId, enabled) => ipcRenderer.invoke('byok-toggle-model', provider, modelId, enabled),

    copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    installCli: () => ipcRenderer.invoke('install-cli'),
    uninstallCli: () => ipcRenderer.invoke('uninstall-cli'),
    isCliInstalled: () => ipcRenderer.invoke('is-cli-installed'),

    onProviderNavigated: (callback) => {
        ipcRenderer.removeAllListeners('provider-navigated');
        ipcRenderer.on('provider-navigated', (event, data) => callback(data));
    },
    onProviderLoaded: (callback) => {
        ipcRenderer.removeAllListeners('provider-loaded');
        ipcRenderer.on('provider-loaded', (event, data) => callback(data));
    },
    onActiveProvider: (callback) => {
        ipcRenderer.removeAllListeners('set-active-provider');
        ipcRenderer.on('set-active-provider', (event, provider) => callback(provider));
    },

    // Auto-Updater
    updaterCheck: () => ipcRenderer.invoke('updater-check'),
    updaterInstall: () => ipcRenderer.invoke('updater-install'),
    onUpdaterStatus: (callback) => {
        ipcRenderer.removeAllListeners('updater-status');
        ipcRenderer.on('updater-status', (event, data) => callback(data));
    }
});
