// Proxima — Codebase Packer.
// Scans, packages, and hashes directories into AI-friendly context strings, identifying potential secrets.

import fs from 'fs';
import path from 'path';
import { generateTreeStringWithLineCounts, getTreeStats, generateFileTree } from './file-tree.js';

const DEFAULT_CONFIG = {
    maxFiles: 150,
    maxFileSizeKB: 512,
    maxTotalSizeMB: 5,
    respectGitignore: true,
    includeHidden: false,
};

const CODE_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.pyw',
    '.java', '.kt', '.kts',
    '.cpp', '.c', '.h', '.hpp', '.cc',
    '.cs',
    '.go',
    '.rs',
    '.rb',
    '.php',
    '.swift',
    '.dart',
    '.vue', '.svelte',
    '.html', '.htm', '.css', '.scss', '.less', '.sass',
    '.json', '.yaml', '.yml', '.toml', '.xml',
    '.md', '.mdx', '.txt', '.rst',
    '.sql',
    '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
    '.env.example', '.gitignore', '.dockerignore',
    '.sol',
    '.r', '.R',
    '.lua',
    '.ex', '.exs',
    '.elm',
    '.zig',
]);

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg',
    'dist', 'build', 'out', '.next', '.nuxt',
    '__pycache__', '.pytest_cache', '.mypy_cache',
    'venv', '.venv', 'env',
    '.idea', '.vscode', '.vs',
    'coverage', '.nyc_output',
    '.cache', '.temp', '.tmp',
    'vendor', 'bower_components',
    '.terraform', '.serverless',
]);

const SKIP_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    'composer.lock', 'Gemfile.lock', 'Cargo.lock',
    'poetry.lock', 'Pipfile.lock',
    '.DS_Store', 'Thumbs.db', 'desktop.ini',
]);

const SECRET_PATTERNS = [
    { name: 'AWS Access Key', pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/ },
    { name: 'AWS Secret Key', pattern: /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}/i },
    { name: 'GitHub Token', pattern: /\b(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{36,}\b/ },
    { name: 'GitLab Token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
    { name: 'Slack Token', pattern: /\bxox[bpors]-[A-Za-z0-9-]{10,}\b/ },
    { name: 'Slack Webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
    { name: 'Google API Key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/ },
    { name: 'Private Key', pattern: /-----BEGIN\s+(RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/ },
    { name: 'Generic API Key', pattern: /\b(api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_\-/.]{20,}['"]/i },
    { name: 'JWT Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
    { name: 'NPM Token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
    { name: 'Stripe Key', pattern: /\b(sk_live_|pk_live_|sk_test_|pk_test_)[A-Za-z0-9]{20,}\b/ },
    { name: 'Database URL', pattern: /(mongodb|postgres|mysql|redis):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/i },
    { name: 'Bearer Token', pattern: /[Bb]earer\s+[A-Za-z0-9_\-/.]{20,}/ },
    { name: 'Heroku API Key', pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/ },
];

function parseGitignore(rootDir) {
    const gitignorePath = path.join(rootDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return [];

    try {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        return content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
            .map(line => {
                const cleaned = line.replace(/^\//, '').replace(/\/$/, '');
                return cleaned;
            });
    } catch {
        return [];
    }
}

function isGitignored(relativePath, gitignorePatterns) {
    const parts = relativePath.split(/[/\\]/);
    for (const pattern of gitignorePatterns) {
        if (parts.includes(pattern)) return true;
        if (pattern.startsWith('*.')) {
            const ext = pattern.slice(1);
            if (relativePath.endsWith(ext)) return true;
        }
        if (relativePath.startsWith(pattern)) return true;
    }
    return false;
}

export function scanDirectory(rootDir, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const gitignorePatterns = cfg.respectGitignore ? parseGitignore(rootDir) : [];

    const files = [];
    const skipped = [];
    let totalSize = 0;

    function walk(dir) {
        if (files.length >= cfg.maxFiles) return;

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (files.length >= cfg.maxFiles) break;

            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

            if (!cfg.includeHidden && entry.name.startsWith('.')) {
                continue;
            }

            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                if (isGitignored(relativePath, gitignorePatterns)) continue;

                walk(fullPath);
            } else if (entry.isFile()) {
                if (SKIP_FILES.has(entry.name)) continue;
                if (isGitignored(relativePath, gitignorePatterns)) continue;

                const ext = path.extname(entry.name).toLowerCase();
                if (!CODE_EXTENSIONS.has(ext) && !entry.name.includes('.env.example')) {
                    continue;
                }

                try {
                    const stats = fs.statSync(fullPath);
                    const sizeKB = stats.size / 1024;
                    if (sizeKB > cfg.maxFileSizeKB) {
                        skipped.push(`${relativePath} (${sizeKB.toFixed(0)}KB > ${cfg.maxFileSizeKB}KB limit)`);
                        continue;
                    }

                    totalSize += stats.size;
                    if (totalSize / (1024 * 1024) > cfg.maxTotalSizeMB) {
                        skipped.push(`Total size limit reached (${cfg.maxTotalSizeMB}MB)`);
                        return;
                    }

                    files.push({
                        path: fullPath,
                        relativePath,
                        size: stats.size,
                        ext,
                    });
                } catch {
                    skipped.push(`${relativePath} (read error)`);
                }
            }
        }
    }

    walk(rootDir);
    return { files, skipped };
}

export function scanForSecrets(content, filePath) {
    const detected = [];
    for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(content)) {
            detected.push(name);
        }
    }
    return detected;
}

export function packCodebase(dirPath, options = {}) {
    const startTime = Date.now();

    if (!fs.existsSync(dirPath)) {
        return { success: false, error: `Directory not found: ${dirPath}` };
    }

    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
        return { success: false, error: `Not a directory: ${dirPath}` };
    }

    const { files, skipped } = scanDirectory(dirPath, options);

    if (files.length === 0) {
        return {
            success: false,
            error: `No supported files found in ${dirPath}`,
            skipped,
        };
    }

    const fileContents = [];
    const lineCounts = {};
    const secretWarnings = [];
    let totalTokenEstimate = 0;

    for (const file of files) {
        try {
            const content = fs.readFileSync(file.path, 'utf8');
            const lineCount = content.split('\n').length;
            const tokenEstimate = Math.ceil(content.length / 4);

            lineCounts[file.relativePath] = lineCount;
            totalTokenEstimate += tokenEstimate;

            const secrets = scanForSecrets(content, file.relativePath);
            if (secrets.length > 0) {
                secretWarnings.push({
                    file: file.relativePath,
                    types: secrets,
                });
            }

            fileContents.push({
                relativePath: file.relativePath,
                content,
                lineCount,
                tokenEstimate,
                ext: file.ext,
            });
        } catch (err) {
            skipped.push(`${file.relativePath} (read error: ${err.message})`);
        }
    }

    const allPaths = fileContents.map(f => f.relativePath);
    const fileTree = generateTreeStringWithLineCounts(allPaths, lineCounts);
    const tree = generateFileTree(allPaths);
    const treeStats = getTreeStats(tree);


    const sections = [];

    sections.push(`# Codebase: ${path.basename(dirPath)}`);
    sections.push(`> Packed by Proxima v7.1 Codebase Intelligence`);
    sections.push('');

    sections.push(`## 📊 Summary`);
    sections.push(`- **Files**: ${fileContents.length}`);
    sections.push(`- **Directories**: ${treeStats.directories}`);
    sections.push(`- **Total Lines**: ${Object.values(lineCounts).reduce((a, b) => a + b, 0).toLocaleString()}`);
    sections.push(`- **Est. Tokens**: ~${totalTokenEstimate.toLocaleString()}`);
    if (secretWarnings.length > 0) {
        sections.push(`- **⚠️ Security Warnings**: ${secretWarnings.length} file(s) with potential secrets`);
    }
    if (skipped.length > 0) {
        sections.push(`- **Skipped**: ${skipped.length} file(s)`);
    }
    sections.push('');

    sections.push(`## 📁 File Structure`);
    sections.push('```');
    sections.push(fileTree);
    sections.push('```');
    sections.push('');

    if (secretWarnings.length > 0) {
        sections.push(`## ⚠️ Security Warnings`);
        for (const warn of secretWarnings) {
            sections.push(`- **${warn.file}**: ${warn.types.join(', ')}`);
        }
        sections.push('');
    }

    sections.push(`## 📄 File Contents`);
    sections.push('');

    for (const file of fileContents) {
        const lang = file.ext.slice(1) || 'text';
        sections.push(`### ${file.relativePath}`);
        sections.push(`\`\`\`${lang}`);
        sections.push(file.content);
        sections.push('```');
        sections.push('');
    }

    const packedOutput = sections.join('\n');
    const duration = Date.now() - startTime;

    return {
        success: true,
        packed: packedOutput,
        metrics: {
            totalFiles: fileContents.length,
            totalDirectories: treeStats.directories,
            totalLines: Object.values(lineCounts).reduce((a, b) => a + b, 0),
            totalTokens: totalTokenEstimate,
            totalSizeKB: Math.round(Buffer.byteLength(packedOutput, 'utf8') / 1024),
            packDurationMs: duration,
        },
        fileTree,
        secretWarnings,
        skipped,
    };
}

export function grepContent(content, options = {}) {
    const {
        pattern,
        ignoreCase = false,
        contextLines = 0,
        beforeLines,
        afterLines,
    } = options;

    if (!pattern) {
        return { matches: [], formattedOutput: [], totalMatches: 0 };
    }

    const flags = ignoreCase ? 'gi' : 'g';
    let regex;
    try {
        regex = new RegExp(pattern, flags);
    } catch (err) {
        return { error: `Invalid regex: ${err.message}`, matches: [], totalMatches: 0 };
    }

    const lines = content.split('\n');
    const matches = [];

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(regex);
        if (match) {
            matches.push({
                lineNumber: i + 1,
                line: lines[i],
                matchedText: match[0],
            });
        }
    }

    const finalBefore = beforeLines !== undefined ? beforeLines : contextLines;
    const finalAfter = afterLines !== undefined ? afterLines : contextLines;

    const formattedOutput = [];
    const addedLines = new Set();

    for (const match of matches) {
        const start = Math.max(0, match.lineNumber - 1 - finalBefore);
        const end = Math.min(lines.length - 1, match.lineNumber - 1 + finalAfter);

        if (formattedOutput.length > 0 && start > Math.max(...addedLines) + 1) {
            formattedOutput.push('--');
        }

        for (let i = start; i <= end; i++) {
            if (!addedLines.has(i)) {
                const lineNum = i + 1;
                const prefix = i === match.lineNumber - 1 ? `${lineNum}:` : `${lineNum}-`;
                formattedOutput.push(`${prefix}${lines[i]}`);
                addedLines.add(i);
            }
        }
    }

    return {
        matches,
        formattedOutput,
        totalMatches: matches.length,
        pattern,
    };
}
