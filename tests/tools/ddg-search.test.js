// Proxima — DuckDuckGo Search Tests.
// Verifies results formatting to Markdown and public export exports.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ddg = require('../../src/tools/ddg-search.cjs');

test('module loads and exports its public surface without throwing', () => {

    assert.equal(typeof ddg.searchDDG, 'function');
    assert.equal(typeof ddg.formatResultsMarkdown, 'function');
});

test('formatResultsMarkdown renders a titled, numbered result list', () => {
    const md = ddg.formatResultsMarkdown({
        query: 'rust ownership',
        searchTimeMs: 123,
        results: [
            { position: 1, title: 'The Rust Book', url: 'https://doc.rust-lang.org/book/', snippet: 'Ownership rules' },
            { position: 2, title: 'Rustonomicon', url: 'https://doc.rust-lang.org/nomicon/', snippet: 'Unsafe Rust' },
        ],
    });
    assert.match(md, /Search Results: "rust ownership"/);
    assert.match(md, /2 results in 123ms via DuckDuckGo/);
    assert.match(md, /### 1\. The Rust Book/);
    assert.match(md, /https:\/\/doc\.rust-lang\.org\/book\//);
    assert.match(md, /Ownership rules/);
    assert.match(md, /### 2\. Rustonomicon/);
});

test('formatResultsMarkdown omits the snippet line when there is no snippet', () => {
    const md = ddg.formatResultsMarkdown({
        query: 'q',
        searchTimeMs: 5,
        results: [{ position: 1, title: 'No Snippet', url: 'https://example.com/', snippet: '' }],
    });
    assert.match(md, /### 1\. No Snippet/);
    assert.match(md, /https:\/\/example\.com\//);
    assert.ok(!/\n\n\n\n/.test(md));
});

test('formatResultsMarkdown handles an empty result set', () => {
    const md = ddg.formatResultsMarkdown({ query: 'nothing', searchTimeMs: 1, results: [] });
    assert.match(md, /0 results in 1ms/);
});
