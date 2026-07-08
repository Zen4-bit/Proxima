#!/usr/bin/env node
// Proxima — Auto-installs Node dependencies if missing.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');

function depsLookInstalled() {
    if (!existsSync(NM)) return false;
    if (!existsSync(join(NM, 'electron'))) return false;
    // Spot-check dependencies.
    try {
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
        const declared = Object.keys(pkg.dependencies || {});
        for (const name of declared) {
            if (!existsSync(join(NM, ...name.split('/')))) return false;
        }
    } catch { }
    return true;
}

if (depsLookInstalled()) {
    process.exit(0);
}

console.log('[proxima] Node dependencies missing or incomplete — installing (one-time)…');

const npmExec = process.env.npm_execpath;
let cmd, args, opts = { cwd: ROOT, stdio: 'inherit' };
if (npmExec) {
    cmd = process.execPath;
    args = [npmExec, 'install'];
} else {
    cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    args = ['install'];
    opts.shell = true;
}

const r = spawnSync(cmd, args, opts);
if (r.status !== 0) {
    console.error('[proxima] Automatic "npm install" failed. Please run it manually:  npm install');
    process.exit(r.status || 1);
}
console.log('[proxima] Dependencies ready. Starting…');
