import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import express from 'express';

import { RequestTelemetry, requestTelemetry } from '../src/telemetry/request-telemetry.js';
import telemetryRouter from '../src/routes/telemetry.routes.js';

test('buckets the live trace per second and pads quiet seconds', () => {
    let now = Date.parse('2026-07-31T10:00:30.000Z');
    const telemetry = new RequestTelemetry({ now: () => now });

    const first = telemetry.start({ model: 'claude-opus-4-8' });
    now += 200;
    telemetry.finish(first, { outcome: 'success', status: 200 });

    now += 2_000;
    const second = telemetry.start({ model: 'claude-opus-4-8' });
    now += 50;
    telemetry.finish(second, { outcome: 'failure', status: 500, errorType: 'api_error' });

    const series = telemetry.liveSeries(10);

    assert.equal(series.length, 10);
    // Buckets are contiguous, one second apart, oldest first.
    for (let index = 1; index < series.length; index++) {
        assert.equal(series[index].t - series[index - 1].t, 1_000);
    }
    assert.deepEqual(
        series.reduce(
            (sum, entry) => ({ ok: sum.ok + entry.ok, fail: sum.fail + entry.fail }),
            { ok: 0, fail: 0 }
        ),
        { ok: 1, fail: 1 }
    );
    assert.equal(series.at(-1).fail, 1, 'the newest bucket holds the newest event');
});

test('liveSeries is bounded and liveTick reports only the current second', () => {
    let now = Date.parse('2026-07-31T10:00:00.000Z');
    const telemetry = new RequestTelemetry({ now: () => now });

    assert.equal(telemetry.liveSeries(100_000).length, 600, 'clamps to the 600s ceiling');
    assert.equal(telemetry.liveSeries(0).length, 90, 'falls back to the default span');

    const id = telemetry.start({ model: 'claude-haiku-4-5' });
    now += 40;
    telemetry.finish(id, { outcome: 'canceled', status: 499, errorType: 'client_abort' });

    assert.deepEqual(
        { hold: telemetry.liveTick().hold, in_flight: telemetry.liveTick().in_flight },
        { hold: 1, in_flight: 0 }
    );

    now += 1_000;
    assert.equal(telemetry.liveTick().hold, 0, 'the next second starts empty');
});

test('notifies subscribers on start and finish, and survives a throwing listener', () => {
    const telemetry = new RequestTelemetry();
    const seen = [];

    const unsubscribe = telemetry.subscribe(() => {
        throw new Error('a broken subscriber must not break accounting');
    });
    telemetry.subscribe((change) => seen.push(change.type));

    const id = telemetry.start({ model: 'claude-opus-4-8' });
    assert.ok(telemetry.finish(id, { outcome: 'success', status: 200 }));
    assert.deepEqual(seen, ['start', 'finish']);

    unsubscribe();
    telemetry.finish(telemetry.start({ model: 'x' }), { outcome: 'success', status: 200 });
    assert.deepEqual(seen, ['start', 'finish', 'start', 'finish']);
});

/** Reads whole SSE frames off a live response until the socket is destroyed. */
function collectFrames(response) {
    let buffer = '';
    const frames = [];
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = raw.match(/^event: (.+)$/m)?.[1];
            const data = raw.match(/^data: (.+)$/m)?.[1];
            if (event && data) frames.push({ event, data: JSON.parse(data) });
            boundary = buffer.indexOf('\n\n');
        }
    });
    return frames;
}

/**
 * Boots the telemetry router on an ephemeral port. Teardown force-closes
 * sockets: an event stream never ends on its own, so a plain server.close()
 * would hang waiting for it.
 */
async function withStreamServer(t) {
    const app = express();
    app.use('/ui/telemetry', telemetryRouter);
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const open = new Set();

    t.after(async () => {
        for (const response of open) response.destroy();
        // Disconnect cleanup runs on the socket 'close' event, so give the
        // handler a turn before the next test samples subscriber state.
        await settle(120);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    return {
        async open(path) {
            const response = await new Promise((resolve) => {
                http.get(`http://127.0.0.1:${server.address().port}${path}`, resolve);
            });
            open.add(response);
            return response;
        }
    };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('streams an init frame and pushes aggregates after a request completes', async (t) => {
    requestTelemetry.reset();
    t.after(() => requestTelemetry.reset());

    const client = await withStreamServer(t);
    const response = await client.open('/ui/telemetry/stream?window=15&live=12');

    assert.match(response.headers['content-type'], /text\/event-stream/);
    assert.equal(response.headers['cache-control'], 'no-store');

    const frames = collectFrames(response);
    await settle(60);

    assert.equal(frames[0].event, 'init');
    assert.equal(frames[0].data.snapshot.window_minutes, 15);
    assert.equal(frames[0].data.live.length, 12);
    assert.equal(typeof frames[0].data.tick_interval_ms, 'number');

    // A completed request must produce an aggregate frame without waiting for
    // the slow interval.
    const id = requestTelemetry.start({ model: 'claude-opus-4-8' });
    requestTelemetry.finish(id, { outcome: 'success', status: 200 });
    await settle(1_300);

    const pushed = frames.find((frame) => frame.event === 'snapshot');
    assert.ok(pushed, 'expected a coalesced snapshot frame');
    assert.equal(pushed.data.totals.requests, 1);
    assert.equal(
        JSON.stringify(frames).includes('claude-opus-4-8'),
        true,
        'model labels are allowlisted metadata and expected in the stream'
    );

    const tick = frames.find((frame) => frame.event === 'tick');
    assert.ok(tick, 'expected at least one 1 Hz trace frame');
    assert.equal(typeof tick.data.t, 'number');
});

test('releases stream resources when the client disconnects', async (t) => {
    const client = await withStreamServer(t);
    await settle(120);

    const before = requestTelemetry.listeners.size;
    const response = await client.open('/ui/telemetry/stream');
    await settle(40);
    assert.equal(requestTelemetry.listeners.size, before + 1);

    response.destroy();
    await settle(150);

    assert.equal(
        requestTelemetry.listeners.size,
        before,
        'the subscription and its timers must be cleared on disconnect'
    );
});
