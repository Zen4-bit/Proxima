// Proxima — BYOK API Key Storage.
// Manages encrypted BYOK keys, configuration metadata, and active models.

'use strict';

const fs = require('fs');
const path = require('path');

const ENC_VERSION = 1;

let _storeCache = null;

const KNOWN_PROVIDERS = Object.freeze([
    'chatgpt', 'claude', 'gemini', 'perplexity',
    'deepseek', 'groq', 'xai', 'openrouter', 'together', 'fireworks', 'mistral', 'nvidia',
]);

const VALID_PROVIDERS = KNOWN_PROVIDERS;

function _getStoragePath() {
    try {
        const { app } = require('electron');
        return path.join(app.getPath('userData'), 'byok.json');
    } catch {
        return path.join(
            process.env.APPDATA || path.join(require('os').homedir(), '.config'),
            'proxima', 'byok.json',
        );
    }
}

function _isEncryptionAvailable() {
    try {
        const { safeStorage } = require('electron');
        return safeStorage && safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

function _encrypt(plain) {
    if (_isEncryptionAvailable()) {
        const { safeStorage } = require('electron');
        const cipher = safeStorage.encryptString(plain);
        return { enc: ENC_VERSION, data: cipher.toString('base64') };
    }
    return { plain };
}

function _decrypt(envelope) {
    if (!envelope) return null;

    if (envelope.enc === ENC_VERSION && typeof envelope.data === 'string') {
        if (!_isEncryptionAvailable()) {
            console.error('[BYOK] Encrypted key found but OS encryption unavailable — cannot decrypt.');
            return null;
        }
        try {
            const { safeStorage } = require('electron');
            return safeStorage.decryptString(Buffer.from(envelope.data, 'base64'));
        } catch (e) {
            console.error('[BYOK] Decryption failed:', e.message);
            return null;
        }
    }

    if (typeof envelope.plain === 'string') {
        return envelope.plain;
    }

    return null;
}

function _readStore() {
    try {
        const filePath = _getStoragePath();
        if (!fs.existsSync(filePath)) {
            _storeCache = null;
            return {};
        }
        const currentMtime = fs.statSync(filePath).mtimeMs;
        if (_storeCache && _storeCache.filePath === filePath && _storeCache.mtimeMs === currentMtime) {
            return _storeCache.data;
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        _storeCache = { data, mtimeMs: currentMtime, filePath };
        return data;
    } catch (e) {
        console.error('[BYOK] Failed to read key store:', e.message);
        _storeCache = null;
        return {};
    }
}

function _writeStore(store) {
    const filePath = _getStoragePath();
    const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
        try { fs.chmodSync(tmpPath, 0o600); } catch (_) { }
        fs.renameSync(tmpPath, filePath);
        try { fs.chmodSync(filePath, 0o600); } catch (_) { }
        try {
            _storeCache = { data: store, mtimeMs: fs.statSync(filePath).mtimeMs, filePath };
        } catch { _storeCache = null; }
    } catch (e) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { }
        console.error('[BYOK] Failed to write key store:', e.message);
        throw new Error(`Failed to persist BYOK key store: ${e.message}`);
    }
}

function _validateProvider(provider) {
    const normalized = String(provider || '').toLowerCase().trim();
    if (!normalized || normalized.length < 2) {
        throw new Error(`Invalid BYOK provider: name must be at least 2 characters.`);
    }
    if (!/^[a-z0-9_-]+$/.test(normalized)) {
        throw new Error(`Invalid BYOK provider: "${provider}". Only letters, numbers, dashes, underscores allowed.`);
    }
    if (normalized.startsWith('_')) {
        throw new Error(`Invalid BYOK provider: "${provider}". Names starting with "_" are reserved.`);
    }
    return normalized;
}

function _validateEndpoint(endpoint) {
    let u;
    try {
        u = new URL(endpoint);
    } catch {
        throw new Error('Custom provider endpoint must be a valid URL (e.g. https://api.example.com/v1/chat/completions).');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error(`Custom provider endpoint must use http or https, got "${u.protocol}".`);
    }
    return endpoint;
}

function saveKey(provider, plainKey, options = {}) {
    provider = _validateProvider(provider);
    if (!plainKey || typeof plainKey !== 'string' || plainKey.trim().length < 5) {
        throw new Error('API key must be a non-empty string (minimum 5 characters).');
    }

    if (options.endpoint) {
        _validateEndpoint(options.endpoint);
    }

    const store = _readStore();
    const existing = store[provider] || {};
    store[provider] = {
        key: _encrypt(plainKey.trim()),
        addedAt: new Date().toISOString(),
        ...(existing.selectedModel ? { selectedModel: existing.selectedModel } : {}),
        ...(existing.models ? { models: existing.models } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : (existing.endpoint ? { endpoint: existing.endpoint } : {})),
        ...(options.displayName ? { displayName: options.displayName } : (existing.displayName ? { displayName: existing.displayName } : {})),
    };
    _writeStore(store);
    const isCustom = !KNOWN_PROVIDERS.includes(provider);
    console.log(`[BYOK] Key saved for ${provider}${isCustom ? ' (custom provider)' : ''}.`);
}

function removeKey(provider) {
    provider = _validateProvider(provider);
    const store = _readStore();
    if (store[provider]) {
        delete store[provider];
        _writeStore(store);
        console.log(`[BYOK] Key removed for ${provider}.`);
    }
}

function getKey(provider) {
    try {
        provider = _validateProvider(provider);
    } catch {
        return null;
    }

    const store = _readStore();
    const entry = store[provider];
    if (!entry || !entry.key) return null;

    return _decrypt(entry.key);
}

function hasKey(provider) {
    try {
        provider = _validateProvider(provider);
    } catch {
        return false;
    }
    const store = _readStore();
    return !!(store[provider] && store[provider].key);
}

function listConfigured() {
    const store = _readStore();
    return Object.keys(store).filter(p => store[p] && store[p].key);
}

function getStatus() {
    const store = _readStore();
    const status = {};
    const allProviders = new Set([
        ...KNOWN_PROVIDERS,
        ...Object.keys(store).filter(k => k !== '_meta'),
    ]);
    for (const provider of allProviders) {
        const entry = store[provider];
        status[provider] = entry && entry.key
            ? { configured: true, addedAt: entry.addedAt || null, custom: !KNOWN_PROVIDERS.includes(provider) }
            : { configured: false };
    }
    return status;
}

function isEnabled() {
    const store = _readStore();
    return !!(store._meta && store._meta.enabled);
}

function setEnabled(enabled) {
    const store = _readStore();
    if (!store._meta) store._meta = {};
    store._meta.enabled = !!enabled;
    _writeStore(store);
    console.log(`[BYOK] API Mode ${enabled ? 'ENABLED' : 'DISABLED'}.`);
}

function saveSelectedModel(provider, modelId) {
    provider = _validateProvider(provider);
    const store = _readStore();
    if (!store[provider]) store[provider] = {};

    if (modelId && typeof modelId === 'string' && modelId.trim()) {
        const trimmed = modelId.trim();
        store[provider].selectedModel = trimmed;

        if (!store[provider].models) store[provider].models = [];
        const exists = store[provider].models.find(m => m.id === trimmed);
        if (!exists) {
            store[provider].models.push({
                id: trimmed,
                enabled: true,
                addedAt: new Date().toISOString(),
            });
        }
    } else {
        delete store[provider].selectedModel;
    }
    _writeStore(store);
    console.log(`[BYOK] Model for ${provider}: ${modelId || 'auto (default)'}.`);
}

function getSelectedModel(provider) {
    try {
        provider = _validateProvider(provider);
    } catch {
        return null;
    }
    const store = _readStore();
    const entry = store[provider];
    if (!entry) return null;

    if (entry.selectedModel) return entry.selectedModel;

    if (Array.isArray(entry.models)) {
        const first = entry.models.find(m => m.enabled !== false);
        if (first) return first.id;
    }

    return null;
}

function getModels(provider) {
    try {
        provider = _validateProvider(provider);
    } catch {
        return [];
    }

    const store = _readStore();
    const entry = store[provider];
    if (!entry) return [];

    if (Array.isArray(entry.models) && entry.models.length > 0) {
        return entry.models.map(m => ({
            id: m.id,
            enabled: m.enabled !== false,
            addedAt: m.addedAt || entry.addedAt || null,
        }));
    }

    if (entry.selectedModel) {
        return [{
            id: entry.selectedModel,
            enabled: true,
            addedAt: entry.addedAt || null,
        }];
    }

    return [];
}

function addModel(provider, modelId) {
    provider = _validateProvider(provider);
    if (!modelId || typeof modelId !== 'string' || !modelId.trim()) {
        throw new Error('Model ID must be a non-empty string.');
    }
    const trimmed = modelId.trim();

    const store = _readStore();
    if (!store[provider]) store[provider] = {};
    if (!store[provider].models) store[provider].models = [];

    if (store[provider].models.find(m => m.id === trimmed)) {
        console.log(`[BYOK] Model "${trimmed}" already exists for ${provider}, skipping.`);
        return false;
    }

    store[provider].models.push({
        id: trimmed,
        enabled: true,
        addedAt: new Date().toISOString(),
    });

    if (!store[provider].selectedModel) {
        store[provider].selectedModel = trimmed;
    }

    _writeStore(store);
    console.log(`[BYOK] Model added for ${provider}: ${trimmed}.`);
    return true;
}

function removeModel(provider, modelId) {
    provider = _validateProvider(provider);
    if (!modelId || typeof modelId !== 'string') return;
    const trimmed = modelId.trim();

    const store = _readStore();
    const entry = store[provider];
    if (!entry || !Array.isArray(entry.models)) return;

    const before = entry.models.length;
    entry.models = entry.models.filter(m => m.id !== trimmed);

    if (entry.models.length === before) return;

    if (entry.selectedModel === trimmed) {
        const nextEnabled = entry.models.find(m => m.enabled !== false);
        entry.selectedModel = nextEnabled ? nextEnabled.id : undefined;
        if (!entry.selectedModel) delete entry.selectedModel;
    }

    _writeStore(store);
    console.log(`[BYOK] Model removed for ${provider}: ${trimmed}.`);
}

function toggleModel(provider, modelId, enabled) {
    provider = _validateProvider(provider);
    if (!modelId || typeof modelId !== 'string') return;
    const trimmed = modelId.trim();

    const store = _readStore();
    const entry = store[provider];
    if (!entry || !Array.isArray(entry.models)) return;

    const model = entry.models.find(m => m.id === trimmed);
    if (!model) return;

    model.enabled = !!enabled;

    if (!enabled && entry.selectedModel === trimmed) {
        const nextEnabled = entry.models.find(m => m.enabled && m.id !== trimmed);
        entry.selectedModel = nextEnabled ? nextEnabled.id : undefined;
        if (!entry.selectedModel) delete entry.selectedModel;
    }

    if (enabled && !entry.selectedModel) {
        entry.selectedModel = trimmed;
    }

    _writeStore(store);
    console.log(`[BYOK] Model ${trimmed} for ${provider}: ${enabled ? 'ENABLED' : 'DISABLED'}.`);
}

module.exports = {
    saveKey,
    removeKey,
    getKey,
    hasKey,
    listConfigured,
    getStatus,
    isEnabled,
    setEnabled,
    saveSelectedModel,
    getSelectedModel,
    getModels,
    addModel,
    removeModel,
    toggleModel,
    VALID_PROVIDERS,
    KNOWN_PROVIDERS,
    _readStore,
};
