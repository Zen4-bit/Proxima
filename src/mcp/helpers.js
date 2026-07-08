// Proxima — MCP Helpers.
// Exposes utility functions for file references, provider configs, token management, and IPC ports.

import fs from 'fs';
import path from 'path';

export function getEnabledProviders(dirname) {

    try {
        const byokPath = getByokStorePath();
        if (fs.existsSync(byokPath)) {
            const byokStore = JSON.parse(fs.readFileSync(byokPath, 'utf8'));
            if (byokStore._meta && byokStore._meta.enabled) {
                const apiProviders = Object.keys(byokStore)
                    .filter(k => k !== '_meta' && byokStore[k] && byokStore[k].key);
                if (apiProviders.length > 0) {
                    return new Set(apiProviders);
                }
            }
        }
    } catch (e) { }

    try {
        let appDataPath;
        if (process.platform === 'win32') {
            appDataPath = path.join(process.env.APPDATA || '', 'proxima', 'enabled-providers.json');
        } else if (process.platform === 'darwin') {
            appDataPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'proxima', 'enabled-providers.json');
        } else {
            appDataPath = path.join(process.env.HOME || '', '.config', 'proxima', 'enabled-providers.json');
        }

        if (fs.existsSync(appDataPath)) {
            const data = JSON.parse(fs.readFileSync(appDataPath, 'utf8'));
            return new Set(data.enabled || []);
        }

        if (dirname) {
            const configPath = path.join(dirname, 'enabled-providers.json');
            if (fs.existsSync(configPath)) {
                const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                return new Set(data.enabled || []);
            }
        }
    } catch (e) {
        console.error('[MCP] Error reading enabled providers:', e);
    }

    return new Set(['chatgpt', 'claude', 'gemini', 'perplexity']);
}


export function getByokStorePath() {
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || '', 'proxima', 'byok.json');
    } else if (process.platform === 'darwin') {
        return path.join(process.env.HOME || '', 'Library', 'Application Support', 'proxima', 'byok.json');
    }
    return path.join(process.env.HOME || '', '.config', 'proxima', 'byok.json');
}

export function isProviderEnabled(provider, dirname) {
    return getEnabledProviders(dirname).has(provider);
}


export function getAgentHubToken() {
    try {
        let tokenFilePath;
        if (process.platform === 'win32') {
            tokenFilePath = path.join(process.env.APPDATA || '', 'proxima', 'ipc-token.json');
        } else if (process.platform === 'darwin') {
            tokenFilePath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'proxima', 'ipc-token.json');
        } else {
            tokenFilePath = path.join(process.env.HOME || '', '.config', 'proxima', 'ipc-token.json');
        }

        if (fs.existsSync(tokenFilePath)) {
            const data = JSON.parse(fs.readFileSync(tokenFilePath, 'utf8'));
            if (data && typeof data.token === 'string' && data.token.length > 0) {
                return data.token;
            }
        }
    } catch (e) {

    }
    return null;
}


export function getAgentHubPort() {
    try {
        let portFilePath;
        if (process.platform === 'win32') {
            portFilePath = path.join(process.env.APPDATA || '', 'proxima', 'ipc-port.json');
        } else if (process.platform === 'darwin') {
            portFilePath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'proxima', 'ipc-port.json');
        } else {
            portFilePath = path.join(process.env.HOME || '', '.config', 'proxima', 'ipc-port.json');
        }

        if (fs.existsSync(portFilePath)) {
            const data = JSON.parse(fs.readFileSync(portFilePath, 'utf8'));
            const port = parseInt(data.port, 10);
            if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
        }
    } catch (e) {

    }
    return null;
}

export function getFileReferenceEnabled() {
    try {
        let settingsPath;
        if (process.platform === 'win32') {
            settingsPath = path.join(process.env.APPDATA || '', 'proxima', 'settings.json');
        } else if (process.platform === 'darwin') {
            settingsPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'proxima', 'settings.json');
        } else {
            settingsPath = path.join(process.env.HOME || '', '.config', 'proxima', 'settings.json');
        }

        if (fs.existsSync(settingsPath)) {
            const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            return data.fileReferenceEnabled !== false;
        }
    } catch (e) {
        console.error('[MCP] Error reading file reference setting:', e);
    }
    return true;
}


export function readFileContents(filePaths) {
    if (!filePaths || filePaths.length === 0) return '';
    if (!getFileReferenceEnabled()) return '';

    const CODE_EXTENSIONS = [
        '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h',
        '.css', '.html', '.json', '.xml', '.yaml', '.yml', '.md', '.sql',
        '.sh', '.bash', '.ps1', '.rb', '.go', '.rs', '.php'
    ];
    
    const BINARY_EXTENSIONS = [
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', 
        '.doc', '.docx', '.xls', '.xlsx', '.zip', '.tar', '.gz', '.mp3', '.mp4'
    ];

    const contents = [];

    for (const fileEntry of filePaths) {
        try {
            let actualPath = fileEntry;
            let startLine = null;
            let endLine = null;
            const rangeMatch = fileEntry.match(/^(.+):(\d+)-(\d+)$/);
            if (rangeMatch) {
                actualPath = rangeMatch[1];
                startLine = parseInt(rangeMatch[2]);
                endLine = parseInt(rangeMatch[3]);
            }

            const ext = path.extname(actualPath).toLowerCase();
            if (BINARY_EXTENSIONS.includes(ext)) {
                continue;
            }

            if (!fs.existsSync(actualPath)) {
                contents.push(`[File not found: ${actualPath}]`);
                continue;
            }

            let fileName = path.basename(actualPath);
            let fileContent = fs.readFileSync(actualPath, 'utf8');

            if (startLine && endLine) {
                const lines = fileContent.split('\n');
                const totalLines = lines.length;
                const start = Math.max(1, startLine) - 1;
                const end = Math.min(totalLines, endLine);
                fileContent = lines.slice(start, end).join('\n');
                fileName = `${path.basename(actualPath)} (lines ${startLine}-${endLine} of ${totalLines})`;
            }

            let formattedContent;
            if (CODE_EXTENSIONS.includes(ext)) {
                const lang = ext.slice(1);
                formattedContent = `\`\`\`${lang}\n// File: ${fileName}\n${fileContent}\n\`\`\``;
            } else {
                formattedContent = `--- File: ${fileName} ---\n${fileContent}\n--- End of ${fileName} ---`;
            }

            contents.push(formattedContent);
        } catch (e) {
            contents.push(`[Error reading ${fileEntry}: ${e.message}]`);
        }
    }

    return contents.join('\n\n');
}

export function buildMessageWithFiles(message, files) {
    const fileContents = readFileContents(files);
    return fileContents ? `${fileContents}\n\n${message}` : message;
}

export function toolResponse(result) {
    return {
        content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }]
    };
}

export function toolError(error) {
    return {
        content: [{ type: 'text', text: `Error: ${error.message || error}` }],
        isError: true
    };
}


export function checkDisabled(providerName, dirname) {
    if (!isProviderEnabled(providerName, dirname)) {
        return toolResponse(`${providerName} is disabled. Enable it in Agent Hub.`);
    }
    return null;
}
