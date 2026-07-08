// Proxima — DuckDuckGo Search.
// Implements keyless web search scraping with DuckDuckGo and formats results as markdown.

const https = require('https');
const { URL } = require('url');


const { _resolveSafe } = require('./web-scraper.cjs');

async function searchDDG(query, options = {}) {
    const maxResults = options.maxResults || 8;
    const startTime = Date.now();


    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const html = await fetchPage(searchUrl);
    const results = parseDDGResults(html, maxResults);

    return {
        success: true,
        engine: 'duckduckgo',
        query: query,
        results: results,
        totalResults: results.length,
        searchTimeMs: Date.now() - startTime,
    };
}

function parseDDGResults(html, max = 8) {
    const results = [];

    const resultBlocks = html.match(/<a[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>[\s\S]*?<\/a>/gi) || [];

    const titleMatches = html.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi) || [];
    const snippetMatches = html.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi) || [];

    for (let i = 0; i < Math.min(titleMatches.length, max); i++) {
        const titleMatch = titleMatches[i].match(/href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;

        let url = titleMatch[1];
        let title = titleMatch[2].replace(/<[^>]*>/g, '').trim();


        if (url.includes('uddg=')) {
            const uddgMatch = url.match(/uddg=([^&]*)/);
            if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
        }

        let snippet = '';
        if (i < snippetMatches.length) {
            snippet = snippetMatches[i].replace(/<[^>]*>/g, '').trim();
        }

        if (title && url && url.startsWith('http')) {
            results.push({
                position: i + 1,
                title: title,
                url: url,
                snippet: snippet,
            });
        }
    }


    if (results.length === 0) {
        const altPattern = /<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>)?/gi;
        let match;
        while ((match = altPattern.exec(html)) !== null && results.length < max) {
            const url = match[1];
            const title = match[2].replace(/<[^>]*>/g, '').trim();
            const snippet = match[3] ? match[3].replace(/<[^>]*>/g, '').trim() : '';
            if (title && url) {
                results.push({
                    position: results.length + 1,
                    title, url, snippet,
                });
            }
        }
    }

    return results;
}

function fetchPage(url, depth = 0) {
    const MAX_REDIRECTS = 5;
    const MAX_SIZE = 5 * 1024 * 1024;
    return _resolveSafe(url).then(({ parsed, address, family }) => new Promise((resolve, reject) => {
        const options = {
            host: address,
            family,
            servername: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'Host': parsed.host,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            timeout: 10000,
        };

        const req = https.request(options, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (depth >= MAX_REDIRECTS) return reject(new Error('Too many redirects'));
                const nextUrl = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : new URL(res.headers.location, url).href;
                return fetchPage(nextUrl, depth + 1).then(resolve, reject);
            }
            const chunks = [];
            let total = 0;
            res.on('data', c => {
                total += c.length;
                if (total > MAX_SIZE) {
                    req.destroy();
                    return reject(new Error(`Response too large (>${Math.round(MAX_SIZE / 1024 / 1024)}MB)`));
                }
                chunks.push(c);
            });
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        });
        req.on('error', e => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('Search timeout')); });
        req.end();
    }));
}

function formatResultsMarkdown(searchResult) {
    const { query, results, searchTimeMs } = searchResult;
    let md = `# 🔍 Search Results: "${query}"\n\n`;
    md += `*${results.length} results in ${searchTimeMs}ms via DuckDuckGo*\n\n---\n\n`;

    for (const r of results) {
        md += `### ${r.position}. ${r.title}\n`;
        md += `🔗 ${r.url}\n\n`;
        if (r.snippet) md += `${r.snippet}\n\n`;
        md += `---\n\n`;
    }

    return md;
}

module.exports = { searchDDG, formatResultsMarkdown };
