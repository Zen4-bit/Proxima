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
        return resolveCandidateDir(base);
    }
    if (process.platform === 'darwin') {
        const base = path.join(home, 'Library', 'Application Support');
        return resolveCandidateDir(base);
    }
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return resolveCandidateDir(xdg);
}

function resolveCandidateDir(base) {
    const packagedDir = path.join(base, 'Proxima');
    const devDir = path.join(base, 'proxima');
    try {
        if (!fs.existsSync(base)) return devDir;
        const entries = fs.readdirSync(base);
        const hasPackaged = entries.includes('Proxima');
        const hasDev = entries.includes('proxima');
        if (hasPackaged && !hasDev) return packagedDir;
        if (hasDev && !hasPackaged) return devDir;
        if (hasPackaged && hasDev) {
            return fs.statSync(packagedDir).mtimeMs > fs.statSync(devDir).mtimeMs ? packagedDir : devDir;
        }
    } catch {}
    return devDir;
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
