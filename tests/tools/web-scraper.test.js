// Proxima — Web Scraper Tests.
// Verifies HTML to Markdown conversion, loopback/private IP detection, and URL/SSRF resolution checks.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scraper = require('../../src/tools/web-scraper.cjs');



test('htmlToMarkdown converts headers and emphasis', () => {
    const md = scraper.htmlToMarkdown('<h1>Title</h1><p>This is <strong>bold</strong> and <em>italic</em>.</p>');
    assert.match(md, /# Title/);
    assert.match(md, /\*\*bold\*\*/);
    assert.match(md, /\*italic\*/);
});

test('htmlToMarkdown strips script and style content', () => {
    const md = scraper.htmlToMarkdown('<p>keep</p><script>evil()</script><style>.x{}</style>');
    assert.match(md, /keep/);
    assert.ok(!md.includes('evil()'), 'script body removed');
    assert.ok(!md.includes('.x{}'), 'style body removed');
});

test('htmlToMarkdown resolves relative links against the source URL', () => {
    const md = scraper.htmlToMarkdown('<a href="/docs/page">Docs</a>', 'https://example.com/base');
    assert.match(md, /\[Docs\]\(https:\/\/example\.com\/docs\/page\)/);
});

test('htmlToMarkdown converts a table to pipe markdown', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const md = scraper.htmlToMarkdown(html);
    assert.match(md, /\| A \| B \|/);
    assert.match(md, /\| --- \| --- \|/);
    assert.match(md, /\| 1 \| 2 \|/);
});

test('htmlToMarkdown decodes HTML entities including numeric ones', () => {
    const md = scraper.htmlToMarkdown('<p>a &amp; b &lt;c&gt; &#65;</p>');
    assert.match(md, /a & b <c> A/);
});

test('htmlToMarkdown returns empty string for empty input', () => {
    assert.equal(scraper.htmlToMarkdown(''), '');
});



const privateCases = ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', 'not-an-ip'];
for (const ip of privateCases) {
    test(`isPrivateIp flags ${ip} as private/unsafe`, () => {
        assert.equal(scraper.isPrivateIp(ip), true);
    });
}

const publicCases = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'];
for (const ip of publicCases) {
    test(`isPrivateIp allows public address ${ip}`, () => {
        assert.equal(scraper.isPrivateIp(ip), false);
    });
}

test('isBlockedHost mirrors isPrivateIp for IP literals', () => {
    assert.equal(scraper.isBlockedHost('127.0.0.1'), true);
    assert.equal(scraper.isBlockedHost('8.8.8.8'), false);
});



test('assertSafeUrl rejects non-http(s) schemes', async () => {
    await assert.rejects(scraper.assertSafeUrl('file:///etc/passwd'), /scheme not allowed/);
    await assert.rejects(scraper.assertSafeUrl('ftp://example.com/x'), /scheme not allowed/);
});

test('assertSafeUrl rejects an invalid URL', async () => {
    await assert.rejects(scraper.assertSafeUrl('not a url at all'), /Invalid URL/);
});

test('_resolveSafe blocks URLs whose host resolves to a private address', async () => {

    await assert.rejects(scraper._resolveSafe('http://127.0.0.1/admin'), /private\/internal/);
    await assert.rejects(scraper._resolveSafe('http://10.0.0.1/'), /private\/internal/);
    await assert.rejects(scraper._resolveSafe('http://[::1]/'), /private\/internal/);
});

test('_resolveSafe blocks localhost (resolves to loopback)', async () => {
    await assert.rejects(scraper._resolveSafe('http://localhost:8080/'), /private\/internal|cannot resolve/);
});
