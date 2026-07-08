// Proxima — Module Test Runner.
// Exercises standalone core modules (Memory Store, Smart Retry, Cost/Token Tracker, Quality Verifier) independently.

import { MemoryHistoryManager } from './memory/memory-store.js';
import { getRetryDelayMs, shouldRetry, withRetry, RPMController } from './retry/retry-engine.js';
import TokenTracker from './cost/token-tracker.js';
import { QualityVerifier } from './quality/verifier.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name} — ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}


(async () => {
console.log('\n🧠 MODULE 1: Memory Store');
console.log('─'.repeat(45));

const memory = new MemoryHistoryManager();

await test('addHistory works', async () => {
  await memory.addHistory('mem-1', null, 'User likes Python', 'ADD');
  const history = await memory.getHistory('mem-1');
  assert(history.length === 1, 'Should have 1 entry');
  assert(history[0].new_value === 'User likes Python', 'Content should match');
});

await test('multiple history entries', async () => {
  await memory.addHistory('mem-1', 'User likes Python', 'User loves Python', 'UPDATE');
  const history = await memory.getHistory('mem-1');
  assert(history.length === 2, 'Should have 2 entries');
});

await test('getHistory returns sorted (newest first)', async () => {
  const history = await memory.getHistory('mem-1');
  const d1 = new Date(history[0].created_at).getTime();
  const d2 = new Date(history[1].created_at).getTime();
  assert(d1 >= d2, 'Should be newest first');
});

await test('reset clears all', async () => {
  await memory.reset();
  const history = await memory.getHistory('mem-1');
  assert(history.length === 0, 'Should be empty after reset');
});


console.log('\n🔄 MODULE 2: Smart Retry Engine');
console.log('─'.repeat(45));

await test('getRetryDelayMs — exponential backoff', () => {
  const d1 = getRetryDelayMs(1, 1);
  const d2 = getRetryDelayMs(2, 1);
  const d3 = getRetryDelayMs(3, 1);
  assert(d2 > d1, `Attempt 2 (${Math.round(d2)}ms) should be > attempt 1 (${Math.round(d1)}ms)`);
  assert(d3 > d2, `Attempt 3 (${Math.round(d3)}ms) should be > attempt 2 (${Math.round(d2)}ms)`);
  console.log(`    Delays: ${Math.round(d1)}ms → ${Math.round(d2)}ms → ${Math.round(d3)}ms`);
});

await test('getRetryDelayMs — respects retryAfter header', () => {
  const delay = getRetryDelayMs(1, 1, 30);
  assert(delay === 30000, `Should be 30000ms, got ${delay}`);
});

await test('shouldRetry — timeout errors', () => {
  assert(shouldRetry(new Error('Request timed out'), 0, 3) === true);
  assert(shouldRetry(new Error('ETIMEDOUT'), 0, 3) === true);
});

await test('shouldRetry — network errors', () => {
  assert(shouldRetry(new Error('ECONNRESET'), 0, 3) === true);
  assert(shouldRetry(new Error('fetch failed'), 0, 3) === true);
});

await test('shouldRetry — rate limits', () => {
  assert(shouldRetry(new Error('429 Too Many Requests'), 0, 3) === true);
});

await test('shouldRetry — max retries reached', () => {
  assert(shouldRetry(new Error('timeout'), 3, 3) === false, 'Should stop after max retries');
});

await test('shouldRetry — non-retryable errors', () => {
  assert(shouldRetry(new Error('Invalid API key'), 0, 3) === false);
  assert(shouldRetry(new Error('Syntax error'), 0, 3) === false);
});

await test('withRetry — succeeds on first try', async () => {
  let calls = 0;
  const result = await withRetry(() => { calls++; return 'ok'; });
  assert(result === 'ok');
  assert(calls === 1);
});

await test('withRetry — retries on failure then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(() => {
    calls++;
    if (calls < 3) throw new Error('ECONNRESET');
    return 'recovered';
  }, { maxRetries: 3, baseDelay: 0.01, label: 'test' });
  assert(result === 'recovered');
  assert(calls === 3);
});

await test('RPMController — unlimited mode', async () => {
  const rpm = new RPMController(null);
  const ok = await rpm.checkOrWait();
  assert(ok === true);
  rpm.stop();
});

await test('RPMController — tracks requests', async () => {
  const rpm = new RPMController(100);
  await rpm.checkOrWait();
  await rpm.checkOrWait();
  const status = rpm.getStatus();
  assert(status.current === 2, `Should be 2, got ${status.current}`);
  assert(status.available === 98, `Should be 98 available, got ${status.available}`);
  rpm.stop();
});


console.log('\n💰 MODULE 4: Cost & Token Tracker');
console.log('─'.repeat(45));

const tracker = new TokenTracker();

await test('estimateTokens works', () => {
  const tokens = TokenTracker.estimateTokens('Hello, how are you doing today?');
  assert(tokens > 0, 'Should estimate tokens');
  console.log(`    "Hello, how are you doing today?" ≈ ${tokens} tokens`);
});

await test('logUsage tracks costs', () => {
  const result = tracker.logUsage({
    model: 'gpt-5.4',
    provider: 'chatgpt',
    promptTokens: 500,
    completionTokens: 200,
  });
  assert(result.requestCost > 0, 'Should calculate cost');
  console.log(`    GPT-5.4 (500+200 tokens) = $${result.requestCost.toFixed(4)} saved`);
});

await test('logUsage — multiple providers', () => {
  tracker.logUsage({ model: 'claude-4.6-sonnet', provider: 'claude', promptTokens: 300, completionTokens: 150 });
  tracker.logUsage({ model: 'gemini-3.1-pro', provider: 'gemini', promptTokens: 400, completionTokens: 250 });
  const report = tracker.getReport();
  assert(report.totalRequests === 3);
  assert(Object.keys(report.providers).length === 3);
  console.log(`    ${report.message}`);
});

await test('calculateCost — static method', () => {
  const cost = TokenTracker.calculateCost('gpt-4', 1000, 500);
  assert(cost.cost > 0);
  assert(cost.costINR > 0);
  console.log(`    GPT-4 (1K+500 tokens) = $${cost.cost} / ₹${cost.costINR}`);
});

await test('getReport — full session report', () => {
  const report = tracker.getReport();
  assert(report.totalTokens > 0);
  assert(report.totalCostSaved.startsWith('$'));
  assert(report.totalCostSavedINR.startsWith('₹'));
  console.log(`    Total: ${report.totalTokens} tokens, ${report.totalCostSaved} saved`);
});


console.log('\n✅ MODULE 5: Quality Verifier (Proxima Exclusive)');
console.log('─'.repeat(45));

await test('QualityVerifier — instantiates', () => {
  const verifier = new QualityVerifier({
    sendToModel: async (model, query) => `Mock response from ${model}`,
    minScore: 6,
  });
  assert(verifier.minScore === 6);
  assert(verifier.evaluatorModel === 'gemini');
});

await test('QualityVerifier — _extractJSON from markdown', () => {
  const verifier = new QualityVerifier({});
  const json = verifier._extractJSON('Here is result:\n```json\n{"score": 8}\n```\nDone.');
  assert(json === '{"score": 8}');
});

await test('QualityVerifier — _extractJSON from raw text', () => {
  const verifier = new QualityVerifier({});
  const json = verifier._extractJSON('Some text {"accuracy": 9, "overall": 8} more text');
  assert(json.includes('"accuracy": 9'));
});

await test('QualityVerifier — _parseScores', () => {
  const verifier = new QualityVerifier({});
  const scores = verifier._parseScores('{"accuracy":8,"completeness":7,"relevance":9,"clarity":8,"overall":8,"issues":"none"}');
  assert(scores.overall === 8);
  assert(scores.accuracy === 8);
});

await test('QualityVerifier — verify with mock model', async () => {
  const verifier = new QualityVerifier({
    sendToModel: async () => '{"accuracy":8,"completeness":7,"relevance":9,"clarity":8,"overall":8,"issues":"none"}',
  });
  const result = await verifier.verify('What is 2+2?', 'The answer is 4.');
  assert(result.verified === true);
  assert(result.recommendation === 'EXCELLENT');
  console.log(`    Score: ${result.scores.overall}/10 — ${result.recommendation}`);
});

await test('QualityVerifier — low score detection', async () => {
  const verifier = new QualityVerifier({
    sendToModel: async () => '{"accuracy":3,"completeness":2,"relevance":4,"clarity":3,"overall":3,"issues":"Mostly incorrect"}',
    minScore: 6,
  });
  const result = await verifier.verify('Complex question', 'Wrong answer');
  assert(result.verified === false);
  assert(result.recommendation === 'REJECT');
  console.log(`    Score: ${result.scores.overall}/10 — ${result.recommendation}`);
});


console.log('\n' + '═'.repeat(45));
console.log(`\n📊 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed === 0) {
  console.log('🎉 ALL TESTS PASSED! Proxima v6.0 modules are ready!\n');
} else {
  console.log(`⚠️ ${failed} test(s) need attention.\n`);
}
})();
