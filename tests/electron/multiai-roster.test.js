// The agent roster is the one screen where a wrong answer costs money or
// silently changes which machine answers, and it had no tests at all — every
// route rule lived in one 200-character template literal. These cover the
// vendor/route split: what the menus offer, and what a change writes back.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'electron', 'multiai-renderer.js');

// The renderer is a plain browser script: no exports, one DOM side effect and
// that one is guarded by `typeof document !== 'undefined'`. Evaluate it with a
// stub DOM and hand the top-level bindings back out through globalThis.
function load() {
    const box = { innerHTML: '' };
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        agentHub: { multiaiSave() {}, multiaiRoutes: null },
        showToast() {},
        document: {
            getElementById: (id) => (id === 'multiai-participants' ? box : null),
            querySelectorAll: () => [],
            addEventListener() {},
            activeElement: null,
            // multiaiEscape() escapes by round-tripping through a detached
            // element; this is the same escape, done by hand.
            createElement: () => ({
                innerHTML: '',
                set textContent(v) {
                    this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                },
            }),
        },
        window: { addEventListener() {}, confirm: () => sandbox._confirm() },
        _confirm: () => true,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    const src = fs.readFileSync(SRC, 'utf8') + `
;globalThis.__t = {
    state: multiaiState,
    render: multiaiRenderParticipants,
    field: multiaiAgentField,
    vendorOf: multiaiVendorOf,
    routeOf: multiaiRouteOf,
    apiAvailable: multiaiApiAvailable,
    pickFromList: multiaiModelPickFromList,
    clearAll: multiaiAgentsClearAll,
    addFromMenu: multiaiAgentAddFromMenu,
    seedSample: multiaiSeedSampleChat,
    saveToLibrary: multiaiAgentSaveToLibrary,
    applyDefault: multiaiApplyDefaultSetup,
    pinDefault: multiaiPinDefaultSetup,
    setupInto: multiaiSetupInto,
    VENDORS: MULTIAI_VENDORS,
};`;
    vm.runInContext(src, sandbox, { filename: 'multiai-renderer.js' });
    const t = sandbox.__t;
    t.box = box;
    t.confirm = (fn) => { sandbox._confirm = fn; };
    t.state.data = { projects: [{ id: 'p1', name: 'p', chats: [] }], uiPrefs: {} };
    return t;
}

// A chat holding exactly the given agents, made current.
function chatWith(t, agents, routes) {
    t.state.routes = Object.assign({ apiMode: false, providers: {}, cli: {} }, routes || {});
    const chat = { id: 'c1', title: 'c', agents: agents.map(a => Object.assign({}, a)), workspace: null };
    t.state.data.projects[0].chats = [chat];
    t.state.currentChatId = 'c1';
    return chat;
}

// The <option>s of the nth <select> in the rendered roster.
function optionsOf(html, ariaLabelPrefix) {
    const sel = new RegExp(`<select[^>]*aria-label="${ariaLabelPrefix}[^"]*"[^>]*>([\\s\\S]*?)</select>`);
    const m = html.match(sel);
    assert.ok(m, `no select for ${ariaLabelPrefix}`);
    return [...m[1].matchAll(/<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g)]
        .map(o => ({ value: o[1], selected: /\sselected/.test(o[2]), disabled: /\sdisabled/.test(o[2]), label: o[3] }));
}

test('vendorOf maps both surfaces of a vendor to one vendor', () => {
    const t = load();
    assert.equal(t.vendorOf('claude'), 'claude');
    assert.equal(t.vendorOf('claude-cli'), 'claude');
    assert.equal(t.vendorOf('codex-cli'), 'chatgpt');
    assert.equal(t.vendorOf('gemini-cli'), 'gemini');
    assert.equal(t.vendorOf('ollama'), '');          // api-only: its own vendor
});

test('routeOf reads the surface from the provider, not the stored route', () => {
    const t = load();
    chatWith(t, []);
    assert.equal(t.routeOf({ provider: 'claude-cli', route: 'auto' }), 'cli');
    assert.equal(t.routeOf({ provider: 'claude', route: 'browser' }), 'browser');
    assert.equal(t.routeOf({ provider: 'claude', route: 'api' }), 'api');
    assert.equal(t.routeOf({ provider: 'claude', route: 'auto' }), 'auto');
    assert.equal(t.routeOf({ provider: 'claude' }), 'auto');
});

test('apiAvailable needs API mode AND a key, except for api-only providers', () => {
    const t = load();
    chatWith(t, [], { apiMode: false, providers: { claude: { hasKey: true } } });
    assert.equal(t.apiAvailable('claude'), false);
    chatWith(t, [], { apiMode: true, providers: { claude: { hasKey: false } } });
    assert.equal(t.apiAvailable('claude'), false);
    chatWith(t, [], { apiMode: true, providers: { claude: { hasKey: true } } });
    assert.equal(t.apiAvailable('claude'), true);
    // A custom endpoint has no browser tab to fall back to, so the global
    // API-mode switch does not gate it.
    chatWith(t, [], { apiMode: false, providers: { ollama: { hasKey: true, apiOnly: true } } });
    assert.equal(t.apiAvailable('ollama'), true);
});

test('the API route is not offered while API mode is off', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'browser' }],
        { apiMode: false, providers: { claude: { hasKey: true } } });
    t.render(chat);
    const routes = optionsOf(t.box.innerHTML, 'Route for');
    assert.deepEqual(routes.map(o => o.value), ['browser', 'cli']);
});

test('with API mode on, the API route appears — disabled without a key', () => {
    const t = load();
    let chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'browser' }],
        { apiMode: true, providers: { claude: { hasKey: false } } });
    t.render(chat);
    let api = optionsOf(t.box.innerHTML, 'Route for').find(o => o.value === 'api');
    assert.ok(api && api.disabled, 'no key: offered but not selectable');

    chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'browser' }],
        { apiMode: true, providers: { claude: { hasKey: true } } });
    t.render(chat);
    api = optionsOf(t.box.innerHTML, 'Route for').find(o => o.value === 'api');
    assert.ok(api && !api.disabled);
});

test('a CLI seat picks its route from the same menu as a browser seat', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude-cli', route: 'cli' }],
        { apiMode: false, providers: {}, cli: { claude: true } });
    t.render(chat);
    const routes = optionsOf(t.box.innerHTML, 'Route for');
    // The cell used to be disabled for CLI seats: the provider menu had already
    // decided, so the row stated the same fact twice.
    assert.ok(!/aria-label="Route for[^"]*"[^>]*disabled/.test(t.box.innerHTML));
    assert.deepEqual(routes.map(o => o.value), ['browser', 'cli']);
    assert.ok(routes.find(o => o.value === 'cli').selected);
});

test('a missing CLI is listed but not selectable', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'browser' }],
        { apiMode: false, providers: {}, cli: {} });
    t.render(chat);
    const cli = optionsOf(t.box.innerHTML, 'Route for').find(o => o.value === 'cli');
    assert.ok(cli.disabled);
    assert.match(cli.label, /not installed/);
});

test('the provider menu lists vendors once, not one entry per surface', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude-cli', route: 'cli' }],
        { apiMode: false, providers: {}, cli: { claude: true } });
    t.render(chat);
    const provs = optionsOf(t.box.innerHTML, 'Provider for');
    assert.deepEqual(provs.map(o => o.value), ['claude', 'chatgpt', 'gemini', 'perplexity', 'antigravity']);
    // A CLI seat is its vendor with the CLI route selected.
    assert.ok(provs.find(o => o.value === 'claude').selected);
});

test('a legacy auto seat keeps auto until its route is changed', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'auto' }],
        { apiMode: true, providers: { claude: { hasKey: true } } });
    t.render(chat);
    const routes = optionsOf(t.box.innerHTML, 'Route for');
    const auto = routes.find(o => o.value === 'auto');
    assert.ok(auto && auto.selected, 'auto is shown while it is what the seat holds');
    assert.match(auto.label, /follow Settings/);
    // ...and is gone once the seat says what it wants.
    t.field(0, 'route', 'browser');
    assert.equal(chat.agents[0].route, 'browser');
    t.render(chat);
    assert.ok(!optionsOf(t.box.innerHTML, 'Route for').some(o => o.value === 'auto'));
});

test('choosing the CLI route switches the provider id the run dispatches on', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'browser' }],
        { apiMode: false, providers: {}, cli: { claude: true } });
    t.field(0, 'route', 'cli');
    assert.equal(chat.agents[0].provider, 'claude-cli');
    assert.equal(chat.agents[0].route, 'cli');
    assert.equal(chat.agents[0].tools, 'none');      // a CLI seat starts unarmed
    t.field(0, 'route', 'browser');
    assert.equal(chat.agents[0].provider, 'claude');
    assert.equal(chat.agents[0].route, 'browser');
    assert.equal(chat.agents[0].tools, undefined);   // and a browser seat has none to arm
});

test('changing vendor keeps the route where the new vendor can take it', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude-cli', route: 'cli' }],
        { apiMode: false, providers: {}, cli: { claude: true, codex: true } });
    t.field(0, 'vendor', 'chatgpt');
    assert.equal(chat.agents[0].provider, 'codex-cli');
    // Perplexity has no CLI, so the seat lands on the tab rather than storing
    // 'cli' against a provider that has none.
    t.field(0, 'vendor', 'perplexity');
    assert.equal(chat.agents[0].provider, 'perplexity');
    assert.equal(chat.agents[0].route, 'browser');
});

test('an API route is not carried to a vendor that cannot serve it', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'api' }],
        { apiMode: true, providers: { claude: { hasKey: true }, gemini: { hasKey: false } } });
    t.field(0, 'vendor', 'gemini');
    assert.equal(chat.agents[0].provider, 'gemini');
    assert.equal(chat.agents[0].route, 'browser', 'no Gemini key: the API route would be a lie');
});

test('a browser-side Gemini engine is dropped when the seat moves to the API', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'gemini', route: 'browser', model: '3.1-pro' }],
        { apiMode: true, providers: { gemini: { hasKey: true, models: ['gemini-3.5-flash'] } } });
    t.field(0, 'route', 'api');
    assert.equal(chat.agents[0].route, 'api');
    // apiModelFor() trusts the box verbatim on an explicit api route, so a
    // browser engine string left in it would be sent to the API as typed.
    assert.equal(chat.agents[0].model, '');
});

// --- the model cell -------------------------------------------------------
// A CLI whose list has aliases, catalogue ids and dated pins, plus one model
// that has answered a real turn here.
function cliRoutes(verified) {
    const cat = ['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'];
    return {
        apiMode: false,
        providers: {},
        cli: { claude: true },
        cliInfo: {
            claude: {
                available: true, version: '2.1.259', defaultModel: 'sonnet', efforts: ['low', 'high', 'max'],
                models: [{ id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }]
                    .concat(cat.map(id => ({ id, label: id, source: 'catalog' }))),
            },
        },
        _verified: verified,
    };
}

function groupsOf(html, name) {
    const m = html.match(new RegExp(`<select[^>]*aria-label="Model for ${name}"[\\s\\S]*?</select>`));
    assert.ok(m, 'no model select for ' + name);
    return [...m[0].matchAll(/<optgroup label="([^"]*)">([\s\S]*?)<\/optgroup>/g)]
        .map(g => ({ label: g[1], items: [...g[2].matchAll(/<option value="([^"]*)"/g)].map(o => o[1]) }));
}

test('the model list is grouped by where each id came from', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude-cli', route: 'cli', model: 'sonnet' }], cliRoutes());
    t.render(chat);
    const g = groupsOf(t.box.innerHTML, 'A');
    assert.deepEqual(g.map(x => x.label), ['aliases the CLI lists', 'full ids · not tried here', 'dated pins · not tried here']);
    assert.deepEqual(g[0].items, ['opus', 'sonnet', 'haiku']);
    assert.deepEqual(g[2].items, ['claude-sonnet-4-5-20250929']);
    // The provenance is the group label now, said once, not a suffix repeated
    // on every one of fourteen rows.
    assert.ok(!/not seen on this machine yet/.test(t.box.innerHTML));
});

test('a model that has answered a real turn is offered first', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude-cli', route: 'cli', model: 'sonnet' }], cliRoutes());
    t.state.data.uiPrefs.knownModels = { 'claude-cli': [{ id: 'claude-opus-5', verifiedAt: '2026-01-01' }] };
    t.render(chat);
    const g = groupsOf(t.box.innerHTML, 'A');
    assert.equal(g[0].label, 'answered on this machine');
    assert.deepEqual(g[0].items, ['claude-opus-5']);
    // ...and is not offered a second time as a catalogue candidate.
    assert.equal(g.filter(x => x.items.includes('claude-opus-5')).length, 1);
});

test('every listed model is reachable whatever the box already holds', () => {
    const t = load();
    // The datalist this replaced filtered itself by the current value, so a
    // seat on "sonnet" could only ever see the sonnet ids.
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude-cli', route: 'cli', model: 'sonnet' }], cliRoutes());
    t.render(chat);
    const ids = groupsOf(t.box.innerHTML, 'A').flatMap(g => g.items);
    assert.ok(ids.includes('claude-opus-5') && ids.includes('haiku'), ids.join(','));
});

test('custom… gives back the free-text box, and ☰ gives back the list', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude-cli', route: 'cli', model: 'sonnet' }], cliRoutes());
    t.field(0, 'model:select', '__custom__');
    assert.equal(chat.agents[0].model, '');
    t.render(chat);
    assert.ok(!/aria-label="Model for A"/.test(t.box.innerHTML), 'the select is gone');
    assert.match(t.box.innerHTML, /aria-label="Back to the list"/);
    t.pickFromList(0);
    t.render(chat);
    assert.match(t.box.innerHTML, /aria-label="Model for A"/);
});

test('an id no list knows about keeps its free-text box', () => {
    const t = load();
    // Claude Code takes ids its --help never prints, [1m] variants among them.
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude-cli', route: 'cli', model: 'claude-opus-5[1m]' }], cliRoutes());
    t.render(chat);
    assert.ok(!/aria-label="Model for A"/.test(t.box.innerHTML));
    assert.match(t.box.innerHTML, /value="claude-opus-5\[1m\]"/);
    // Going back to the list means giving that id up — it cannot be selected.
    t.pickFromList(0);
    assert.equal(chat.agents[0].model, '');
});

test('an API seat is told whether its list came from Settings or from the key', () => {
    const t = load();
    let chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'api' }],
        { apiMode: true, providers: { claude: { hasKey: true, models: ['claude-opus-5'], modelsFrom: 'settings' } } });
    t.render(chat);
    assert.equal(groupsOf(t.box.innerHTML, 'A')[0].label, 'chosen in Settings');

    chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'api' }],
        { apiMode: true, providers: { claude: { hasKey: true, models: ['claude-opus-5'], modelsFrom: 'key' } } });
    t.render(chat);
    assert.match(groupsOf(t.box.innerHTML, 'A')[0].label, /v1\/models/);
});

test('clear all empties the roster and does not let it grow back', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'browser' }],
        { apiMode: false, providers: {}, cli: {} });
    // A chat migrated from the old participants list keeps that list; clearing
    // only `agents` would have multiaiEnsureAgents rebuild the roster from it.
    chat.participants = ['chatgpt', 'claude'];
    t.clearAll();
    assert.deepEqual(chat.agents, []);
    t.render(chat);
    assert.match(t.box.innerHTML, /No agents yet/);
    assert.deepEqual(t.state.data.projects[0].chats[0].agents, []);
});

test('clear all is refused without a confirmation, and disabled on an empty roster', () => {
    const t = load();
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude', route: 'browser' }], {});
    t.confirm(() => false);
    t.clearAll();
    assert.equal(chat.agents.length, 1, 'declining the prompt changes nothing');
    t.confirm(() => true);
    t.clearAll();
    t.render(chat);
    assert.match(t.box.innerHTML, /aria-label="Remove every agent from this chat"[^>]*disabled/);
});

// --- the add-agent menu -----------------------------------------------------
function menuGroups(html) {
    const m = html.match(/<select[^>]*title="Add an agent[\s\S]*?<\/select>/);
    assert.ok(m, 'no add-agent menu');
    return [...m[0].matchAll(/<optgroup label="([^"]*)">([\s\S]*?)<\/optgroup>/g)]
        .map(g => ({ label: g[1], items: [...g[2].matchAll(/<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)].map(o => [o[1], o[2]]) }));
}

test('the add menu picks who answers, never how it is reached', () => {
    const t = load();
    const chat = chatWith(t, [], { apiMode: false, providers: {}, cli: { claude: true, codex: true } });
    t.render(chat);
    const g = menuGroups(t.box.innerHTML);
    // Grouping the menu by surface asked the same question the Route cell owns:
    // "Browser tab · Claude" and then browser / Claude Code / API on the row.
    assert.deepEqual(g.map(x => x.label), ['New · pick its route on the row']);
    assert.deepEqual(g[0].items.map(i => i[0]), ['new:claude', 'new:chatgpt', 'new:gemini', 'new:perplexity', 'new:antigravity']);
    assert.deepEqual(g[0].items.map(i => i[1]), ['Claude', 'ChatGPT', 'Gemini', 'Perplexity', 'Antigravity']);
});

test('an endpoint you registered is its own group — it really has one route', () => {
    const t = load();
    const chat = chatWith(t, [], { apiMode: false, cli: {}, providers: { ollama: { hasKey: true, apiOnly: true, label: 'Ollama', models: ['qwen2.5-coder'] } } });
    t.render(chat);
    const g = menuGroups(t.box.innerHTML);
    const api = g.find(x => /API endpoint/.test(x.label));
    assert.ok(api, g.map(x => x.label).join(' | '));
    assert.deepEqual(api.items, [['new:ollama', 'Ollama']]);
});

test('a library seat is named once, not twice', () => {
    const t = load();
    const chat = chatWith(t, [], { apiMode: false, cli: { claude: true }, providers: {} });
    // Seats are auto-named from provider, model and effort, so "name — meta"
    // printed the same string twice for every CLI seat.
    t.state.data.uiPrefs.agentLibrary = [
        { uid: 'u1', name: 'Claude Code · haiku · max', provider: 'claude-cli', route: 'cli', model: 'haiku', effort: 'max' },
        { uid: 'u2', name: 'Sceptic', provider: 'claude-cli', route: 'cli', model: 'sonnet', effort: 'high' },
    ];
    t.render(chat);
    const lib = menuGroups(t.box.innerHTML).find(x => /Library/.test(x.label));
    assert.equal(lib.items[0][1], 'Claude Code · haiku · max');
    assert.match(lib.items[1][1], /^Sceptic — /);
});

test('a new browser seat is on the browser route, not the legacy auto', () => {
    const t = load();
    const chat = chatWith(t, [], { apiMode: false, cli: {}, providers: {} });
    t.addFromMenu('new:claude');
    assert.equal(chat.agents.length, 1);
    assert.equal(chat.agents[0].provider, 'claude');
    // 'auto' is a migration value; a row made just now should not open
    // labelled "follow Settings".
    assert.equal(chat.agents[0].route, 'browser');
});

test('first run seeds a sample chat that is set up but has not run', () => {
    const t = load();
    t.state.routes = { apiMode: false, providers: {}, cli: {} };
    t.state.currentChatId = null;
    t.seedSample();
    const chat = t.state.data.projects[0].chats[0];
    assert.ok(chat, 'a chat was created');
    assert.equal(t.state.currentChatId, chat.id);
    assert.deepEqual(chat.agents.map(a => a.provider), ['claude', 'chatgpt']);
    assert.deepEqual(chat.agents.map(a => a.route), ['browser', 'browser']);
    // One system note, and nothing that looks like an AI having answered.
    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0].role, 'system');
    assert.ok(!chat.messages.some(m => m.role === 'assistant'), 'no fabricated replies');
    // Seeded once: emptying the chat list must not conjure it back every launch.
    t.state.data.projects[0].chats = [];
    t.seedSample();
    assert.deepEqual(t.state.data.projects[0].chats, []);
});

test("Codex's catalogue models are offered, fenced off from the account list", () => {
    const t = load();
    const account = ['gpt-5.6-sol', 'gpt-5.5'];
    const cat = ['gpt-6-astra', 'gpt-5.6', 'gpt-4o', 'o1'];
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'codex-cli', route: 'cli', model: 'gpt-5.6-sol' }], {
        apiMode: false, providers: {}, cli: { codex: true },
        cliInfo: { codex: { available: true, version: '0.152.1', models: account.map(id => ({ id })).concat(cat.map(id => ({ id, source: 'catalog' }))) } },
    });
    t.render(chat);
    const g = groupsOf(t.box.innerHTML, 'A');
    // The account list is entitlement-aware and comes first. The catalogue used
    // to be dropped outright for Codex, which made a model the account had
    // gained but the cache had not — gpt-6-astra — unreachable except by typing
    // it. It is offered now, under a label that says what it is.
    assert.deepEqual(g[0].label, 'your account');
    assert.deepEqual(g[0].items, account);
    assert.match(g[1].label, /not on your account list/);
    assert.ok(g[1].items.includes('gpt-6-astra'));
    // Newest family first, and the o-series after the gpt- ones rather than
    // sorted to the top by the letter it starts with.
    assert.deepEqual(g[1].items, ['gpt-6-astra', 'gpt-5.6', 'gpt-4o', 'o1']);
});

test('a catalogue group says which CLI it is padding', () => {
    const t = load();
    const mk = (provider, kind) => chatWith(t, [{ id: 'a', name: 'A', provider, route: 'cli', model: '' }], {
        apiMode: false, providers: {}, cli: { [kind]: true },
        cliInfo: { [kind]: { available: true, models: [{ id: 'x-1', source: 'catalog' }] } },
    });
    t.render(mk('claude-cli', 'claude'));
    assert.match(groupsOf(t.box.innerHTML, 'A')[0].label, /full ids/);
    t.render(mk('gemini-cli', 'gemini'));
    assert.match(groupsOf(t.box.innerHTML, 'A')[0].label, /from the catalogue/);
});

// --- the library is somewhere you put things --------------------------------
test('adding a seat does not publish it to the library', () => {
    const t = load();
    const chat = chatWith(t, [], { apiMode: false, cli: {}, providers: {} });
    t.addFromMenu('new:claude');
    assert.equal(chat.agents.length, 1);
    // A library entry is offered in every chat and served under its own id on
    // the REST port and to MCP clients; a one-off should not become one.
    assert.equal(chat.agents[0].uid, undefined);
    assert.deepEqual(t.state.data.uiPrefs.agentLibrary || [], []);
    t.saveToLibrary(0);
    assert.ok(chat.agents[0].uid, 'saving gives it an identity');
    assert.equal((t.state.data.uiPrefs.agentLibrary || []).length, 1);
    t.saveToLibrary(0);
    assert.equal(t.state.data.uiPrefs.agentLibrary.length, 1, 'saving twice is not two entries');
});

test('a new chat starts empty unless a setup is pinned', () => {
    const t = load();
    chatWith(t, [], { apiMode: false, cli: { claude: true, codex: true }, providers: {} });
    t.state.data.uiPrefs.agentLibrary = [
        { uid: 'u1', name: 'A', provider: 'claude', route: 'browser' },
        { uid: 'u2', name: 'B', provider: 'chatgpt', route: 'browser' },
    ];
    // Cloning the library is what turned every new chat into nine seats.
    const fresh = { id: 'n1', agents: [] };
    t.applyDefault(fresh);
    assert.deepEqual(fresh.agents, []);

    t.pinDefault('builtin:second-opinion');
    const fresh2 = { id: 'n2', agents: [] };
    t.applyDefault(fresh2);
    assert.deepEqual(fresh2.agents.map(a => a.provider), ['chatgpt', 'claude']);
    assert.equal(fresh2.rounds, 1);
    assert.equal(fresh2.independentRounds, 'all');
    // ...and the seats it built are the chat's, not new library entries.
    assert.deepEqual(fresh2.agents.map(a => a.uid), [undefined, undefined]);
});

test('the setups menu offers applying and pinning, and shows which is pinned', () => {
    const t = load();
    const chat = chatWith(t, [], { apiMode: false, cli: {}, providers: {} });
    t.render(chat);
    let m = t.box.innerHTML.match(/<select[^>]*aria-label="Apply a saved setup"[\s\S]*?<\/select>/);
    assert.ok(/Start new chats from/.test(m[0]), 'the pin group is there');
    assert.ok(/value="pin:">nothing — open empty ✓/.test(m[0]), 'nothing pinned is ticked');

    t.pinDefault('builtin:second-opinion');
    t.render(chat);
    m = t.box.innerHTML.match(/<select[^>]*aria-label="Apply a saved setup"[\s\S]*?<\/select>/);
    assert.match(m[0], /value="pin:builtin:second-opinion">Second opinion ✓/);
    assert.match(m[0], /📌 Second opinion/, 'the closed menu says what new chats start from');
});

test('Antigravity is a vendor with one route and no tab', () => {
    const t = load();
    const chat = chatWith(t, [], {
        apiMode: false, providers: {}, cli: { antigravity: true },
        cliInfo: { antigravity: { available: true, version: '1.1.27', loggedIn: true, models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] }] } },
    });
    t.addFromMenu('new:antigravity');
    const a = chat.agents[0];
    // The add menu hands over a vendor key; a vendor with no tab starts on its CLI.
    assert.equal(a.provider, 'antigravity-cli');
    assert.equal(a.route, 'cli');
    assert.equal(a.tools, 'none');
    t.render(chat);
    const routes = optionsOf(t.box.innerHTML, 'Route for');
    assert.deepEqual(routes.map(o => o.value), ['cli'], 'no browser tab to offer');
    assert.match(routes[0].label, /Antigravity 1\.1\.27/);
    const provs = optionsOf(t.box.innerHTML, 'Provider for');
    assert.ok(provs.some(o => o.value === 'antigravity' && o.selected));
});

test('a CLI seat can reach its vendor’s API key', () => {
    const t = load();
    // routes.providers is keyed by vendor, so asking under 'claude-cli' found
    // nothing and the API option was offered disabled, saying there was no key,
    // while the Claude key was right there.
    const chat = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude-cli', route: 'cli', model: 'sonnet' }],
        { apiMode: true, providers: { claude: { hasKey: true } }, cli: { claude: true } });
    t.render(chat);
    const api = optionsOf(t.box.innerHTML, 'Route for').find(o => o.value === 'api');
    assert.ok(api && !api.disabled, 'the vendor has a key, so the route is selectable');
    assert.equal(api.label, 'API key');
    // ...and it is still refused when the vendor genuinely has none.
    const chat2 = chatWith(t, [{ id: 'a', name: 'A', provider: 'claude-cli', route: 'cli', model: 'sonnet' }],
        { apiMode: true, providers: { claude: { hasKey: false } }, cli: { claude: true } });
    t.render(chat2);
    assert.ok(optionsOf(t.box.innerHTML, 'Route for').find(o => o.value === 'api').disabled);
});

test('custom… survives the rename it triggers', () => {
    const t = load();
    // The regression the fixed name "A" stepped over: an auto-named seat is
    // renamed from its model, renaming re-slugs the id, and the free-text mode
    // used to be filed under the id it had a moment ago.
    const chat = chatWith(t, [], { apiMode: false, providers: {}, cli: { claude: true },
        cliInfo: { claude: { available: true, models: [{ id: 'sonnet' }, { id: 'opus' }] } } });
    t.addFromMenu('new:claude');
    t.field(0, 'route', 'cli');
    const before = chat.agents[0].id;
    t.field(0, 'model:select', '__custom__');
    assert.equal(chat.agents[0].model, '');
    assert.notEqual(chat.agents[0].id, before, 'the seat really was renamed and re-slugged');
    t.render(chat);
    assert.ok(!/aria-label="Model for/.test(t.box.innerHTML), 'still in free text');
    assert.match(t.box.innerHTML, /aria-label="Back to the list"/);
});

test('the old independentFirstRound boolean reads the same everywhere', () => {
    const t = load();
    const chat = chatWith(t, [], { apiMode: false, providers: {}, cli: {} });
    t.state.data.uiPrefs.setups = [
        { id: 's1', name: 'legacy off', agents: [{ provider: 'claude' }], independentFirstRound: false },
        { id: 's2', name: 'legacy on', agents: [{ provider: 'claude' }], independentFirstRound: true },
    ];
    // false was the old default, not a choice — mapping it to 'off' here and to
    // 'all' on a chat made the same stored boolean mean two opposite things.
    const [off, on] = t.state.data.uiPrefs.setups;
    t.setupInto(chat, off);
    assert.equal(chat.independentRounds, 'all');
    t.setupInto(chat, on);
    assert.equal(chat.independentRounds, 'first');
});
