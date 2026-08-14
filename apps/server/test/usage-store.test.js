/**
 * Usage rollup tests.
 *
 * The store answers "which provider served my traffic", so the cases that matter
 * are attribution, the estimated/measured split, and not inventing figures a
 * backend never reported.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    __setStorePathForTests,
    clearUsage,
    flushUsageNow,
    readUsage,
    recordUsageEvent
} from '../src/telemetry/usage-store.js';

function isolate() {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'kr-usage-')),
        'usage.json'
    );
    __setStorePathForTests(file);
    return file;
}

function event(overrides = {}) {
    return {
        timestamp_ms: Date.now(),
        served_provider: 'google',
        served_model: 'gemini-3-flash',
        outcome: 'success',
        input_tokens: 10,
        output_tokens: 20,
        cached_tokens: null,
        cost_credits: 0.4,
        duration_ms: 500,
        tokens_estimated: false,
        ...overrides
    };
}

test('usage is attributed to the provider that served the request', () => {
    isolate();
    clearUsage();

    recordUsageEvent(event());
    recordUsageEvent(event());
    recordUsageEvent(event({ served_provider: 'kiro', served_model: 'claude-sonnet-4-6' }));

    const usage = readUsage();
    assert.equal(usage.totals.requests, 3);

    const google = usage.by_provider.find((p) => p.provider === 'google');
    const kiro = usage.by_provider.find((p) => p.provider === 'kiro');
    assert.equal(google.requests, 2);
    assert.equal(kiro.requests, 1);
    // Sorted busiest first, so the page does not have to sort again.
    assert.equal(usage.by_provider[0].provider, 'google');
});

test('the same model id on two providers is not merged', () => {
    isolate();
    clearUsage();

    // claude-sonnet-4-6 exists on both. Merging them would hide where traffic went.
    recordUsageEvent(event({ served_provider: 'google', served_model: 'claude-sonnet-4-6' }));
    recordUsageEvent(event({ served_provider: 'kiro', served_model: 'claude-sonnet-4-6' }));

    const { by_model } = readUsage();
    const rows = by_model.filter((m) => m.model === 'claude-sonnet-4-6');
    assert.equal(rows.length, 2, 'expected one row per provider');
    assert.deepEqual(rows.map((r) => r.provider).sort(), ['google', 'kiro']);
});

test('a namespaced model id does not repeat its provider', () => {
    isolate();
    clearUsage();

    // A request that fails before a member is chosen keeps the id the client sent.
    recordUsageEvent(
        event({
            served_provider: 'kiro',
            served_model: 'kiro/claude-haiku-4-5',
            outcome: 'error'
        })
    );

    const { by_model } = readUsage();
    assert.equal(by_model[0].model, 'claude-haiku-4-5');
    assert.equal(by_model[0].provider, 'kiro');
    assert.equal(by_model[0].failed, 1);
    assert.equal(by_model[0].ok, 0);
});

test('cached tokens stay unknown rather than becoming zero', () => {
    isolate();
    clearUsage();

    // Kiro reports no cache figures at all. Recording 0 would read as "nothing was
    // cached" instead of "not reported".
    recordUsageEvent(event({ served_provider: 'kiro', cached_tokens: null }));
    assert.equal(readUsage().totals.cached_tokens, null);

    // Once a backend does report, the figure appears.
    recordUsageEvent(event({ served_provider: 'google', cached_tokens: 128 }));
    assert.equal(readUsage().totals.cached_tokens, 128);
});

test('the estimated and measured split is kept per request', () => {
    isolate();
    clearUsage();

    // Google measures, Kiro is estimated locally; a mixed window has to say so.
    recordUsageEvent(event({ tokens_estimated: false }));
    recordUsageEvent(event({ served_provider: 'kiro', tokens_estimated: true }));

    const { totals } = readUsage();
    assert.equal(totals.measured_requests, 1);
    assert.equal(totals.estimated_requests, 1);
});

test('rollups survive a restart', () => {
    const file = isolate();
    clearUsage();

    recordUsageEvent(event());
    flushUsageNow();
    assert.ok(fs.existsSync(file), 'expected the rollups to be written');

    // Re-point at the same file to drop the in-process cache, as a restart would.
    __setStorePathForTests(file);
    assert.equal(readUsage().totals.requests, 1);
});

test('a malformed event is ignored rather than throwing', () => {
    isolate();
    clearUsage();

    // Usage history is decoration and must never be able to fail a request.
    for (const bad of [null, undefined, 'nope', 42, []]) {
        recordUsageEvent(bad);
    }
    assert.equal(readUsage().totals.requests, 0);
});
