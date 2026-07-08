// Proxima — Web Scraper.
// Fetches a URL, validates safety via DNS/IP resolution, and parses HTML content to clean Markdown.

const https = require('https');
const http = require('http');
const dns = require('dns');
const { URL } = require('url');

function isPrivateIp(ip) {
    if (!ip) return true;
    let addr = String(ip).toLowerCase().trim();
    const zone = addr.indexOf('%');
    if (zone !== -1) addr = addr.slice(0, zone);

    if (addr.startsWith('::ffff:')) {
        const tail = addr.slice(7);
        if (tail.includes('.')) return isPrivateIp(tail);
    }

    if (addr.includes(':')) {
        if (addr === '::1' || addr === '::') return true;
        if (addr.startsWith('fc') || addr.startsWith('fd')) return true;
        if (addr.startsWith('fe8') || addr.startsWith('fe9') ||
            addr.startsWith('fea') || addr.startsWith('feb')) return true;
        return false;
    }

    const parts = addr.split('.');
    if (parts.length !== 4) return true;
    const o = parts.map(n => parseInt(n, 10));
    if (o.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = o;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 0) return true;
    return false;
}

async function _resolveSafe(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); }
    catch { throw new Error(`Blocked: Invalid URL: ${rawUrl}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Blocked: scheme not allowed (${parsed.protocol})`);
    }
    const hostname = (parsed.hostname || '').replace(/^\[|\]$/g, '');
    if (!hostname) throw new Error('Blocked: empty hostname');
    let addrs;
    try { addrs = await dns.promises.lookup(hostname, { all: true }); }
    catch { throw new Error(`Blocked: cannot resolve host (${hostname})`); }
    if (!addrs || !addrs.length) throw new Error(`Blocked: no DNS records (${hostname})`);
    for (const ad of addrs) {
        if (isPrivateIp(ad.address)) {
            throw new Error(`Blocked: private/internal address (${ad.address})`);
        }
    }

    return { parsed, address: addrs[0].address, family: addrs[0].family };
}

async function assertSafeUrl(rawUrl) {
    const { parsed } = await _resolveSafe(rawUrl);
    return parsed;
}

function isBlockedHost(hostname) {
    return isPrivateIp(hostname);
}

function htmlToMarkdown(html, sourceUrl = '') {
    if (!html) return '';

    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '');

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';

    const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
    const description = metaMatch ? metaMatch[1].trim() : '';

    text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
    text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
    text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
    text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
    text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
    text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

    text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
    text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');


    text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, linkText) => {
        const cleanText = linkText.replace(/<[^>]*>/g, '').trim();
        if (!cleanText) return '';
        try {
            const fullUrl = href.startsWith('http') ? href : new URL(href, sourceUrl).href;
            return `[${cleanText}](${fullUrl})`;
        } catch {
            return `[${cleanText}](${href})`;
        }
    });

    text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![$1]($2)');
    text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, '![$2]($1)');
    text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![]($1)');

    text = text.replace(/<pre[^>]*><code[^>]*(?:class=["'][^"']*language-(\w+)[^"']*["'])?[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
        (m, lang, code) => `\n\`\`\`${lang || ''}\n${decodeEntities(code).trim()}\n\`\`\`\n`);
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
    text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

    text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    text = text.replace(/<\/?[ou]l[^>]*>/gi, '\n');

    text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, content) => {
        return content.split('\n').map(l => `> ${l.trim()}`).join('\n');
    });

    text = text.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
        const rows = [];
        const trMatches = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
        for (const tr of trMatches) {
            const cells = [];
            const tdMatches = tr.match(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi) || [];
            for (const td of tdMatches) {
                const cellContent = td.replace(/<[^>]*>/g, '').trim();
                cells.push(cellContent);
            }
            rows.push(cells);
        }
        if (rows.length === 0) return '';

        let md = '\n';
        md += '| ' + rows[0].join(' | ') + ' |\n';
        md += '| ' + rows[0].map(() => '---').join(' | ') + ' |\n';
        for (let i = 1; i < rows.length; i++) {
            md += '| ' + rows[i].join(' | ') + ' |\n';
        }
        return md;
    });

    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
    text = text.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n');

    text = text.replace(/<hr[^>]*\/?>/gi, '\n---\n');

    text = text.replace(/<[^>]*>/g, '');

    text = decodeEntities(text);

    text = text
        .replace(/\n{4,}/g, '\n\n\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n /g, '\n')
        .trim();

    let output = '';
    if (title) output += `# ${title}\n\n`;
    if (sourceUrl) output += `> Source: ${sourceUrl}\n\n`;
    if (description) output += `*${description}*\n\n---\n\n`;
    output += text;

    return output;
}

function decodeEntities(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n)))
        .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)));
}

async function fetchUrl(url, options = {}) {

    const { parsed: parsedUrl, address, family } = await _resolveSafe(url);

    return new Promise((resolve, reject) => {
        const timeout = options.timeout || 15000;
        const maxSize = options.maxSize || 5 * 1024 * 1024;

        const client = parsedUrl.protocol === 'https:' ? https : http;
        const reqOptions = {
            host: address,
            family,
            servername: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {

                'Host': parsedUrl.host,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
            },
            timeout,

            rejectUnauthorized: options.allowInsecureTLS !== true,
        };

        const req = client.request(reqOptions, (res) => {

            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                const redirects = (options._redirects || 0) + 1;
                if (redirects > 5) { res.resume(); return reject(new Error('Too many redirects')); }
                res.resume();
                const newUrl = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : new URL(res.headers.location, url).href;
                return fetchUrl(newUrl, { ...options, _redirects: redirects }).then(resolve, reject);
            }

            if (res.statusCode >= 400) {
                return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
            }

            const chunks = [];
            let totalSize = 0;

            res.on('data', (chunk) => {
                totalSize += chunk.length;
                if (totalSize > maxSize) {
                    req.destroy();
                    reject(new Error(`Response too large (>${Math.round(maxSize / 1024 / 1024)}MB)`));
                }
                chunks.push(chunk);
            });

            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8');
                resolve({
                    url: url,
                    statusCode: res.statusCode,
                    contentType: res.headers['content-type'] || '',
                    html: body,
                    size: totalSize,
                });
            });
        });

        req.on('error', (e) => reject(new Error(`Fetch failed: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.end();
    });
}

async function scrapeUrl(url, options = {}) {
    const startTime = Date.now();
    const result = await fetchUrl(url, options);
    const markdown = htmlToMarkdown(result.html, url);

    return {
        success: true,
        url: result.url,
        statusCode: result.statusCode,
        markdown: markdown,
        metadata: {
            contentType: result.contentType,
            htmlSize: result.size,
            markdownSize: markdown.length,
            fetchTimeMs: Date.now() - startTime,
        }
    };
}

module.exports = { scrapeUrl, fetchUrl, htmlToMarkdown, isBlockedHost, isPrivateIp, assertSafeUrl, _resolveSafe };
