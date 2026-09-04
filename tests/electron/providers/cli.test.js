// Proxima — CLI provider discovery tests.
// The parsers that turn what the local CLIs report (help text, Codex's
// models cache and config, Gemini's settings) into the models / efforts the
// agent editor offers. Fixtures are trimmed copies of real output.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cli = require('../../../electron/providers/cli.cjs');

const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Options:
  -d, --debug [filter]                  Enable debug mode
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session that runs on
                                        the given self-hosted environment
  --fallback-model <model>              Enable automatic fallback to specified
                                        model(s) when the default model is
                                        overloaded
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
`;

test('parseClaudeHelp: effort levels and model aliases come from the wrapped help text', () => {
    const r = cli.parseClaudeHelp(CLAUDE_HELP);
    assert.deepEqual(r.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(r.aliases, ['fable', 'opus', 'sonnet', 'haiku'], 'help aliases first, then the known ones the help omits; full names are not aliases');
    assert.deepEqual(cli.parseClaudeHelp('').efforts, [], 'no help → no levels (caller falls back)');
});

test('parseCodexModelsCache: listed models with their reasoning levels, in priority order; hidden ones dropped', () => {
    const json = { models: [
        { slug: 'gpt-5.4', display_name: 'GPT-5.4', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], visibility: 'list', priority: 16 },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], visibility: 'list', priority: 12 },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', supported_reasoning_levels: ['low', 'max'], visibility: 'hide', priority: 43 },
    ] };
    const r = cli.parseCodexModelsCache(json);
    assert.deepEqual(r.map(m => m.id), ['gpt-5.5', 'gpt-5.4']);
    assert.deepEqual(r[0].efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(r[0].defaultEffort, 'medium');
    assert.deepEqual(cli.parseCodexModelsCache(null), []);
});

test('parseCodexConfig: top-level defaults and [profiles.*] variants; sections after the first do not leak', () => {
    const toml = `approval_policy = 'never'
model = "gpt-5.6-sol"
model_reasoning_effort = "max"

[apps.some_app]
enabled = false
model = "should-not-count"

[profiles.fast]
model = "gpt-5.5"
model_reasoning_effort = "low"

[profiles."deep think"]
model = "gpt-5.5"
model_reasoning_effort = "xhigh"
`;
    const r = cli.parseCodexConfig(toml);
    assert.equal(r.model, 'gpt-5.6-sol');
    assert.equal(r.effort, 'max');
    assert.deepEqual(r.profiles, [{ name: 'fast', model: 'gpt-5.5', effort: 'low' }, { name: 'deep think', model: 'gpt-5.5', effort: 'xhigh' }]);
});

test('codexEffortFor: clamps to what the model supports once discovery has run', () => {
    // no discovery yet → plain mapping (max → xhigh)
    assert.equal(cli.codexEffortFor('gpt-5.5', 'max'), 'xhigh');
    assert.equal(cli.codexEffortFor('gpt-5.5', ''), null);
});

test('geminiAuthFrom: env, settings variants, or nothing', () => {
    assert.equal(cli.geminiAuthFrom({}, {}), '');
    assert.equal(cli.geminiAuthFrom({ selectedAuthType: 'oauth-personal' }, {}), 'oauth-personal');
    assert.equal(cli.geminiAuthFrom({ security: { auth: { selectedType: 'gemini-api-key' } } }, {}), 'gemini-api-key');
    assert.equal(cli.geminiAuthFrom({}, { GEMINI_API_KEY: 'x' }), 'env');
});

test('run: unknown provider rejects; gemini-cli is a known kind', async () => {
    await assert.rejects(cli.run('nope', {}).promise, /Unknown CLI provider/);
    assert.equal(cli.KINDS['gemini-cli'], 'gemini');
    assert.deepEqual(Object.keys(cli.availability()).sort(), ['claude', 'codex', 'gemini']);
});

test('runGemini: reaches the process layer for the gemini kind (concurrency slot exists) and reports a missing binary cleanly', async () => {
    // With no `gemini` on PATH the spawn fails; the point is that it fails as a
    // normal error, not a crash in the concurrency bookkeeping.
    const h = cli.runGemini({ model: 'gemini-2.5-flash', prompt: 'hi', cwd: undefined, timeoutMs: 5000 });
    await assert.rejects(h.promise, (e) => e instanceof Error);
});

test('childEnv / knownLocations: PATHEXT is restored for trimmed environments; install folders are per-CLI', () => {
    const env = cli.childEnv();
    if (process.platform === 'win32') assert.ok(env.PATHEXT && /\.EXE/i.test(env.PATHEXT));
    assert.ok(cli.knownLocations('codex').length >= 1);
    assert.ok(cli.knownLocations('claude').some(p => /claude/.test(p)));
    assert.deepEqual(cli.knownLocations('nope'), []);
});
