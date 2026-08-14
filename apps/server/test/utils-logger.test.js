import test from 'node:test';
import assert from 'node:assert/strict';

import { logger, Logger } from '../src/utils/logger.js';

// --- Logger class: can create multiple isolated instances ---

test('Logger constructor sets isDebugEnabled to false by default', () => {
    const l = new Logger();
    assert.equal(l.isDebugEnabled, false);
});

test('setDebug enables debug mode', () => {
    const l = new Logger();
    l.setDebug(true);
    assert.equal(l.isDebugEnabled, true);
});

test('setDebug disables debug mode when called with falsy value', () => {
    const l = new Logger();
    l.setDebug(true);
    l.setDebug(false);
    assert.equal(l.isDebugEnabled, false);
});

test('setDebug coerces to boolean', () => {
    const l = new Logger();
    l.setDebug(1);
    assert.equal(l.isDebugEnabled, true);
    l.setDebug(0);
    assert.equal(l.isDebugEnabled, false);
});

test('getTimestamp returns an ISO string', () => {
    const l = new Logger();
    const ts = l.getTimestamp();
    assert.ok(typeof ts === 'string');
    assert.ok(!isNaN(Date.parse(ts)));
});

// --- Logging methods: verify they call console.log without throwing ---

function captureLog(fn) {
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
        fn();
    } finally {
        console.log = orig;
    }
    return lines;
}

test('info() writes to console.log with INFO tag', () => {
    const l = new Logger();
    const lines = captureLog(() => l.info('hello info'));
    assert.ok(lines.length > 0);
    assert.ok(lines[0].includes('INFO'));
    assert.ok(lines[0].includes('hello info'));
});

test('success() writes to console.log with SUCCESS tag', () => {
    const l = new Logger();
    const lines = captureLog(() => l.success('done!'));
    assert.ok(lines.length > 0);
    assert.ok(lines[0].includes('SUCCESS'));
});

test('warn() writes to console.log with WARN tag', () => {
    const l = new Logger();
    const lines = captureLog(() => l.warn('watch out'));
    assert.ok(lines.length > 0);
    assert.ok(lines[0].includes('WARN'));
});

test('error() writes to console.log with ERROR tag', () => {
    const l = new Logger();
    const lines = captureLog(() => l.error('boom'));
    assert.ok(lines.length > 0);
    assert.ok(lines[0].includes('ERROR'));
});

test('debug() does NOT write when debug mode is off', () => {
    const l = new Logger();
    const lines = captureLog(() => l.debug('secret debug'));
    assert.equal(lines.length, 0);
});

test('debug() writes when debug mode is enabled', () => {
    const l = new Logger();
    l.setDebug(true);
    const lines = captureLog(() => l.debug('debug msg'));
    assert.ok(lines.length > 0);
    assert.ok(lines[0].includes('DEBUG'));
});

test('log() proxies directly to console.log', () => {
    const l = new Logger();
    const lines = captureLog(() => l.log('raw output'));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('raw output'));
});

test('header() writes a section header to console.log', () => {
    const l = new Logger();
    const lines = captureLog(() => l.header('My Section'));
    assert.ok(lines.length > 0);
    assert.ok(lines[0].includes('My Section'));
});

test('print() accepts extra args and appends them', () => {
    const l = new Logger();
    const lines = captureLog(() => l.info('count: %d', 42));
    assert.ok(lines.length > 0);
    // The extra arg is passed to console.log — captured as joined string
    assert.ok(lines[0].includes('42') || lines.join(' ').includes('42'));
});

// --- singleton logger export ---

test('exported logger is a Logger instance', () => {
    assert.ok(logger instanceof Logger);
});
