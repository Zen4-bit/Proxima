// Proxima — Structured Logger Tests.
// Verifies format patterns, log level gating, data serialization, and invalid log level robustness.

import test from 'node:test';
import assert from 'node:assert';
import { createLogger, setLogLevel, LOG_LEVELS } from '../../src/utils/logger.js';

let captured;
let origError;

function stubConsole() {
    captured = [];
    origError = console.error;
    console.error = (line) => captured.push(line);
}

test.afterEach(() => {
    if (origError) console.error = origError;
    origError = null;
    setLogLevel('info');
});

test('log line format: timestamp, padded level tag, module, message', () => {
    stubConsole();
    setLogLevel('info');
    const log = createLogger('pipeline');
    log.info('Request processed');
    assert.equal(captured.length, 1);

    assert.match(
        captured[0],
        /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[INFO \] \[pipeline\] Request processed$/,
    );
});

test('data object is appended as JSON when supplied', () => {
    stubConsole();
    setLogLevel('info');
    const log = createLogger('pipeline');
    log.info('done', { provider: 'chatgpt', tokens: 150 });
    assert.ok(captured[0].endsWith('done {"provider":"chatgpt","tokens":150}'));
});

test('no trailing space or JSON when data is omitted', () => {
    stubConsole();
    setLogLevel('info');
    createLogger('m').info('hello');
    assert.ok(captured[0].endsWith('hello'), 'message ends the line cleanly');
});

test('level gating: at info level, debug is suppressed but info/warn/error emit', () => {
    stubConsole();
    setLogLevel('info');
    const log = createLogger('gate');
    log.debug('should be hidden');
    log.info('i');
    log.warn('w');
    log.error('e');
    assert.equal(captured.length, 3);
    assert.ok(captured[0].includes('[INFO ]'));
    assert.ok(captured[1].includes('[WARN ]'));
    assert.ok(captured[2].includes('[ERROR]'));
});

test('level gating: at error level, only error emits', () => {
    stubConsole();
    setLogLevel('error');
    const log = createLogger('quiet');
    log.debug('x');
    log.info('x');
    log.warn('x');
    log.error('boom');
    assert.equal(captured.length, 1);
    assert.ok(captured[0].includes('boom'));
});

test('level gating: at debug level, everything emits', () => {
    stubConsole();
    setLogLevel('debug');
    const log = createLogger('verbose');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    assert.equal(captured.length, 4);
});

test('setLogLevel ignores unknown levels (keeps previous level)', () => {
    stubConsole();
    setLogLevel('warn');
    setLogLevel('not-a-real-level');
    const log = createLogger('m');
    log.info('should stay hidden at warn');
    log.warn('should show');
    assert.equal(captured.length, 1);
    assert.ok(captured[0].includes('should show'));
});

test('LOG_LEVELS exposes the ordered severity map', () => {
    assert.deepEqual(LOG_LEVELS, { debug: 0, info: 1, warn: 2, error: 3 });
});
