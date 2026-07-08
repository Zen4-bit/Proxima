// Proxima — Path Resolution Tests.
// Verifies user data directory layout defaults per-platform, directory creations, dataFile layouts, and bundled resource resolution.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    getUserDataDir,
    getDataDir,
    ensureDir,
    dataFile,
    findBundledResource,
} from '../../src/utils/paths.js';

const ORIG = {
    PROXIMA_DATA_DIR: process.env.PROXIMA_DATA_DIR,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    platform: process.platform,
};

function setPlatform(p) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function resetEnv() {
    delete process.env.PROXIMA_DATA_DIR;
    delete process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;
}

const tmpRoots = [];

test.afterEach(() => {
    resetEnv();
    setPlatform(ORIG.platform);
});

test.after(() => {
    if (ORIG.PROXIMA_DATA_DIR !== undefined) process.env.PROXIMA_DATA_DIR = ORIG.PROXIMA_DATA_DIR;
    if (ORIG.APPDATA !== undefined) process.env.APPDATA = ORIG.APPDATA;
    if (ORIG.XDG_CONFIG_HOME !== undefined) process.env.XDG_CONFIG_HOME = ORIG.XDG_CONFIG_HOME;
    setPlatform(ORIG.platform);
    for (const d of tmpRoots) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
});

test('getUserDataDir: PROXIMA_DATA_DIR override takes precedence on any platform', () => {
    resetEnv();
    process.env.PROXIMA_DATA_DIR = '/custom/override/dir';
    setPlatform('win32');
    assert.equal(getUserDataDir(), '/custom/override/dir');
    setPlatform('linux');
    assert.equal(getUserDataDir(), '/custom/override/dir');
});

test('getUserDataDir: win32 uses APPDATA/proxima', () => {
    resetEnv();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
    assert.equal(getUserDataDir(), path.join('C:\\Users\\me\\AppData\\Roaming', 'proxima'));
});

test('getUserDataDir: darwin uses ~/Library/Application Support/proxima', () => {
    resetEnv();
    setPlatform('darwin');
    const expected = path.join(os.homedir(), 'Library', 'Application Support', 'proxima');
    assert.equal(getUserDataDir(), expected);
});

test('getUserDataDir: linux honours XDG_CONFIG_HOME, else ~/.config', () => {
    resetEnv();
    setPlatform('linux');
    process.env.XDG_CONFIG_HOME = '/home/me/.myconfig';
    assert.equal(getUserDataDir(), path.join('/home/me/.myconfig', 'proxima'));

    delete process.env.XDG_CONFIG_HOME;
    assert.equal(getUserDataDir(), path.join(os.homedir(), '.config', 'proxima'));
});

test('getDataDir: is the "data" subdir of the user data dir', () => {
    resetEnv();
    process.env.PROXIMA_DATA_DIR = '/root/pd';
    assert.equal(getDataDir(), path.join('/root/pd', 'data'));
});

test('ensureDir: creates directory recursively and returns true', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-ensure-'));
    tmpRoots.push(base);
    const nested = path.join(base, 'a', 'b', 'c');
    assert.equal(ensureDir(nested), true);
    assert.ok(fs.existsSync(nested));
    assert.equal(ensureDir(nested), true);
});

test('ensureDir: returns false instead of throwing when path is a file', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-ensure-fail-'));
    tmpRoots.push(base);
    const asFile = path.join(base, 'iamafile');
    fs.writeFileSync(asFile, 'x');
    assert.equal(ensureDir(path.join(asFile, 'child')), false);
});

test('dataFile: returns a path under the data dir and creates the dir', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-datafile-'));
    tmpRoots.push(base);
    resetEnv();
    process.env.PROXIMA_DATA_DIR = base;
    const f = dataFile('cost-log.json');
    assert.equal(f, path.join(base, 'data', 'cost-log.json'));
    assert.ok(fs.existsSync(path.join(base, 'data')));
    assert.ok(!fs.existsSync(f), 'dataFile does not create the file itself');
});

test('findBundledResource: finds a real shipped file, null for a missing one', () => {
    const found = findBundledResource('package.json');
    assert.ok(found, 'package.json should be locatable');
    assert.ok(fs.existsSync(found));
    assert.equal(findBundledResource('definitely/not/here-xyz.json'), null);
});
