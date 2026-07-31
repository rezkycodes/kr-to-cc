import express from 'express';
import { requestTelemetry } from '../telemetry/request-telemetry.js';
import { renderTelemetryPage } from '../ui/telemetry-page.js';

const router = express.Router();

// Frame cadence for the realtime trace. One second matches the live bucket
// width, so the chart advances exactly one column per frame.
const TICK_INTERVAL_MS = 1_000;
// Aggregates (totals, latency percentiles, model and error tables) change far
// more slowly than the trace, so they ride a slower channel.
const SNAPSHOT_INTERVAL_MS = 5_000;
// A mutation pushes an aggregate frame early, but no faster than this.
const SNAPSHOT_COALESCE_MS = 400;
// Comment line that keeps intermediaries from closing an idle connection.
const HEARTBEAT_INTERVAL_MS = 20_000;
// This is a localhost management surface; a small ceiling is enough and keeps a
// runaway client from pinning timers open indefinitely.
const MAX_STREAM_CLIENTS = 8;

let streamClients = 0;

router.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderTelemetryPage());
});

router.get('/data', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(requestTelemetry.snapshot(req.query.window));
});

/**
 * GET /ui/telemetry/stream — server-sent events for the live dashboard.
 *
 * Three frame types:
 *   init     once on connect: full snapshot plus the per-second backlog
 *   tick     every second: the newest per-second bucket only
 *   snapshot aggregates, on a slow interval and shortly after any mutation
 */
router.get('/stream', (req, res) => {
    if (streamClients >= MAX_STREAM_CLIENTS) {
        return res.status(503).json({
            error: 'Too many telemetry stream clients. Close another dashboard tab.'
        });
    }

    const windowMinutes = req.query.window;
    const liveSeconds = req.query.live;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        // Disable proxy buffering so frames are not batched on their way out.
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    streamClients++;

    let closed = false;
    let snapshotTimer;

    const send = (event, payload) => {
        if (closed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const sendSnapshot = () => {
        if (snapshotTimer) {
            clearTimeout(snapshotTimer);
            snapshotTimer = undefined;
        }
        send('snapshot', requestTelemetry.snapshot(windowMinutes));
    };

    send('init', {
        snapshot: requestTelemetry.snapshot(windowMinutes),
        live: requestTelemetry.liveSeries(liveSeconds),
        tick_interval_ms: TICK_INTERVAL_MS
    });

    const tickInterval = setInterval(() => send('tick', requestTelemetry.liveTick()), TICK_INTERVAL_MS);
    const snapshotInterval = setInterval(sendSnapshot, SNAPSHOT_INTERVAL_MS);
    const heartbeatInterval = setInterval(() => {
        if (!closed) res.write(': keep-alive\n\n');
    }, HEARTBEAT_INTERVAL_MS);

    // Coalesce bursts: a streaming run finishing does not need its own frame.
    const unsubscribe = requestTelemetry.subscribe(() => {
        if (closed || snapshotTimer) return;
        snapshotTimer = setTimeout(sendSnapshot, SNAPSHOT_COALESCE_MS);
    });

    const cleanup = () => {
        if (closed) return;
        closed = true;
        streamClients--;
        unsubscribe();
        clearInterval(tickInterval);
        clearInterval(snapshotInterval);
        clearInterval(heartbeatInterval);
        if (snapshotTimer) clearTimeout(snapshotTimer);
        res.end();
    };

    req.on('close', cleanup);
    res.on('error', cleanup);
    return undefined;
});

export default router;
