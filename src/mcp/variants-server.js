#!/usr/bin/env node
// Proxima — standalone "variants" MCP server.
// The three local-CLI tools (cli_variants / ask_variant / ask_variants) with
// no dependency on the running app: it probes the CLIs and runs them itself,
// and reads the Multi-AI agent library straight from Proxima's store file when
// one exists. Add it to Claude Desktop / Claude Code / Codex / Cursor as
//     { "command": "node", "args": ["<path>/src/mcp/variants-server.js"] }
// and it works whether or not Proxima is open. (Inside the app, the same
// tools are part of the main proxima server and share its discovery cache and
// concurrency caps; running both is fine.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { register as registerCliTools } from './tools-cli.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const cli = require(path.join(ROOT, 'electron', 'providers', 'cli.cjs'));
const core = require(path.join(ROOT, 'electron', 'ipc', 'multiai-core.cjs'));
const { createVariants } = require(path.join(ROOT, 'electron', 'providers', 'variants.cjs'));

// Proxima's userData folder (where the Multi-AI store lives). PROXIMA_USERDATA
// overrides; otherwise the installed app's profile.
export function userDataDir() {
    if (process.env.PROXIMA_USERDATA) return process.env.PROXIMA_USERDATA;
    if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'proxima');
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'proxima');
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'proxima');
}

export function loadLibraryFrom(dir) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, 'multiai', 'chats.json'), 'utf8'));
        return data && data.uiPrefs && Array.isArray(data.uiPrefs.agentLibrary) ? data.uiPrefs.agentLibrary : [];
    } catch { return []; }
}

export function createBackend({ userData = userDataDir() } = {}) {
    const scratch = path.join(os.tmpdir(), 'proxima-variants');
    return createVariants({
        cli, core,
        loadLibrary: () => loadLibraryFrom(userData),
        dataDir: () => { fs.mkdirSync(scratch, { recursive: true }); return scratch; },
    });
}

function toolResponse(payload) {
    return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}
function toolError(err) {
    return { content: [{ type: 'text', text: `Error: ${err && err.message ? err.message : String(err)}` }], isError: true };
}

export function createServer(backend = createBackend()) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const server = new McpServer({ name: 'proxima-variants', version: pkg.version || '0.0.0' });
    registerCliTools(server, { z, toolResponse, toolError, ipcClient: null, variantsBackend: backend });
    return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const server = createServer();
    const transport = new StdioServerTransport();
    server.connect(transport).then(() => {
        console.error('[proxima-variants] MCP server ready (cli_variants, ask_variant, ask_variants)');
    }).catch((e) => { console.error('[proxima-variants] failed to start:', e.message); process.exit(1); });
}
