// Proxima — Tool Calling Bridge Tests.
// Verifies prompt rendering, system instructions, browser tool-call parsing (JSON/fenced/surrounding prose), backslash repairs, and response formatting.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tc = require('../../../electron/api/tool-calling.cjs');
const { buildToolCallingPrompt, parseToolCallResponse, formatToolCallResponse } = tc;


test('buildToolCallingPrompt: includes tool rules and lists each tool with schema', () => {
    const prompt = buildToolCallingPrompt({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ function: { name: 'execute', description: 'run code', parameters: { type: 'object' } } }],
    });
    assert.match(prompt, /HOW TO USE TOOLS/);
    assert.match(prompt, /=== AVAILABLE TOOLS ===/);
    assert.match(prompt, /Tool: execute/);
    assert.match(prompt, /Description: run code/);
    assert.match(prompt, /Parameters: \{"type":"object"\}/);
    assert.match(prompt, /=== CONVERSATION ===/);
    assert.match(prompt, /\[USER\]: hi/);
});

test('buildToolCallingPrompt: prepends system messages as runtime context', () => {
    const prompt = buildToolCallingPrompt({
        messages: [
            { role: 'system', content: 'You are Proxima.' },
            { role: 'user', content: 'do it' },
        ],
        tools: [],
    });
    assert.ok(prompt.indexOf('You are Proxima.') < prompt.indexOf('HOW TO USE TOOLS'));
});

test('buildToolCallingPrompt: only the LAST non-system message is included', () => {
    const prompt = buildToolCallingPrompt({
        messages: [
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'an answer' },
            { role: 'user', content: 'second question' },
        ],
        tools: [],
    });
    assert.match(prompt, /\[USER\]: second question/);
    assert.ok(!prompt.includes('first question'), 'history must not be resent');
});

test('buildToolCallingPrompt: tool_choice variants emit the correct directive', () => {
    const base = { messages: [{ role: 'user', content: 'x' }], tools: [] };
    assert.match(buildToolCallingPrompt({ ...base, tool_choice: 'none' }), /Do NOT use any tools/);
    assert.match(buildToolCallingPrompt({ ...base, tool_choice: 'required' }), /MUST use at least one tool/);
    assert.match(
        buildToolCallingPrompt({ ...base, tool_choice: { type: 'function', function: { name: 'execute' } } }),
        /MUST use the tool "execute"/,
    );
});

test('buildToolCallingPrompt: renders a tool-result message and array (multimodal) content', () => {
    const toolResult = buildToolCallingPrompt({
        messages: [{ role: 'tool', tool_call_id: 'call_9', content: 'exit=0' }],
        tools: [],
    });
    assert.match(toolResult, /\[TOOL RESULT call_9\]: exit=0/);

    const multimodal = buildToolCallingPrompt({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url' }] }],
        tools: [],
    });
    assert.match(multimodal, /\[USER\]: look\n\[image_url\]/);
});


test('parseToolCallResponse: plain prose is NOT treated as a tool call', () => {
    const r = parseToolCallResponse('Here is how you would sort an array in Python.');
    assert.equal(r.isToolCall, false);
    assert.equal(r.toolCalls, null);
    assert.equal(r.text, 'Here is how you would sort an array in Python.');
});

test('parseToolCallResponse: empty / non-string input returns a safe non-tool result', () => {
    for (const input of ['', null, undefined, 123]) {
        const r = parseToolCallResponse(input);
        assert.equal(r.isToolCall, false);
        assert.equal(r.toolCalls, null);
    }
});

test('parseToolCallResponse: direct JSON tool_calls is parsed (object arguments)', () => {
    const raw = JSON.stringify({
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'execute', arguments: { code: 'print(1)' } } }],
    });
    const r = parseToolCallResponse(raw);
    assert.equal(r.isToolCall, true);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].function.name, 'execute');
    assert.equal(r.toolCalls[0].function.arguments, JSON.stringify({ code: 'print(1)' }));
});

test('parseToolCallResponse: extracts a tool call from a ```json fenced block', () => {
    const raw = 'Sure:\n```json\n{"tool_calls":[{"function":{"name":"execute","arguments":{"a":1}}}]}\n```';
    const r = parseToolCallResponse(raw);
    assert.equal(r.isToolCall, true);
    assert.equal(r.toolCalls[0].function.name, 'execute');
});

test('parseToolCallResponse: extracts tool_calls embedded in surrounding explanation text', () => {
    const raw = 'I will run it now: {"tool_calls":[{"function":{"name":"execute","arguments":{"cmd":"ls"}}}]} done';
    const r = parseToolCallResponse(raw);
    assert.equal(r.isToolCall, true);
    assert.equal(r.toolCalls[0].function.name, 'execute');
});

test('parseToolCallResponse: reconstructs from bare name+arguments (no tool_calls wrapper)', () => {
    const raw = '{"name":"execute","arguments":{"path":"a.txt"}}';
    const r = parseToolCallResponse(raw);
    assert.equal(r.isToolCall, true);
    assert.equal(r.toolCalls[0].function.name, 'execute');
    assert.equal(r.toolCalls[0].function.arguments, JSON.stringify({ path: 'a.txt' }));
});

test('parseToolCallResponse: tolerates unescaped Windows path backslashes', () => {

    const raw = '{"tool_calls":[{"function":{"name":"execute","arguments":{"path":"C:\\Users\\me\\a.txt"}}}]}';
    const r = parseToolCallResponse(raw);
    assert.equal(r.isToolCall, true);
    assert.equal(r.toolCalls[0].function.name, 'execute');
});

test('parseToolCallResponse: a JSON object WITHOUT tool_calls stays plain text', () => {
    const raw = '{"answer":"42"}';
    const r = parseToolCallResponse(raw);
    assert.equal(r.isToolCall, false);
    assert.equal(r.text, raw);
});

test('parseToolCallResponse: string-form arguments are preserved as a string', () => {
    const raw = '{"tool_calls":[{"function":{"name":"execute","arguments":"{\\"k\\":1}"}}]}';
    const r = parseToolCallResponse(raw);
    assert.equal(r.isToolCall, true);
    assert.equal(typeof r.toolCalls[0].function.arguments, 'string');
    assert.equal(r.toolCalls[0].function.arguments, '{"k":1}');
});


test('formatToolCallResponse: produces an OpenAI tool_calls completion shape', () => {
    const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'execute', arguments: '{}' } }];
    const out = formatToolCallResponse(toolCalls, 'claude', 1234);
    assert.equal(out.object, 'chat.completion');
    assert.equal(out.model, 'claude');
    assert.equal(out.choices[0].finish_reason, 'tool_calls');
    assert.equal(out.choices[0].message.content, null);
    assert.deepEqual(out.choices[0].message.tool_calls, toolCalls);
    assert.equal(out.proxima.responseTimeMs, 1234);
    assert.equal(out.proxima.toolCalling, true);
    assert.ok(typeof out.id === 'string' && out.id.startsWith('chatcmpl-'));
});
