// Proxima — Project Rule File Discovery.
// Scans the active repository upward to locate, security-scan, and format instructions rules files.

'use strict';

const fs = require('fs');
const path = require('path');
const scanner = require('../brain/scanner.cjs');

const MAX_FILE_CHARS = 4096;
const MAX_FILES = 3;

const FILE_SPECS = [
    { names: ['.proxima.md', 'PROXIMA.md'] },
    { names: ['AGENTS.md', '.agents.md'] },
    { names: ['.cursorrules'] },
    { names: ['copilot-instructions.md'], subdir: '.github' },
];

function _findGitRoot(start) {
    let current = path.resolve(start);

    for (let i = 0; i < 50; i++) {
        const gitDir = path.join(current, '.git');
        try {
            if (fs.existsSync(gitDir)) {
                return current;
            }
        } catch {
            return null;
        }

        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return null;
}

function _findFile(dir, names, subdir) {
    const searchDir = subdir ? path.join(dir, subdir) : dir;

    for (const name of names) {
        const fullPath = path.join(searchDir, name);
        try {
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                return { name, fullPath };
            }
        } catch {
            continue;
        }
    }

    return null;
}

function _loadFile(fullPath, name) {
    try {
        let content = fs.readFileSync(fullPath, 'utf8');
        let truncated = false;

        if (content.startsWith('---')) {
            const end = content.indexOf('\n---', 3);
            if (end !== -1) {
                content = content.substring(end + 4).trimStart();
            }
        }

        if (content.length > MAX_FILE_CHARS) {
            content = content.substring(0, MAX_FILE_CHARS) + '\n[... truncated — file exceeds 4KB limit]';
            truncated = true;
        }

        const scanResult = scanner.sanitize(content, name);
        if (scanResult.blocked) {
            console.warn(`[Discovery] Blocked ${name}: ${scanResult.threats.join(', ')}`);
            return null;
        }

        return {
            name,
            path: fullPath,
            content: scanResult.content.trim(),
            truncated,
        };
    } catch (err) {
        console.error(`[Discovery] Failed to read ${fullPath}:`, err.message);
        return null;
    }
}

function scan(cwd) {
    const startDir = cwd || process.cwd();
    const gitRoot = _findGitRoot(startDir);
    const stopAt = gitRoot || startDir;

    const files = [];
    const foundSpecs = new Set();

    let current = path.resolve(startDir);

    for (let depth = 0; depth < 50; depth++) {
        for (let specIndex = 0; specIndex < FILE_SPECS.length; specIndex++) {
            if (foundSpecs.has(specIndex)) continue;
            if (files.length >= MAX_FILES) break;

            const spec = FILE_SPECS[specIndex];
            const result = _findFile(current, spec.names, spec.subdir);

            if (result) {
                const loaded = _loadFile(result.fullPath, result.name);
                if (loaded) {
                    files.push(loaded);
                    foundSpecs.add(specIndex);
                }
            }
        }

        if (files.length >= MAX_FILES) break;
        if (current === stopAt) break;

        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return { files, cwd: startDir };
}

function format(scanResult) {
    if (!scanResult || !scanResult.files || scanResult.files.length === 0) {
        return '';
    }

    const blocks = scanResult.files.map(f =>
        `[${f.name}]:\n${f.content}`
    );

    return 'PROJECT CONTEXT (auto-loaded from project files):\n\n' + blocks.join('\n\n');
}

module.exports = {
    scan,
    format,
    MAX_FILE_CHARS,
    MAX_FILES,
    FILE_SPECS,
};
