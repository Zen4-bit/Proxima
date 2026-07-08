// Proxima — MCP Code Tools Tests.
// Verifies registration of 12 code tools, direct/early-exits, and prompt structure generation.

import test from 'node:test';
import assert from 'node:assert';
import { register } from '../../src/mcp/tools-code.js';
import { registerModule, textOf } from '../fixtures/mcp-harness.js';

test('tools-code: registers all 12 documented code tools', () => {
    const { tools } = registerModule(register);
    assert.deepEqual([...tools.keys()].sort(), [
        'build_architecture', 'convert_code', 'explain_code', 'explain_error', 'fix_error',
        'generate_code', 'optimize_code', 'review_code', 'security_audit', 'solve',
        'verify_code', 'write_tests',
    ]);
});

test('generate_code: builds a production-ready prompt in the requested language', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('generate_code').handler({ description: 'a REST client', language: 'Python' });
    assert.equal(textOf(res), 'reply:chatgpt');
    assert.match(h.smartChatCalls[0].msg, /production-ready Python code/);
    assert.match(h.smartChatCalls[0].msg, /a REST client/);
});

test('verify_code: prompts differently with vs without a code snippet', async () => {
    const h = registerModule(register);
    await h.tools.get('verify_code').handler({ purpose: 'sort a list', code: 'def s(x): return x' });
    assert.match(h.smartChatCalls[0].msg, /Verify this code follows best practices/);
    await h.tools.get('verify_code').handler({ purpose: 'sort a list' });
    assert.match(h.smartChatCalls[1].msg, /best practices and common patterns/);
});

test('fix_error: builds a root-cause / fix / prevention prompt', async () => {
    const h = registerModule(register);
    await h.tools.get('fix_error').handler({ error: 'TypeError: x is not a function', context: 'calling x()' });
    assert.match(h.smartChatCalls[0].msg, /ROOT CAUSE/);
    assert.match(h.smartChatCalls[0].msg, /TypeError: x is not a function/);
    assert.match(h.smartChatCalls[0].msg, /calling x\(\)/);
});

test('write_tests: returns a direct message when the target file cannot be read', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('write_tests').handler({ file: '/missing.js' });
    assert.match(textOf(res), /Could not read file: \/missing\.js/);
    assert.equal(h.smartChatCalls.length, 0, 'no model call when the file is unreadable');
});

test('write_tests: builds a test-generation prompt from readable file content', async () => {
    const h = registerModule(register, { deps: { readFileContents: () => 'export function add(a,b){return a+b;}' } });
    await h.tools.get('write_tests').handler({ file: '/add.js', framework: 'vitest' });
    assert.match(h.smartChatCalls[0].msg, /TEST FRAMEWORK: vitest/);
    assert.match(h.smartChatCalls[0].msg, /export function add/);
});

test('convert_code: with no code/file returns a direct usage message', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('convert_code').handler({ to: 'TypeScript' });
    assert.match(textOf(res), /No code provided/);
    assert.equal(h.smartChatCalls.length, 0);
});

test('security_audit: with no code returns a direct usage message', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('security_audit').handler({});
    assert.match(textOf(res), /No code provided/);
});

test('security_audit: audits provided code with a severity-structured prompt', async () => {
    const h = registerModule(register);
    await h.tools.get('security_audit').handler({ code: "eval(userInput)", language: 'JavaScript' });
    assert.match(h.smartChatCalls[0].msg, /security audit/i);
    assert.match(h.smartChatCalls[0].msg, /CRITICAL \/ HIGH \/ MEDIUM \/ LOW/);
});

test('code tools: no enabled providers returns a helpful message', async () => {
    const h = registerModule(register, { enabled: [] });
    const res = await h.tools.get('generate_code').handler({ description: 'x' });
    assert.match(textOf(res), /No providers enabled/);
});
