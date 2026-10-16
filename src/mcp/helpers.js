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
        const appDataPath = getUserDataFilePath('enabled-providers.json');

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

export function getUserDataFilePath(filename) {
    if (process.env.PROXIMA_DATA_DIR) {
        return path.join(process.env.PROXIMA_DATA_DIR, filename);
    }
    const home = process.env.HOME || '';
    let base;
    if (process.platform === 'win32') {
        base = process.env.APPDATA || path.join(process.env.USERPROFILE || home, 'AppData', 'Roaming');
    } else if (process.platform === 'darwin') {
        base = path.join(home, 'Library', 'Application Support');
    } else {
        base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    }
    const packagedDir = path.join(base, 'Proxima');
    const devDir = path.join(base, 'proxima');
    try {
        if (fs.existsSync(base)) {
            const entries = fs.readdirSync(base);
            const hasPackaged = entries.includes('Proxima');
            const hasDev = entries.includes('proxima');
            if (hasPackaged && !hasDev) return path.join(packagedDir, filename);
            if (hasDev && !hasPackaged) return path.join(devDir, filename);
            if (hasPackaged && hasDev) {
                const fileP = path.join(packagedDir, filename);
                const fileD = path.join(devDir, filename);
                const exP = fs.existsSync(fileP);
                const exD = fs.existsSync(fileD);
                if (exP && !exD) return fileP;
                if (exD && !exP) return fileD;
                if (exP && exD) {
                    return fs.statSync(fileP).mtimeMs > fs.statSync(fileD).mtimeMs ? fileP : fileD;
                }
                return fs.statSync(packagedDir).mtimeMs > fs.statSync(devDir).mtimeMs ? fileP : fileD;
            }
        }
    } catch {}
    return path.join(devDir, filename);
}

export function getByokStorePath() {
    return getUserDataFilePath('byok.json');
}

export function isProviderEnabled(provider, dirname) {
    const base = (provider || '').split(':')[0].toLowerCase();
    return getEnabledProviders(dirname).has(base);
}


export function getAgentHubToken() {
    try {
        const tokenFilePath = getUserDataFilePath('ipc-token.json');

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
        const portFilePath = getUserDataFilePath('ipc-port.json');

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
        const settingsPath = getUserDataFilePath('settings.json');

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

export async function getAvailableModelsList({ ipcClient, getEnabledProviders, refresh = false }) {
    let byokData = { enabled: false, providers: [] };
    if (ipcClient) {
        try {
            const raw = await ipcClient.send('getByokStatus');
            if (raw && raw.success) byokData = raw;
        } catch (e) { }
    }

    const enabled = typeof getEnabledProviders === 'function' ? getEnabledProviders() : new Set(['chatgpt', 'gemini', 'claude', 'perplexity']);
    const enabledSet = enabled instanceof Set ? enabled : new Set(enabled || []);

    const isByokMode = byokData.enabled && byokData.providers && byokData.providers.length > 0;
    const mode = isByokMode ? 'byok' : 'session';
    const providers = {};

    if (isByokMode) {
        for (const p of byokData.providers) {
            providers[p.name] = {
                type: 'byok',
                status: 'ready',
                configuredModel: p.model,
                models: [{
                    id: p.model,
                    name: p.model,
                    description: `BYOK API configured model for ${p.name}`,
                    status: 'ready',
                    tags: ['BYOK', 'API'],
                    exact_usage: {
                        tool: 'ask_model',
                        arguments: { provider: p.name, model: p.model, message: 'Your prompt here' }
                    }
                }]
            };
        }
    } else {
        if (enabledSet.has('chatgpt')) {
            let chatgptModels = [];
            let status = 'ready';
            if (ipcClient) {
                try {
                    const mRes = await ipcClient.send('getProviderModels', 'chatgpt', { refresh: !!refresh });
                    if (mRes && mRes.success && Array.isArray(mRes.models)) {
                        chatgptModels = mRes.models;
                    }
                } catch (e) {
                    status = 'error';
                }
            }

            const formattedChatgptModels = [];
            for (const m of chatgptModels) {
                const slug = m.slug || (m.id && m.id.startsWith('chatgpt:') ? m.id.split(':')[1] : m.id);
                const tag = m.tag || (m.tags && m.tags[0]) || 'Fast';
                formattedChatgptModels.push({
                    id: m.id && m.id.startsWith('chatgpt:') ? m.id : `chatgpt:${slug}`,
                    slug: slug,
                    name: m.name || m.displayName || slug,
                    description: m.description || (slug === 'auto' ? 'Auto-routes to fastest available 5.6+ mini' : `${m.name || slug} (ChatGPT Account Model)`),
                    status: m.status || (m.hasError ? 'degraded' : 'ready'),
                    tags: m.tags || (m.tag ? [m.tag] : [tag]),
                    exact_usage: {
                        tool: 'ask_chatgpt',
                        arguments: { message: 'Your prompt here', model: slug }
                    }
                });
            }

            providers.chatgpt = {
                type: 'session',
                status: status,
                description: 'OpenAI ChatGPT browser session with live dynamic 5.6+ model discovery',
                models: formattedChatgptModels
            };
        }

        if (enabledSet.has('gemini')) {
            let geminiModels = [];
            let status = 'ready';
            if (ipcClient) {
                try {
                    const mRes = await ipcClient.send('getProviderModels', 'gemini', { refresh: !!refresh });
                    if (mRes && mRes.success && Array.isArray(mRes.models) && mRes.models.length > 0) {
                        geminiModels = mRes.models;
                    }
                } catch (e) {
                    status = 'error';
                }
            }

            if (geminiModels.length === 0) {
                geminiModels = [
                    { id: 'gemini:auto', slug: 'auto', name: 'Gemini Auto', description: 'Auto-routing ingestion model', tag: 'Auto Fast', status: 'enabled', supported_thinking_levels: ['low', 'medium', 'high'] },
                    { id: 'gemini:flash', slug: 'flash', name: 'Gemini Flash', description: 'Fast & versatile default engine', tag: 'Fast', status: 'enabled' },
                    { id: 'gemini:pro', slug: 'pro', name: 'Gemini Pro', description: 'Deep coding and complex reasoning', tag: 'Reasoning', status: 'enabled', supported_thinking_levels: ['low', 'medium', 'high'] },
                    { id: 'gemini:latest', slug: 'latest', name: 'Gemini Latest', description: 'High-speed direct model stream', tag: 'High Speed', status: 'enabled' },
                    { id: 'gemini:argon', slug: 'argon', name: 'Gemini Argon', description: 'Advanced multimodal intelligence', tag: 'Pro', status: 'enabled', supported_thinking_levels: ['low', 'medium', 'high'] }
                ];
            }

            const formattedGeminiModels = [];
            for (const g of geminiModels) {
                const slug = g.slug || (g.id && g.id.startsWith('gemini:') ? g.id.split(':')[1] : g.id);
                const tag = g.tag || (g.tags && g.tags[0]) || 'General';
                const exactArgs = { message: 'Your prompt here', model: slug };
                if (g.supported_thinking_levels && g.supported_thinking_levels.length > 0) {
                    exactArgs.thinking_level = 'optional: low | medium | high';
                }

                formattedGeminiModels.push({
                    id: g.id && g.id.startsWith('gemini:') ? g.id : `gemini:${slug}`,
                    slug: slug,
                    name: g.name || g.displayName || slug,
                    description: g.description || (slug === 'auto' ? 'Auto-routes to fastest available Gemini model' : `${g.name || slug} (Gemini Account Model)`),
                    status: g.status || 'ready',
                    tags: g.tags || (g.tag ? [g.tag] : [tag]),
                    supported_thinking_levels: g.supported_thinking_levels || [],
                    exact_usage: {
                        tool: 'ask_gemini',
                        arguments: exactArgs
                    }
                });
            }

            providers.gemini = {
                type: 'session',
                status: status,
                description: 'Google Gemini browser session with live dynamic model discovery & reasoning depth control',
                models: formattedGeminiModels
            };
        }

        if (enabledSet.has('claude')) {
            providers.claude = {
                type: 'session',
                status: 'ready',
                description: 'Anthropic Claude browser session',
                models: [{
                    id: 'claude',
                    slug: 'default',
                    name: 'Claude Session Model',
                    description: 'Active browser session (Claude Latest / Sonnet)',
                    status: 'ready',
                    tags: ['Session', 'Reasoning'],
                    exact_usage: {
                        tool: 'ask_claude',
                        arguments: { message: 'Your prompt here' }
                    }
                }]
            };
        }

        if (enabledSet.has('perplexity')) {
            providers.perplexity = {
                type: 'session',
                status: 'ready',
                description: 'Perplexity AI browser session',
                models: [{
                    id: 'perplexity',
                    slug: 'default',
                    name: 'Perplexity Live Search',
                    description: 'Active browser session with real-time web grounding',
                    status: 'ready',
                    tags: ['Session', 'Search'],
                    exact_usage: {
                        tool: 'ask_perplexity',
                        arguments: { message: 'Your prompt here' }
                    }
                }]
            };
        }
    }

    return {
        mode,
        refreshed: !!refresh,
        timestamp: new Date().toISOString(),
        providers,
        hint: isByokMode
            ? 'BYOK API mode active. Use ask_model(provider, message, model) with configured model IDs.'
            : 'Session mode active. Pass the specified model slug to the designated tool (e.g. ask_chatgpt(message, model="gpt-5-6-mini") or ask_gemini(message, model="flash")).'
    };
}

