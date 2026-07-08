// Proxima — BYOK HTTP Client.
// Handles shared HTTPS transport requests with consistent timeouts, error categorization, and response limits.

'use strict';

const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

function postJson(endpoint, headers, body, label, opts = {}) {
    return _send('POST', endpoint, headers, body, label, opts);
}

function getJson(endpoint, headers, label, opts = {}) {
    return _send('GET', endpoint, headers, null, label, opts);
}

function _send(method, endpoint, headers, body, label, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes || MAX_RESPONSE_BYTES;

    return new Promise((resolve, reject) => {
        let url;
        try {
            url = new URL(endpoint);
        } catch {
            reject(new Error(`${label}: invalid endpoint URL "${endpoint}"`));
            return;
        }

        const reqHeaders = { ...headers };
        if (body != null) {
            reqHeaders['Content-Length'] = Buffer.byteLength(body);
        }

        const req = https.request({
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method,
            headers: reqHeaders,
        }, (res) => {
            const chunks = [];
            let total = 0;
            let aborted = false;

            res.on('data', (chunk) => {
                if (aborted) return;
                total += chunk.length;
                if (total > maxBytes) {
                    aborted = true;
                    req.destroy();
                    const err = new Error(
                        `${label}: response exceeded ${Math.floor(maxBytes / 1048576)}MB limit`
                    );
                    err.statusCode = res.statusCode;
                    reject(err);
                    return;
                }
                chunks.push(chunk);
            });

            res.on('end', () => {
                if (aborted) return;
                const raw = Buffer.concat(chunks).toString();

                let parsed;
                try {
                    parsed = JSON.parse(raw);
                } catch {
                    const err = new Error(
                        `${label}: invalid JSON response (HTTP ${res.statusCode})`
                    );
                    err.statusCode = res.statusCode;
                    err.rawBodyPreview = raw.slice(0, 300);
                    reject(err);
                    return;
                }

                if (res.statusCode >= 400) {
                    const e = parsed && parsed.error;
                    const msg =
                        (e && typeof e === 'object' && e.message) ||
                        (typeof e === 'string' && e) ||
                        (parsed && parsed.message) ||
                        `HTTP ${res.statusCode}`;
                    const err = new Error(`${label} error: ${msg}`);
                    err.statusCode = res.statusCode;
                    reject(err);
                    return;
                }

                resolve(parsed);
            });

            res.on('error', (e) => {
                if (aborted) return;
                aborted = true;
                reject(new Error(`${label} network error: ${e.message}`));
            });
        });

        req.on('error', (e) => reject(new Error(`${label} network error: ${e.message}`)));

        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error(`${label}: request timed out (${Math.floor(timeoutMs / 1000)}s)`));
        });

        if (body != null) req.write(body);
        req.end();
    });
}

module.exports = { postJson, getJson, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES };
