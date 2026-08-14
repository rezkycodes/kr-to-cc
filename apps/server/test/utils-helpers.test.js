import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDuration, sleep, createAbortContext } from '../src/utils/helpers.js';

// --- formatDuration ---

test('formatDuration returns seconds-only for sub-minute durations', () => {
    assert.equal(formatDuration(5000), '5s');
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(999), '0s');
    assert.equal(formatDuration(59999), '59s');
});

test('formatDuration returns minutes+seconds for durations under one hour', () => {
    assert.equal(formatDuration(60_000), '1m0s');
    assert.equal(formatDuration(90_000), '1m30s');
    assert.equal(formatDuration(3599_000), '59m59s');
});

test('formatDuration returns hours+minutes+seconds for durations >= 1 hour', () => {
    assert.equal(formatDuration(3600_000), '1h0m0s');
    assert.equal(formatDuration(3661_000), '1h1m1s');
    assert.equal(formatDuration(7384_000), '2h3m4s');
});

// --- sleep ---

test('sleep resolves after the specified duration', async () => {
    const start = Date.now();
    await sleep(20);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 15, `expected >= 15ms, got ${elapsed}ms`);
});

test('sleep returns a Promise', () => {
    const result = sleep(0);
    assert.ok(result instanceof Promise);
    return result; // clean up
});

// --- createAbortContext ---

test('createAbortContext returns signal and cleanup function', () => {
    const ctx = createAbortContext(null, 5000);
    assert.ok(ctx.signal instanceof AbortSignal);
    assert.ok(typeof ctx.cleanup === 'function');
    ctx.cleanup();
});

test('createAbortContext signal is not immediately aborted', () => {
    const ctx = createAbortContext(null, 5000);
    assert.equal(ctx.signal.aborted, false);
    ctx.cleanup();
});

test('createAbortContext aborts when parent signal is already aborted', () => {
    const parent = new AbortController();
    parent.abort();
    const ctx = createAbortContext(parent.signal, 5000);
    assert.equal(ctx.signal.aborted, true);
    ctx.cleanup();
});

test('createAbortContext aborts when parent signal fires after creation', async () => {
    const parent = new AbortController();
    const ctx = createAbortContext(parent.signal, 5000);
    assert.equal(ctx.signal.aborted, false);
    parent.abort();
    // Signal propagation is synchronous
    assert.equal(ctx.signal.aborted, true);
    ctx.cleanup();
});

test('createAbortContext aborts on timeout', async () => {
    const ctx = createAbortContext(null, 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ctx.signal.aborted, true);
    ctx.cleanup();
});

test('createAbortContext cleanup prevents timeout from aborting', async () => {
    const ctx = createAbortContext(null, 50);
    ctx.cleanup(); // cancel immediately
    await new Promise((resolve) => setTimeout(resolve, 80));
    // signal should NOT have been aborted by the timeout since cleanup cleared it
    // (it may still be unaborted)
    assert.equal(ctx.signal.aborted, false);
});
