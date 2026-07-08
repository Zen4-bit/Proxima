// Proxima — Filesystem Paths.
// Resolves OS-specific userdata and data directories, ensuring paths exist.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export function getUserDataDir() {
    if (process.env.PROXIMA_DATA_DIR) {
        return process.env.PROXIMA_DATA_DIR;
    }

    const home = os.homedir();
    if (process.platform === 'win32') {
        const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        return path.join(base, 'proxima');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'proxima');
    }
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(xdg, 'proxima');
}


export function getDataDir() {
    return path.join(getUserDataDir(), 'data');
}


export function ensureDir(dir) {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return true;
    } catch {
        return false;
    }
}


export function dataFile(filename) {
    const dir = getDataDir();
    ensureDir(dir);
    return path.join(dir, filename);
}

export function findBundledResource(relativePath) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, '..', '..');
    const candidate = path.join(root, relativePath);
    try {
        if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
    return null;
}
