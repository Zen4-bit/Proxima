// Proxima — MCP Search Tools.
// Registers web search, UI reference, scraper, and DuckDuckGo search tools.

// Safe DNS resolver for web scraping.
import webScraperTools from '../tools/web-scraper.cjs';
const { _resolveSafe } = webScraperTools;

export function register(server, deps) {
    const {
        z, toolResponse, toolError,
        smartChat, buildMessageWithFiles, readFileContents,
        resolveProvider,
    } = deps;


    const READ_OPEN = Object.freeze({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    });

    const FETCH = Object.freeze({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    });

    server.registerTool('deep_search', {
        title: 'Deep Search (AI research)',
        description: 'AI-powered research with typed prompts (web, reddit, github, news, math, academic, factcheck, stats). Best for sourced research; for a raw page fetch use web_scrape, for raw links use ddg_search.',
        inputSchema: {
            query: z.string().describe('Search query or research question'),
            type: z.enum(['web', 'reddit', 'github', 'news', 'math', 'academic', 'factcheck', 'stats']).optional().describe('Search type (default: web). reddit, github, news, math, academic, factcheck, stats'),
            language: z.string().optional().describe('For github: programming language filter (e.g., JavaScript, Python)'),
            timeframe: z.string().optional().describe('For news: timeframe like "today", "this week", "2024"'),
            year: z.string().optional().describe('For stats: specific year'),
            files: z.array(z.string()).optional().describe('Optional: file paths for context. Supports line ranges like "path/file.js:10-50"'),
            provider: z.string().optional().describe('AI provider: chatgpt, claude, gemini, perplexity, or any configured BYOK provider. Default: auto-select'),
        },
        annotations: READ_OPEN,
    }, async ({ query, type, language, timeframe, year, files, provider: pn }) => {
        const p = resolveProvider(pn, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const prompts = {
                web: query,
                reddit: `Search Reddit discussions about: ${query}`,
                github: `Search GitHub for open source repositories, code examples, and solutions${language ? ` in ${language}` : ''}: ${query}\n\nFor each result provide: repo name, description, stars/popularity, key features, and the GitHub URL. Focus on actively maintained, well-documented projects.`,
                news: `Latest news${timeframe ? ` from ${timeframe}` : ''}: ${query}`,
                math: `Solve and explain step by step in plain text (use text notation, not LaTeX rendering): ${query}`,
                academic: `Academic research: ${query}. Cite peer-reviewed sources.`,
                factcheck: `Fact check with sources: ${query}`,
                stats: `Find statistics and data${year ? ` for ${year}` : ''}: ${query}`,
            };
            const prompt = prompts[type || 'web'] || query;
            const fullQuery = buildMessageWithFiles(prompt, files);
            return toolResponse(await smartChat(fullQuery, p));
        } catch (err) { return toolError(err); }
    });

    server.registerTool('get_ui_reference', {
        title: 'UI/UX Design Reference',
        description: 'Get a premium UI/UX design reference (colors, typography, layout, components, a11y), optionally improving existing code. For general code generation use generate_code.',
        inputSchema: {
            description: z.string().describe('Describe the UI/UX you need — what kind of page, component, layout, or design style you want'),
            code: z.string().optional().describe('Optional: existing code to analyze and apply design improvements on'),
            files: z.array(z.string()).optional().describe('Optional: file paths of existing code to improve with better UI/UX. Supports line ranges like "path/file.js:10-50"'),
            style: z.string().optional().describe('Design style preference: modern, minimal, glassmorphism, dark, corporate, playful, etc.'),
            provider: z.string().optional().describe('AI provider: chatgpt, claude, gemini, perplexity, or any configured BYOK provider. Default: auto-select best for coding'),
        },
        annotations: READ_OPEN,
    }, async ({ description, code, files, style, provider: pn }) => {
        try {
            const p = resolveProvider(pn, 'coding');
            if (!p) return toolResponse('No providers enabled');

            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${code || ''}` : (code || '');
            const styleHint = style ? `\nDESIGN STYLE: ${style}` : '';

            let prompt;
            if (fullCode.trim()) {
                prompt = `You are a senior UI/UX designer and frontend developer. Analyze the existing code and apply premium design improvements.\n\nDESIGN REQUEST: ${description}${styleHint}\n\nEXISTING CODE:\n${fullCode}\n\nProvide:\n1. **DESIGN ANALYSIS**: Current UI analysis\n2. **COLOR PALETTE**: Recommended hex colors\n3. **TYPOGRAPHY**: Font families, sizes, weights\n4. **LAYOUT & SPACING**: Grid, padding, margins, breakpoints\n5. **COMPONENTS**: Key UI components\n6. **UX PATTERNS**: Interactions, hover effects, transitions\n7. **UPDATED CODE**: Complete updated code, production-ready\n\nThe updated code must be complete, ready to copy-paste and run.`;
            } else {
                prompt = `You are a senior UI/UX designer. Provide a comprehensive design reference.\n\nDESIGN REQUEST: ${description}${styleHint}\n\nProvide:\n1. **DESIGN CONCEPT**: Overall look and feel\n2. **COLOR PALETTE**: Complete hex color scheme\n3. **TYPOGRAPHY**: Google Fonts, sizes, weights\n4. **LAYOUT**: Page structure, grid, responsive\n5. **KEY COMPONENTS**: UI components with specs\n6. **UX PATTERNS**: Navigation, interactions, micro-animations\n7. **CSS DESIGN TOKENS**: CSS custom properties\n8. **ACCESSIBILITY**: Contrast, focus indicators, ARIA\n\nBe specific with exact values.`;
            }

            const response = await smartChat(prompt, p);
            return toolResponse(response);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('web_scrape', {
        title: 'Web Scrape (URL → Markdown)',
        description: 'Fetch a single URL and convert the page to clean Markdown (SSRF-guarded). Use for a known page; use ddg_search to find URLs, or deep_search for AI research.',
        inputSchema: {
            url: z.string().describe('URL to scrape and convert to markdown'),
            timeout: z.number().optional().describe('Timeout in ms (default 15000)'),
        },
        annotations: FETCH,
    }, async ({ url, timeout }) => {
        try {
            const https = await import('https');
            const http = await import('http');
            const { URL: NodeURL } = await import('url');

            const MAX_REDIRECTS = 5;
            const MAX_SIZE = 5 * 1024 * 1024; // 5MB cap — avoid OOM on huge/binary bodies

            const fetchPage = async (target, depth = 0) => {
                const { parsed: p, address, family } = await _resolveSafe(target);
                const client = p.protocol === 'https:' ? https.default : http.default;
                return await new Promise((resolve, reject) => {
                    const req = client.request({
                        host: address, family, servername: p.hostname,
                        port: p.port || (p.protocol === 'https:' ? 443 : 80),
                        path: p.pathname + p.search, method: 'GET',
                        headers: { 'Host': p.host, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0', 'Accept': 'text/html,*/*' },
                        timeout: timeout || 15000,
                    }, (res) => {
                        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
                            res.resume();
                            if (depth >= MAX_REDIRECTS) return reject(new Error('Blocked: too many redirects'));
                            const newUrl = res.headers.location.startsWith('http') ? res.headers.location : new NodeURL(res.headers.location, target).href;
                            return fetchPage(newUrl, depth + 1).then(resolve, reject);
                        }
                        const chunks = []; let total = 0;
                        res.on('data', c => {
                            total += c.length;
                            if (total > MAX_SIZE) { req.destroy(); return reject(new Error('Response too large (>5MB)')); }
                            chunks.push(c);
                        });
                        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
                    });
                    req.on('error', e => reject(e));
                    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                    req.end();
                });
            };

            const html = await fetchPage(url);
            let md = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<svg[\s\S]*?<\/svg>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
            const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            const title = titleMatch ? titleMatch[1].trim() : '';
            md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
                .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
                .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
                .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
                .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
                .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
                .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
                .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
                .replace(/<br\s*\/?>/gi, '\n').replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
                .replace(/<hr[^>]*\/?>/gi, '\n---\n').replace(/<[^>]*>/g, '')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
                .replace(/\n{4,}/g, '\n\n\n').trim();
            let output = '';
            if (title) output += `# ${title}\n\n`;
            output += `> Source: ${url}\n\n${md}`;
            return toolResponse(output);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('ddg_search', {
        title: 'DuckDuckGo Search (free links)',
        description: 'Free web search via DuckDuckGo returning ranked title/URL/snippet results (no API key). Use to find pages; use web_scrape to read one, or deep_search for AI-synthesized research.',
        inputSchema: {
            query: z.string().describe('Search query'),
            maxResults: z.number().optional().describe('Max results (default 8)'),
        },
        annotations: FETCH,
    }, async ({ query, maxResults }) => {
        try {
            const https = await import('https');
            const { URL: NodeURL } = await import('url');
            const max = maxResults || 8;
            const MAX_REDIRECTS = 5;
            const MAX_SIZE = 5 * 1024 * 1024; // 5MB cap

            const fetchPage = async (target, depth = 0) => {

                const { parsed: p, address, family } = await _resolveSafe(target);
                return await new Promise((resolve, reject) => {
                    const req = https.default.request({
                        host: address, family, servername: p.hostname,
                        port: p.port || 443,
                        path: p.pathname + p.search, method: 'GET',
                        headers: { 'Host': p.host, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0', 'Accept': 'text/html,*/*' },
                        timeout: 10000,
                    }, (res) => {
                        if ([301,302,303,307].includes(res.statusCode) && res.headers.location) {
                            res.resume();
                            if (depth >= MAX_REDIRECTS) return reject(new Error('Blocked: too many redirects'));
                            const newUrl = res.headers.location.startsWith('http') ? res.headers.location : new NodeURL(res.headers.location, target).href;
                            return fetchPage(newUrl, depth + 1).then(resolve, reject);
                        }
                        const chunks = []; let total = 0;
                        res.on('data', c => {
                            total += c.length;
                            if (total > MAX_SIZE) { req.destroy(); return reject(new Error('Response too large (>5MB)')); }
                            chunks.push(c);
                        });
                        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
                    });
                    req.on('error', e => reject(e));
                    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                    req.end();
                });
            };

            const html = await fetchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
            const results = [];
            const titleMatches = html.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi) || [];
            const snippetMatches = html.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi) || [];

            for (let i = 0; i < Math.min(titleMatches.length, max); i++) {
                const tMatch = titleMatches[i].match(/href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
                if (!tMatch) continue;
                let url = tMatch[1];
                let title = tMatch[2].replace(/<[^>]*>/g, '').trim();
                if (url.includes('uddg=')) { const u = url.match(/uddg=([^&]*)/); if (u) url = decodeURIComponent(u[1]); }
                let snippet = i < snippetMatches.length ? snippetMatches[i].replace(/<[^>]*>/g, '').trim() : '';
                if (title && url.startsWith('http')) results.push({ position: i+1, title, url, snippet });
            }

            let md = `# 🔍 Search: "${query}"\n\n*${results.length} results via DuckDuckGo (free, no API key)*\n\n---\n\n`;
            for (const r of results) {
                md += `### ${r.position}. ${r.title}\n🔗 ${r.url}\n\n${r.snippet}\n\n---\n\n`;
            }
            return toolResponse(md);
        } catch (err) { return toolError(err); }
    });
}
