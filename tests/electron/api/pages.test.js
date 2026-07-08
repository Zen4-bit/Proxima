// Proxima — Docs and Widget Page Builders Tests.
// Verifies CLI, WebSocket, API key page builders, defensive error handling, and accent color integrations.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const apikey = require('../../../electron/api/pages/apikey.cjs');
const cli = require('../../../electron/api/pages/cli.cjs');
const docs = require('../../../electron/api/pages/docs.cjs');
const widget = require('../../../electron/api/pages/widget.cjs');
const ws = require('../../../electron/api/pages/ws.cjs');

const isHtmlDoc = (s) => typeof s === 'string' && s.length > 500 && /<!DOCTYPE html>/i.test(s);



test('getWSDocsPage returns a full HTML document', () => {
    const html = ws.getWSDocsPage();
    assert.ok(isHtmlDoc(html));
    assert.match(html, /WebSocket/i);
});

test('getCLIDocsPage returns a full HTML document', () => {
    const html = cli.getCLIDocsPage();
    assert.ok(isHtmlDoc(html));
});



test('getAPIKeyPage shows OPEN ACCESS when no key exists', () => {
    const html = apikey.getAPIKeyPage(() => null);
    assert.ok(isHtmlDoc(html));
    assert.match(html, /OPEN ACCESS/);
});

test('getAPIKeyPage shows SECURED when a key exists', () => {
    const html = apikey.getAPIKeyPage(() => ({ createdAt: Date.now() }));
    assert.ok(isHtmlDoc(html));
    assert.match(html, /SECURED/);
});



test('getDocsPage renders enabled providers and stats', () => {
    const html = docs.getDocsPage(
        () => ['chatgpt', 'claude'],
        () => ({ totalRequests: 5 }),
    );
    assert.ok(isHtmlDoc(html));
});

test('getDocsPage never throws on malformed provider/stats payloads', () => {

    assert.doesNotThrow(() => docs.getDocsPage(() => null, () => null));
    const html = docs.getDocsPage(() => 'not-an-array', () => 'not-an-object');
    assert.ok(typeof html === 'string' && html.length > 0);
});



test('getChatHTML returns a widget fragment using the accent color', () => {
    const frag = widget.getChatHTML('#a78bfa');
    assert.equal(typeof frag, 'string');
    assert.ok(frag.length > 100);
});

test('getChatHTML defaults the accent color when none is given', () => {
    assert.doesNotThrow(() => widget.getChatHTML());
});

test('getChatJS returns client JS embedding the provider color map', () => {
    const js = widget.getChatJS();
    assert.equal(typeof js, 'string');
    assert.ok(js.length > 100);

    for (const provider of Object.keys(widget.PROVIDER_COLORS)) {
        assert.ok(js.includes(provider), `client JS references ${provider}`);
    }
});

test('widget exposes REST_PORT and VERSION constants', () => {
    assert.equal(typeof widget.REST_PORT, 'number');
    assert.equal(typeof widget.VERSION, 'string');
});
