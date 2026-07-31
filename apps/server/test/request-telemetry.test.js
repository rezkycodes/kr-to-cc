import test from 'node:test';
import assert from 'node:assert/strict';

import { RequestTelemetry } from '../src/telemetry/request-telemetry.js';

test('summarizes RED metrics without retaining request content', () => {
    let now = Date.parse('2026-07-31T10:00:00.000Z');
    const telemetry = new RequestTelemetry({
        now: () => now,
        maxEvents: 20,
        retentionMs: 6 * 60 * 60 * 1000
    });

    const successId = telemetry.start({
        route: '/v1/messages',
        method: 'POST',
        model: 'claude-opus-4-8',
        stream: true,
        prompt: 'must never be retained'
    });
    now += 120;
    telemetry.finish(successId, { outcome: 'success', status: 200 });

    now += 60_000;
    const failureId = telemetry.start({
        route: '/v1/messages',
        method: 'POST',
        model: 'claude-sonnet-5',
        stream: false
    });
    now += 300;
    telemetry.finish(failureId, {
        outcome: 'failure',
        status: 400,
        errorType: 'invalid_request_error',
        errorMessage: 'must never be retained'
    });

    const activeId = telemetry.start({
        route: '/v1/messages',
        method: 'POST',
        model: 'claude-opus-4-8',
        stream: true
    });
    const snapshot = telemetry.snapshot(60);

    assert.deepEqual(snapshot.totals, {
        requests: 2,
        success: 1,
        failed: 1,
        canceled: 0,
        in_flight: 1,
        success_rate: 50
    });
    assert.deepEqual(snapshot.latency_ms, {
        p50: 120,
        p95: 300,
        p99: 300,
        max: 300
    });
    assert.equal(snapshot.by_model[0].model, 'claude-opus-4-8');
    assert.equal(snapshot.by_error[0].type, 'invalid_request_error');
    assert.equal(snapshot.recent_failures[0].request_id, failureId);
    assert.equal(snapshot.recent_failures[0].error_type, 'invalid_request_error');
    assert.equal(JSON.stringify(snapshot).includes('must never be retained'), false);
    assert.equal(snapshot.series.length, 60);

    telemetry.finish(activeId, { outcome: 'canceled', status: 499, errorType: 'client_abort' });
});

test('bounds retained events and makes finish idempotent', () => {
    let now = Date.parse('2026-07-31T10:00:00.000Z');
    const telemetry = new RequestTelemetry({ now: () => now, maxEvents: 2 });

    for (let index = 0; index < 3; index++) {
        const id = telemetry.start({ model: `model-${index}`, stream: false });
        now += 10;
        assert.ok(telemetry.finish(id, { outcome: 'success', status: 200 }));
        assert.equal(telemetry.finish(id, { outcome: 'failure', status: 500 }), null);
    }

    const snapshot = telemetry.snapshot(60);
    assert.equal(snapshot.totals.requests, 2);
    assert.deepEqual(snapshot.by_model.map((item) => item.model).sort(), ['model-1', 'model-2']);
});
