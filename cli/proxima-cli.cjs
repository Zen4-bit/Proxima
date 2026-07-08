#!/usr/bin/env node

// Proxima CLI.
// Command line interface to interact with Proxima's unified AI gateway (ask, search, translate, debate, audit, brainstorm, compare).

const http = require('http');
const fs = require('fs');
const path = require('path');
let version = '5.0.0';
try { version = require('../package.json').version; } catch (e) { }

const API_HOST = process.env.PROXIMA_HOST || '127.0.0.1';
// Honor custom gateway ports via PROXIMA_REST_PORT or PROXIMA_PORT environment variables.
const API_PORT = parseInt(process.env.PROXIMA_REST_PORT || process.env.PROXIMA_PORT) || 3210;
const API_BASE = `http://${API_HOST}:${API_PORT}`;

const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    purple: '\x1b[35m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
    gray: '\x1b[37m\x1b[2m',
    white: '\x1b[37m',
    bgPurple: '\x1b[45m',
};

function colorize(color, text) { return `${color}${text}${c.reset}`; }
function bold(text) { return colorize(c.bold, text); }
function dim(text) { return colorize(c.dim, text); }
function purple(text) { return colorize(c.purple, text); }
function cyan(text) { return colorize(c.cyan, text); }
function green(text) { return colorize(c.green, text); }
function yellow(text) { return colorize(c.yellow, text); }
function red(text) { return colorize(c.red, text); }
function gray(text) { return colorize(c.gray, text); }
function magenta(text) { return colorize(c.purple, text); }
function hr(title) {
    const termWidth = 70;
    const lineChar = process.platform === 'win32' ? '-' : '─';
    if (!title) return colorize(c.gray, lineChar.repeat(termWidth));
    const titleStr = ` ${title} `;
    const leftLen = 4;
    const rightLen = Math.max(0, termWidth - titleStr.length - leftLen);
    return colorize(c.gray, lineChar.repeat(leftLen)) + colorize(c.bold + c.cyan, titleStr) + colorize(c.gray, lineChar.repeat(rightLen));
}

function apiRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, API_BASE);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method,
            headers: { 'Content-Type': 'application/json' },
            timeout: 120000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); }
                catch { parsed = { raw: data }; }
                if (res.statusCode >= 400) {
                    const detail = parsed && parsed.error
                        ? (parsed.error.message || (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)))
                        : (parsed && parsed.raw ? String(parsed.raw).slice(0, 500) : '');
                    const err = new Error(`Gateway returned HTTP ${res.statusCode}${detail ? `: ${detail}` : ''}`);
                    err.status = res.statusCode;
                    err.data = parsed;
                    reject(err);
                    return;
                }
                resolve({ status: res.statusCode, data: parsed });
            });
        });

        req.on('error', (e) => {
            if (e.code === 'ECONNREFUSED') {
                reject(new Error('Cannot connect to Proxima. Is it running? (npm start)'));
            } else {
                reject(e);
            }
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out (120s). Provider may be slow.'));
        });

        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function startSpinner(text) {
    const frames = process.platform === 'win32'
        ? ['|', '/', '-', '\\']
        : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const interval = setInterval(() => {
        process.stderr.write(`\r${purple(frames[i++ % frames.length])} ${dim(text)}`);
    }, 80);
    return {
        stop: (final) => {
            clearInterval(interval);
            process.stderr.write(`\r${' '.repeat(text.length + 4)}\r`);
            if (final) process.stderr.write(`${final}\n`);
        }
    };
}

const FALLBACK_INFO = {
    mode: 'session',
    providers: ['chatgpt', 'claude', 'gemini', 'perplexity'],
    models: {},
    firstProvider: 'claude'
};

// Query current mode and providers from the gateway, with local fallbacks.
function fetchModelsInfo() {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: API_HOST, port: API_PORT,
            path: '/v1/models', method: 'GET',
            timeout: 2000
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const mode = parsed.mode || 'session';
                    const enabledModels = (parsed.data || []).filter(m => m.status === 'enabled' && m.id !== 'auto' && !m.id.includes('-flash') && m.id !== '3.1-pro' && m.id !== 'gemini:auto');
                    const providers = enabledModels.map(m => m.id);
                    const models = {};
                    enabledModels.forEach(m => { if (m.selectedModel) models[m.id] = m.selectedModel; });
                    resolve({
                        mode,
                        providers: providers.length > 0 ? providers : FALLBACK_INFO.providers,
                        models,
                        firstProvider: providers[0] || FALLBACK_INFO.firstProvider
                    });
                } catch { resolve(FALLBACK_INFO); }
            });
        });
        req.on('error', () => resolve(FALLBACK_INFO));
        req.on('timeout', () => { req.destroy(); resolve(FALLBACK_INFO); });
        req.end();
    });
}

let OUTPUT_JSON = false;

function formatResponse(data) {
    if (OUTPUT_JSON) {
        if (data && data.error) process.exitCode = 1;
        console.log(JSON.stringify(data));
        return;
    }

    // Match all-provider responses before single choices to prevent truncation.
    if (data.model === 'all' && Array.isArray(data.choices) && data.choices.length > 0) {
        console.log();
        data.choices.forEach(choice => {
            const model = choice.model || `Response ${choice.index + 1}`;
            console.log(`${cyan('┌')} ${bold(model.toUpperCase())}${choice.responseTimeMs ? dim(` (${(choice.responseTimeMs / 1000).toFixed(1)}s)`) : ''}`);
            (choice.message?.content || '').split('\n').forEach(line => {
                console.log(`${cyan('│')} ${line}`);
            });
            console.log(`${cyan('└──────────────────')}`);
            console.log();
        });
        return;
    }

    if (data.choices && data.choices.length > 0) {
        const choice = data.choices[0];
        const content = choice.message?.content || choice.text || '';
        const model = data.proxima?.provider || data.model || 'unknown';
        const time = data.proxima?.responseTimeMs;

        console.log();
        console.log(`${purple('┌')} ${bold(model.toUpperCase())}${time ? dim(` (${(time / 1000).toFixed(1)}s)`) : ''}`);
        console.log(`${purple('│')}`);
        content.split('\n').forEach(line => {
            console.log(`${purple('│')} ${line}`);
        });
        console.log(`${purple('└──────────────────')}`);
        return;
    }

    if (data.perspectives) {
        console.log();
        console.log(`${purple('━━━')} ${bold('DEBATE')}: ${data.topic || ''} ${purple('━━━')}`);
        for (const [provider, info] of Object.entries(data.perspectives)) {
            console.log();
            console.log(`${cyan('┌')} ${bold(provider.toUpperCase())} ${dim(`[${info.stance}]`)}`);
            if (info.response) {
                info.response.split('\n').forEach(line => {
                    console.log(`${cyan('│')} ${line}`);
                });
            } else if (info.error) {
                console.log(`${cyan('│')} ${red('Error:')} ${info.error}`);
            }
            console.log(`${cyan('└──────────────────')}`);
        }
        return;
    }

    if (data.error) {
        console.error(`${red('Error:')} ${data.error.message || JSON.stringify(data.error)}`);
        process.exitCode = 1;
        return;
    }

    console.log(JSON.stringify(data, null, 2));
}

function fail(spinner, err) {
    if (spinner) spinner.stop(red('✗ Failed'));
    if (OUTPUT_JSON && err && err.data !== undefined) {
        console.log(JSON.stringify(err.data));
    }
    console.error(red(err && err.message ? err.message : String(err)));
    process.exitCode = 1;
}

function usageError(msg) {
    console.error(red(msg));
    process.exitCode = 1;
}

function readStdin() {
    return new Promise((resolve) => {
        if (process.stdin.isTTY) { resolve(''); return; }

        let data = '';
        let settled = false;
        let idleTimer = null;

        const onData = (chunk) => {
            data += chunk;
            windowMs = IDLE_AFTER_DATA_MS;
            arm();
        };

        const finish = () => {
            if (settled) return;
            settled = true;
            if (idleTimer) clearTimeout(idleTimer);
            process.stdin.removeListener('data', onData);
            process.stdin.removeListener('end', finish);
            process.stdin.removeListener('error', finish);
            resolve(data.trim());
        };

        // Use two-phase timeouts to read piped stdin to completion without hanging if silent.
        const NO_DATA_MS = 500;
        const IDLE_AFTER_DATA_MS = 15000;
        let windowMs = NO_DATA_MS;

        const arm = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(finish, windowMs);
        };

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onData);
        process.stdin.on('end', finish);
        process.stdin.on('error', finish);
        arm();
    });
}

const MULTIMODAL_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.mp3', '.wav', '.mp4'];

function isBinaryOrMultimodal(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    const ext = path.extname(filePath).toLowerCase();
    return MULTIMODAL_EXTENSIONS.includes(ext);
}

function readFileContext(filePath) {
    try {
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) return null;
        if (isBinaryOrMultimodal(resolved)) return null;
        const stat = fs.statSync(resolved);
        if (stat.size > 500 * 1024) return `[File too large: ${(stat.size / 1024).toFixed(0)}KB — max 500KB]`;
        const content = fs.readFileSync(resolved, 'utf8');
        const ext = path.extname(resolved).slice(1) || 'txt';
        return `\n\n--- File: ${path.basename(resolved)} ---\n\`\`\`${ext}\n${content}\n\`\`\``;
    } catch {
        return null;
    }
}

function buildMessage(userMessage, stdinContent, fileFlag) {
    let msg = userMessage || '';

    if (stdinContent) {
        msg = msg
            ? `${msg}\n\n--- Piped Context ---\n\`\`\`\n${stdinContent}\n\`\`\``
            : `Help me with this:\n\`\`\`\n${stdinContent}\n\`\`\``;
    }

    if (fileFlag) {
        // Skip boolean true values from empty --file flags to avoid invalid path operations.
        const files = (Array.isArray(fileFlag) ? fileFlag : [fileFlag])
            .filter((f) => typeof f === 'string' && f.length > 0);
        for (const f of files) {
            if (isBinaryOrMultimodal(f)) {
                continue;
            }
            const content = readFileContext(f);
            if (content) msg += content;
            else msg += `\n\n[File not found: ${f}]`;
        }
    }

    return msg;
}

async function cmdAsk(model, message, filePath = null) {
    const spinner = startSpinner(`Asking ${model}...`);
    try {
        const body = { model, message };
        if (filePath) body.filePath = filePath;
        const { data } = await apiRequest('POST', '/v1/chat/completions', body);
        spinner.stop(green('✓ Response received'));
        formatResponse(data);
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdSearch(query) {
    const spinner = startSpinner('Searching...');
    try {
        const { data } = await apiRequest('POST', '/v1/chat/completions', {
            model: 'perplexity', message: query, function: 'search'
        });
        spinner.stop(green('✓ Results found'));
        formatResponse(data);
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdTranslate(text, to, from) {
    const spinner = startSpinner(`Translating to ${to}...`);
    try {
        const body = { model: 'auto', message: text, function: 'translate', to };
        if (from) body.from = from;
        const { data } = await apiRequest('POST', '/v1/chat/completions', body);
        spinner.stop(green('✓ Translated'));
        formatResponse(data);
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdCode(action, description, language) {
    const _verb = { generate: 'Generating', review: 'Reviewing', explain: 'Explaining', debug: 'Debugging' }[action] || 'Processing';
    const spinner = startSpinner(`${_verb} code...`);
    try {
        const body = { model: 'claude', message: description, function: 'code', action };
        if (language) body.language = language;
        const { data } = await apiRequest('POST', '/v1/chat/completions', body);
        spinner.stop(green('✓ Done'));
        formatResponse(data);
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdDebate(topic) {
    const spinner = startSpinner('Debating across providers...');
    try {
        const { data } = await apiRequest('POST', '/v1/chat/completions', {
            model: 'all', message: topic, function: 'debate'
        });
        spinner.stop(green('✓ Debate complete'));
        formatResponse(data);
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdAudit(code) {
    const spinner = startSpinner('Running security audit...');
    try {
        const { data } = await apiRequest('POST', '/v1/chat/completions', {
            model: 'claude', code, function: 'security_audit'
        });
        spinner.stop(green('✓ Audit complete'));
        formatResponse(data);
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdBrainstorm(topic) {
    const spinner = startSpinner('Brainstorming ideas...');
    try {
        const { data } = await apiRequest('POST', '/v1/chat/completions', {
            model: 'auto', message: topic, function: 'brainstorm'
        });
        spinner.stop(green('✓ Ideas generated'));
        formatResponse(data);
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdAnalyze(urlOrContent, question) {
    const spinner = startSpinner('Analyzing...');
    try {
        const body = { model: 'perplexity', function: 'analyze' };
        if (urlOrContent.startsWith('http')) {
            body.url = urlOrContent;
        } else {
            body.message = urlOrContent;
        }
        if (question) body.question = question;
        const { data } = await apiRequest('POST', '/v1/chat/completions', body);
        spinner.stop(green('✓ Analysis complete'));
        formatResponse(data);
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdCompare(message) {
    const spinner = startSpinner('Querying all providers...');
    try {
        const { data } = await apiRequest('POST', '/v1/chat/completions', {
            model: 'all', message
        });
        spinner.stop(green('✓ All responses received'));
        formatResponse(data);
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdNew(provider) {
    if (!provider) {
        const info = await fetchModelsInfo();
        console.error(red(`Usage: proxima new <provider>   (${info.providers.join(' | ')})`));
        process.exitCode = 1;
        return;
    }
    const spinner = startSpinner(`Starting new ${provider} conversation...`);
    try {
        const { data } = await apiRequest('POST', '/v1/conversations/new', { provider });
        spinner.stop(green('✓ New conversation started'));
        console.log();
        console.log(`${green('✓')} ${data && data.provider ? data.provider : provider} conversation reset.`);
        console.log();
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdFix(errorText, context, filePath = null) {
    const fullMessage = context
        ? `Fix this error. Here's the error and context:\n\nError:\n\`\`\`\n${errorText}\n\`\`\`\n\n${context}`
        : `Fix this error. Explain what went wrong and provide the fix:\n\n\`\`\`\n${errorText}\n\`\`\``;
    const spinner = startSpinner('Analyzing error...');
    try {
        const body = { model: 'auto', message: fullMessage };
        if (filePath) body.filePath = filePath;
        const { data } = await apiRequest('POST', '/v1/chat/completions', body);
        spinner.stop(green('✓ Fix found'));
        formatResponse(data);
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdModels() {
    const spinner = startSpinner('Fetching models...');
    try {
        const { data } = await apiRequest('GET', '/v1/models');
        spinner.stop();
        const mode = data.mode || 'session';
        const isApi = mode === 'api';
        console.log();
        console.log(`  ${purple('⚡')} ${bold('Mode:')} ${isApi ? cyan('API (BYOK)') : green('Session (Browser)')}`);
        console.log();
        console.log(`${bold('  Available Models:')}`);
        console.log();
        (data.data || []).forEach(m => {
            const status = m.status === 'enabled' ? green('● ON ') : red('○ OFF');
            const aliases = m.aliases?.length ? dim(` (${m.aliases.join(', ')})`) : '';
            const modelName = m.selectedModel ? cyan(` → ${m.selectedModel}`) : '';
            const desc = m.description ? dim(` ${m.description}`) : '';
            console.log(`  ${status} ${bold(m.id)}${modelName}${aliases}${desc}`);
        });
        console.log();
        if (isApi) {
            console.log(`  ${dim('Add/remove API keys in Proxima App → Settings → API Mode')}`);
            console.log();
        }
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdStatus() {
    const spinner = startSpinner('Checking status...');
    try {
        const { data } = await apiRequest('GET', '/api/status');
        spinner.stop();
        console.log();
        console.log(`${purple('⚡')} ${bold('Proxima')} v${data.version}`);
        console.log(`${dim('   Port:')} ${data.port}`);
        console.log(`${dim('   Providers:')}`);
        (data.enabledProviders || []).forEach(p => {
            console.log(`     ${green('●')} ${p}`);
        });
        if (data.stats) {
            console.log(`${dim('   Requests:')} ${data.stats.totalRequests} (${data.stats.totalErrors} errors)`);
            console.log(`${dim('   Uptime:')} ${data.stats.uptime}`);
        }
        console.log();
    } catch (e) {
        fail(spinner, e);
    }
}

async function cmdStats() {
    const spinner = startSpinner('Fetching stats...');
    try {
        const { data } = await apiRequest('GET', '/v1/stats');
        spinner.stop();
        console.log();
        console.log(`${bold('Provider Stats:')}`);
        console.log();
        for (const [name, info] of Object.entries(data.providers || {})) {
            console.log(`  ${cyan(bold(name))}`);
            console.log(`    Calls: ${info.calls}  Errors: ${info.errors}`);
            console.log(`    Avg: ${info.avgTime}  Min: ${info.minTime}  Max: ${info.maxTime}`);
            if (info.lastCall) console.log(`    Last: ${dim(info.lastCall)}`);
            console.log();
        }
    } catch (e) {
        fail(spinner, e);
    }
}

async function showHelp() {
    const info = await fetchModelsInfo();
    const isApi = info.mode === 'api';
    const modeLabel = isApi ? cyan('API Mode (BYOK)') : green('Session Mode');
    const p1 = info.firstProvider;
    const providerList = info.providers.join(' | ');
    const modelHint = isApi && info.models[p1] ? dim(` (${info.models[p1]})`) : '';

    const isWindows = process.platform === 'win32';
    const lightning = isWindows ? '>>' : '⚡';
    const dot = isWindows ? '|' : '·';
    const dash = isWindows ? '-' : '—';
    const bullet = isWindows ? '*' : '●';
    const arrow = isWindows ? '->' : '→';

    console.log(`
  ${bold(purple(lightning))} ${bold('Proxima CLI')} ${dim(`v${version}`)}  ${dim(dot)}  ${modeLabel}
  ${dim(`Unified AI Gateway ${dash} Talk to AI from your terminal`)}

  ${hr('CORE ACTIONS')}

  ${cyan('ask')} ${gray('[model]')} "${yellow('message')}"
    ${dim('Chat with any model (defaults to auto).')}
    ${gray('Models:')} ${providerList}
    ${gray('Example:')} proxima ask ${p1} "Review this design"${modelHint}

  ${cyan('compare')} "${yellow('question')}"
    ${dim('Query all active providers and display responses side-by-side.')}

  ${cyan('search')} "${yellow('query')}"
    ${dim('Perform a web search using Perplexity.')}

  ${cyan('code')} ${gray('[action]')} "${yellow('prompt')}"
    ${dim('Generate, review, explain, or debug code.')}
    ${gray('Actions:')} generate ${gray('(default)')}, review, explain, debug
    ${gray('Example:')} proxima code review "def fib(n): ..." --lang python

  ${cyan('fix')} "${yellow('error_text')}"
    ${dim('Get instant solutions for errors or console stack traces.')}
    ${gray('Example:')} npm run build 2>&1 | proxima fix

  ${hr('UTILITIES')}

  ${cyan('debate')} "${yellow('topic')}"       ${dim('Launches a multi-AI debate on the given topic')}
  ${cyan('translate')} "${yellow('text')}" ${yellow('--to')} ${gray('<lang>')}  ${dim('Translate text to a target language (use --from to set source)')}
  ${cyan('audit')} "${yellow('code')}"         ${dim('Performs a security vulnerability scan on code')}
  ${cyan('analyze')} "${yellow('url/text')}"     ${dim('Analyzes a URL or textual content (use --q for custom questions)')}
  ${cyan('brainstorm')} "${yellow('topic')}"   ${dim('Generates creative ideas and suggestions')}
  ${cyan('models')}                   ${dim('Lists available provider models and status')}
  ${cyan('status')}                   ${dim('Checks gateway server connection and health')}
  ${cyan('stats')}                    ${dim('Displays performance and latency metrics')}
  ${cyan('new')} / ${cyan('reset')} ${cyan('<provider>')}  ${dim(`Resets one provider's conversation (${providerList})`)}

  ${hr('CONTEXT FLAGS')}

  ${yellow('--file')} ${gray('<path>')}         ${dim('Include local file content.')}
                      ${gray('Text files are appended as prompt context.')}
                      ${gray('Binary/multimodal files (images/PDFs) are uploaded natively.')}
                      ${gray('Example:')} proxima ask ${isApi ? p1 : 'gemini'} "Describe" --file screenshot.png

  ${yellow('--model')}, ${yellow('-m')} ${gray('<name>')}   ${dim('Override provider or specific engine.')}
                      ${gray('Available:')} ${providerList}${isApi ? '' : `\n                      ${gray('Engines:')} gemini:3.5-flash, gemini:3.1-pro, gemini:3.1-flash-lite, gemini:auto`}

  ${yellow('--lang')}, ${yellow('-l')} ${gray('<lang>')}     ${dim('Specify target programming language for code generation.')}
  ${yellow('--to')} / ${yellow('--from')}         ${dim('Target/source languages for translation.')}
  ${yellow('--json')}                 ${dim('Output raw JSON response (ideal for scripting).')}
${isApi ? `
  ${hr('API MODE (BYOK)')}

  ${dim('You are using API Mode — requests go directly to provider APIs')}
  ${dim('using your own API keys. No browser sessions needed.')}

  ${gray('Active providers & models:')}
${info.providers.map(p => `    ${green(bullet)} ${bold(p)}${info.models[p] ? cyan(` ${arrow} ${info.models[p]}`) : ''}`).join('\n')}

  ${gray('Manage keys:')} Proxima App → Settings → API Mode
  ${gray('Test a key:')} proxima ask ${p1} "Hello"
` : ''}
  ${hr('ENVIRONMENT')}

  ${magenta('PROXIMA_HOST')}        ${dim('Override gateway host (default: 127.0.0.1)')}
  ${magenta('PROXIMA_PORT')}        ${dim('Override gateway port (default: 3210)')}
`);
}

function parseArgs(argv) {
    const args = argv.slice(2);
    const result = { command: null, subcommand: null, positional: [], flags: {}, rawCommand: null };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const val = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : true;
            result.flags[key] = val;
        } else if (arg.startsWith('-') && arg.length === 2) {
            const shortMap = { m: 'model', l: 'lang', t: 'to', f: 'from' };
            const key = shortMap[arg[1]] || arg[1];
            const val = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : true;
            result.flags[key] = val;
        } else if (!result.command) {
            result.command = arg.toLowerCase();
            // Preserve original case for the raw command string to avoid lowercasing query text.
            result.rawCommand = arg;
        } else if (result.command === 'code' && !result.subcommand && ['review', 'explain', 'debug', 'generate'].includes(arg.toLowerCase())) {
            // Limit subcommand detection to the code command to avoid swallowing positional args.
            result.subcommand = arg.toLowerCase();
        } else {
            result.positional.push(arg);
        }
    }

    return result;
}

async function main() {
    const { command, subcommand, positional, flags, rawCommand } = parseArgs(process.argv);

    if (flags.json) OUTPUT_JSON = true;

    const stdinContent = await readStdin();

    if (!command || command === 'help' || flags.help) {
        if (stdinContent) {
            await cmdFix(stdinContent);
            return;
        }
        await showHelp();
        return;
    }

    const fileContext = flags.file ? readFileContext(flags.file) : '';

    switch (command) {
        case 'ask':
        case 'chat': {
            let model = 'auto';
            let message;
            if (positional.length >= 2) {
                model = positional[0];
                message = positional.slice(1).join(' ');
            } else if (positional.length === 1) {
                message = positional[0];
            }
            model = flags.model || model;
            if (!message && !stdinContent) { usageError('Usage: proxima ask [model] "message"'); return; }

            const fileStr = flags.file ? (Array.isArray(flags.file) ? flags.file[0] : flags.file) : null;
            const filePath = fileStr && isBinaryOrMultimodal(fileStr) ? path.resolve(fileStr) : null;
            const fullMsg = buildMessage(message, stdinContent, flags.file);
            await cmdAsk(model, fullMsg, filePath);
            break;
        }

        case 'search': {
            const query = positional.join(' ');
            if (!query) { usageError('Usage: proxima search "query"'); return; }
            await cmdSearch(query);
            break;
        }

        case 'translate': {
            const text = positional.join(' ');
            const to = flags.to;
            if (!text || !to) { usageError('Usage: proxima translate "text" --to Language'); return; }
            await cmdTranslate(text, to, flags.from);
            break;
        }

        case 'code': {
            const action = subcommand || 'generate';
            const desc = positional.join(' ');
            const codeInput = stdinContent || desc;
            if (!codeInput) { usageError('Usage: proxima code [action] "description"'); return; }
            const codeMsg = stdinContent && desc
                ? `${desc}\n\n\`\`\`\n${stdinContent}\n\`\`\``
                : codeInput;
            await cmdCode(action, codeMsg, flags.lang || flags.language);
            break;
        }

        case 'debate': {
            const topic = positional.join(' ');
            if (!topic) { usageError('Usage: proxima debate "topic"'); return; }
            await cmdDebate(topic);
            break;
        }

        case 'audit':
        case 'security': {
            const code = stdinContent || positional.join(' ');
            if (!code) { usageError('Usage: proxima audit "code" or pipe: cat file.js | proxima audit'); return; }
            await cmdAudit(code);
            break;
        }

        case 'fix':
        case 'error': {
            const userDesc = positional.join(' ');
            // Combine piped stdin error text with positional user descriptions.
            const errorText = stdinContent && userDesc
                ? `${userDesc}\n\n\`\`\`\n${stdinContent}\n\`\`\``
                : (userDesc || stdinContent);
            if (!errorText) { usageError('Usage: proxima fix "error" or pipe: command 2>&1 | proxima fix'); return; }
            const fileStr = flags.file ? (Array.isArray(flags.file) ? flags.file[0] : flags.file) : null;
            const filePath = fileStr && isBinaryOrMultimodal(fileStr) ? path.resolve(fileStr) : null;
            await cmdFix(errorText, fileContext, filePath);
            break;
        }

        case 'brainstorm':
        case 'ideas': {
            const topic = positional.join(' ');
            if (!topic) { usageError('Usage: proxima brainstorm "topic"'); return; }
            await cmdBrainstorm(topic);
            break;
        }

        case 'analyze': {
            const content = positional.join(' ');
            if (!content) { usageError('Usage: proxima analyze "url or text"'); return; }
            await cmdAnalyze(content, flags.q || flags.question);
            break;
        }

        case 'compare': {
            const msg = positional.join(' ');
            if (!msg) { usageError('Usage: proxima compare "question"'); return; }
            await cmdCompare(msg);
            break;
        }

        case 'new':
        case 'reset':
            await cmdNew(positional[0] || flags.model);
            break;

        case 'models':
            await cmdModels();
            break;

        case 'status':
            await cmdStatus();
            break;

        case 'stats':
            await cmdStats();
            break;

        default: {
            const quickMessage = [rawCommand || command, ...positional].join(' ');
            const fileStr = flags.file ? (Array.isArray(flags.file) ? flags.file[0] : flags.file) : null;
            const filePath = fileStr && isBinaryOrMultimodal(fileStr) ? path.resolve(fileStr) : null;
            const fullQuickMsg = buildMessage(quickMessage, stdinContent, flags.file);
            await cmdAsk('auto', fullQuickMsg, filePath);
            break;
        }
    }
}

// Execute CLI only when invoked directly, allowing test runners to import helpers.
if (require.main === module) {
    main().catch(e => {
        console.error(red(`Error: ${e.message}`));
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
    buildMessage,
    isBinaryOrMultimodal,
    readFileContext,
    readStdin,
    apiRequest,
    formatResponse,
    fail,
    usageError,
};
