// Proxima — BYOK Conversation Memory.
// Persists stateless provider conversation histories to local JSON storage.

'use strict';

const fs = require('fs');
const path = require('path');

function _getMemoryDir() {
    try {
        const { app } = require('electron');
        return path.join(app.getPath('userData'), 'byok-memory');
    } catch {
        return path.join(
            process.env.APPDATA || path.join(require('os').homedir(), '.config'),
            'proxima', 'byok-memory'
        );
    }
}

function _getFilePath(conversationId) {
    if (!conversationId || typeof conversationId !== 'string') {
        return null;
    }
    const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return null;
    return path.join(_getMemoryDir(), `${safeId}.json`);
}

function load(conversationId) {
    const filePath = _getFilePath(conversationId);
    if (!filePath || !fs.existsSync(filePath)) {
        return [];
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data.messages) ? data.messages : [];
    } catch (e) {
        console.error(`[BYOK/Memory] Failed to load memory for ${conversationId}:`, e.message);
        return [];
    }
}

function save(conversationId, messages) {
    const filePath = _getFilePath(conversationId);
    if (!filePath) return;

    const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const payload = {
            conversationId,
            messages,
            updatedAt: Date.now(),
        };

        fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tempPath, filePath);
    } catch (e) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { }
        console.error(`[BYOK/Memory] Failed to save memory for ${conversationId}:`, e.message);
    }
}

function clear(conversationId) {
    const filePath = _getFilePath(conversationId);
    if (filePath && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch (e) {
            console.error(`[BYOK/Memory] Failed to clear memory for ${conversationId}:`, e.message);
        }
    }
}

function clearProvider(provider) {
    if (!provider) return;
    const dir = _getMemoryDir();
    if (!fs.existsSync(dir)) return;

    try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            const filePath = path.join(dir, file);
            try {
                const raw = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(raw);
                const cid = data.conversationId || '';
                if (cid === provider || cid.startsWith(`${provider}:`) || cid.startsWith(`provider:${provider}`)) {
                    fs.unlinkSync(filePath);
                }
            } catch { }
        }
        console.log(`[BYOK/Memory] Cleared memory for provider: ${provider}`);
    } catch (e) {
        console.error(`[BYOK/Memory] Failed to clear provider memory for ${provider}:`, e.message);
    }
}

module.exports = {
    load,
    save,
    clear,
    clearProvider,
};
