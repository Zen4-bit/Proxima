// Proxima — Brain Directory Paths.
// Resolves brain storage paths and manages atomic JSON file operations.

'use strict';

const fs = require('fs');
const path = require('path');

function getBrainDir() {
    try {
        const { app } = require('electron');
        return path.join(app.getPath('userData'), 'byok-brain');
    } catch {
        return path.join(
            process.env.APPDATA || path.join(require('os').homedir(), '.config'),
            'proxima', 'byok-brain'
        );
    }
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function atomicWriteJSON(filePath, data) {
    ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { }
        throw err;
    }
}

function readJSON(filePath) {
    if (!fs.existsSync(filePath)) return null;
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        console.error(`[Brain/Paths] Failed to read ${path.basename(filePath)}:`, err.message);
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.error(`[Brain/Paths] Corrupt JSON in ${path.basename(filePath)}: ${err.message}`);
        try {
            const bak = `${filePath}.corrupt-${Date.now()}`;
            fs.renameSync(filePath, bak);
            console.error(`[Brain/Paths] Quarantined corrupt file → ${path.basename(bak)}`);
        } catch (e2) {
            console.error(`[Brain/Paths] Could not quarantine corrupt file:`, e2.message);
        }
        return null;
    }
}

module.exports = {
    getBrainDir,
    ensureDir,
    atomicWriteJSON,
    readJSON,
};
