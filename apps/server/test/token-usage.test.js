/**
 * Token and credit accounting.
 *
 * Kiro's backend reports no token usage at all, so counts are estimated locally.
 * These tests pin the two things that could quietly mislead: that a reported
 * count always beats an estimate, and that "not reported" stays null rather than
 * collapsing to a confident zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RequestTelemetry } from '../src/telemetry/request-telemetry.js';
import {
    estimateRequestTokens,
    estimateTokensForLength,
    flattenContent
} from '../src/telemetry/token-estimate.js';
import { modelCostMultiplier } from '../src/kiro/model-api.js';

/** Collector with a controllable clock. */
function makeTelemetry() {
    let now = 1_700_000_000_000;
    const telemetry = new RequestTelemetry({ now: () => now });
    return { telemetry, advance: (ms) => { now += ms; } };
}

test('estimates prompt size from system, messages, and tools', () => {
    const tokens = estimateRequestTokens({
        system: 'be terse',
        messages: [{ role: 'user', content: 'hello world' }],
        tools: [{ name: 'grep', description: 'search' }]
    });
    assert.ok(tokens > 0, 'expected a positive estimate');

    // Longer prompts must estimate higher — the ordering is what the dashboard relies on.
    const bigger = estimateRequestTokens({
        system: 'be terse',
        messages: [{ role: 'user', content: 'hello world'.repeat(100) }]
    });
    assert.ok(bigger > tokens);

    assert.equal(estimateRequestTokens({}), 0);
    assert.equal(estimateTokensForLength(0), 0);
    assert.equal(estimateTokensForLength(1), 1, 'any text is at least one token');
});

test('flattens block content without leaking structure into the count', () => {
    assert.equal(flattenContent('plain'), 'plain');
    assert.equal(flattenContent(null), '');

    // Block arrays are joined per block. The text is JSON-encoded, which adds a
    // couple of quote characters per block — carried over verbatim from the
    // original /v1/messages/count_tokens heuristic so the two agree. It only ever
    // feeds a length measurement, so the overhead is immaterial.
    const flattened = flattenContent([
        { type: 'text', text: 'alpha' },
        { type: 'text', text: 'beta' }
    ]);
    assert.match(flattened, /alpha/);
    assert.match(flattened, /beta/);
    assert.equal(flattened.split('\n').length, 2, 'one line per block');
});

test('records estimated token counts and prices the request in credits', () => {
    const { telemetry, advance } = makeTelemetry();
    const id = telemetry.start({
        model: 'claude-opus-4-8',
        costMultiplier: modelCostMultiplier('claude-opus-4-8')
    });
    telemetry.recordUsage(id, { input_tokens: 120, estimated: true });
    telemetry.recordUsage(id, { output_tokens: 40, estimated: true });
    advance(500);
    const event = telemetry.finish(id, { outcome: 'success', status: 200 });

    assert.equal(event.input_tokens, 120);
    assert.equal(event.output_tokens, 40);
    assert.equal(event.cached_tokens, null, 'cache hits are never reported');
    assert.equal(event.tokens_estimated, true);
    assert.equal(event.cost_credits, 2.2);

    const usage = telemetry.snapshot(15).usage;
    assert.equal(usage.input_tokens, 120);
    assert.equal(usage.output_tokens, 40);
    assert.equal(usage.total_tokens, 160);
    assert.equal(usage.cached_tokens, null);
    assert.equal(usage.estimated, true);
    assert.equal(usage.cost_credits, 2.2);
    assert.equal(usage.priced_requests, 1);
});

test('a count reported by the upstream outranks the local estimate', () => {
    const { telemetry } = makeTelemetry();
    const id = telemetry.start({ model: 'claude-sonnet-4-5', costMultiplier: 1.3 });

    telemetry.recordUsage(id, { input_tokens: 100, output_tokens: 10, estimated: true });
    // A zero from upstream carries no information and must not erase the estimate.
    telemetry.recordUsage(id, { input_tokens: 0, output_tokens: 0 });
    telemetry.recordUsage(id, { input_tokens: 875 });

    const event = telemetry.finish(id, { outcome: 'success', status: 200 });
    assert.equal(event.input_tokens, 875, 'reported value wins');
    assert.equal(event.output_tokens, 10, 'estimate survives an upstream zero');

    // An estimate must not overwrite a value the upstream already reported.
    const second = telemetry.start({ model: 'claude-sonnet-4-5', costMultiplier: 1.3 });
    telemetry.recordUsage(second, { input_tokens: 500 });
    telemetry.recordUsage(second, { input_tokens: 9, estimated: true });
    const secondEvent = telemetry.finish(second, { outcome: 'success', status: 200 });
    assert.equal(secondEvent.input_tokens, 500);
    assert.equal(secondEvent.tokens_estimated, false);
});

test('a failed request costs no credits but still accounts for its prompt', () => {
    const { telemetry } = makeTelemetry();
    const id = telemetry.start({ model: 'claude-opus-4-8', costMultiplier: 2.2 });
    telemetry.recordUsage(id, { input_tokens: 64, estimated: true });
    const event = telemetry.finish(id, { outcome: 'failure', status: 500, errorType: 'api_error' });

    assert.equal(event.cost_credits, null, 'a request that never reached the model is not billed');
    assert.equal(event.input_tokens, 64);

    const usage = telemetry.snapshot(15).usage;
    assert.equal(usage.cost_credits, null);
    assert.equal(usage.priced_requests, 0);
});

test('an unknown model is counted as unpriced rather than free', () => {
    assert.equal(modelCostMultiplier('not-a-model'), null);
    assert.equal(modelCostMultiplier(''), null);
    // -thinking variants bill at the base model rate.
    assert.equal(modelCostMultiplier('claude-opus-4-8-thinking'), 2.2);
    assert.equal(modelCostMultiplier('claude-haiku-4-5'), 0.4);

    const { telemetry } = makeTelemetry();
    const id = telemetry.start({
        model: 'mystery-model',
        costMultiplier: modelCostMultiplier('mystery-model')
    });
    telemetry.finish(id, { outcome: 'success', status: 200 });

    const usage = telemetry.snapshot(15).usage;
    assert.equal(usage.cost_credits, null);
    assert.equal(usage.unpriced_requests, 1);
});

test('recent_requests carries every outcome, newest first', () => {
    const { telemetry, advance } = makeTelemetry();
    for (const [model, outcome] of [
        ['claude-haiku-4-5', 'success'],
        ['claude-opus-4-8', 'failure'],
        ['claude-sonnet-4-5', 'canceled']
    ]) {
        const id = telemetry.start({ model, costMultiplier: modelCostMultiplier(model) });
        telemetry.recordUsage(id, { input_tokens: 10, output_tokens: 5, estimated: true });
        advance(10);
        telemetry.finish(id, { outcome, status: outcome === 'success' ? 200 : 500 });
    }

    const recent = telemetry.snapshot(15).recent_requests;
    assert.equal(recent.length, 3);
    assert.deepEqual(
        recent.map((event) => event.model),
        ['claude-sonnet-4-5', 'claude-opus-4-8', 'claude-haiku-4-5']
    );
    assert.equal(recent[0].input_tokens, 10);
    // Never expose the internal sort key.
    assert.ok(!('timestamp_ms' in recent[0]));
});

test('token counts are declared in the privacy manifest, credentials are not', () => {
    const { telemetry } = makeTelemetry();
    const { privacy } = telemetry.snapshot(15);
    for (const field of ['input_tokens', 'output_tokens', 'cached_tokens', 'cost_credits']) {
        assert.ok(privacy.collects.includes(field), `${field} should be declared`);
    }
    assert.ok(privacy.excludes.includes('auth_tokens'));
    assert.ok(privacy.excludes.includes('prompt'));
    assert.ok(!privacy.excludes.includes('tokens'), 'ambiguous label should be gone');
});
