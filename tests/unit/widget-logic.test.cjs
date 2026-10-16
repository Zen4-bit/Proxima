const assert = require('assert');
const { getChatHTML, getChatJS, REST_PORT, VERSION } = require('../../electron/api/pages/widget.cjs');

console.log('[TEST] Checking widget exports...');
assert.equal(typeof getChatHTML, 'function');
assert.equal(typeof getChatJS, 'function');
assert.equal(REST_PORT, 3210);

const html = getChatHTML();
assert.ok(html.includes('id="chat-input"'));
assert.ok(html.includes('id="ws-status"'));
assert.ok(html.includes('onclick="sendChat()"'));

const js = getChatJS();
assert.ok(js.includes('connectWS()'), 'Must call connectWS on init');
assert.ok(js.includes('sendSingleHttp'), 'Must include HTTP fallback');
assert.ok(js.includes('sendBattleHttp'), 'Must include Battle HTTP fallback');
assert.ok(js.includes('formatModelLabel'), 'Must include model label formatter');

// Simulate client-side isLegacyOrInvalid
const isLegacyOrInvalid = (id) => {
    if (!id) return true;
    const lower = id.toLowerCase().trim();
    if (/^\d/.test(lower)) return true;
    if (lower === 'auto' || lower === 'gemini:auto' || lower.includes('-flash')) return true;
    return false;
};

const sampleModels = [
    { id: 'perplexity', status: 'enabled' },
    { id: 'chatgpt', status: 'enabled' },
    { id: 'claude', status: 'enabled' },
    { id: 'gemini', status: 'enabled' },
    { id: 'gemini:auto', status: 'enabled' },
    { id: 'gemini:pro', status: 'enabled' },
    { id: 'gemini:latest', status: 'enabled' },
    { id: 'gemini:flash', status: 'enabled' },
    { id: 'gemini:argon', status: 'enabled' },
    { id: '4-argon', status: 'enabled' },
    { id: '3.1-pro', status: 'enabled' },
    { id: '3.8-flash', status: 'enabled' },
    { id: '3.5-flash', status: 'enabled' },
    { id: 'auto', status: 'enabled' },
];

const filtered = sampleModels
    .filter(m => m.status === 'enabled' && !isLegacyOrInvalid(m.id))
    .map(m => m.id);

console.log('[TEST] Filtered models:', filtered);
assert.deepEqual(filtered, [
    'perplexity',
    'chatgpt',
    'claude',
    'gemini',
    'gemini:pro',
    'gemini:latest',
    'gemini:flash',
    'gemini:argon'
]);

assert.ok(!filtered.includes('4-argon'), '4-argon must be excluded');
assert.ok(!filtered.includes('3.1-pro'), '3.1-pro must be excluded');
assert.ok(!filtered.includes('3.8-flash'), '3.8-flash must be excluded');
assert.ok(!filtered.includes('3.5-flash'), '3.5-flash must be excluded');

// Base providers for chips
const baseProviders = Array.from(new Set(filtered.map(p => p.split(':')[0])));
console.log('[TEST] Base providers for chips:', baseProviders);
assert.deepEqual(baseProviders, ['perplexity', 'chatgpt', 'claude', 'gemini']);

console.log('[TEST] All widget verification checks passed successfully!');
