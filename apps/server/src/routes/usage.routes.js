/**
 * Usage history.
 *
 * Answers "which provider served my traffic, and what did it cost" over days
 * rather than the six-hour in-memory window the realtime trace uses.
 */

import express from 'express';

import { requestTelemetry } from '../telemetry/request-telemetry.js';
import { clearUsage, flushUsageNow, readUsage } from '../telemetry/usage-store.js';

const router = express.Router();

/** Ranges the UI offers, in days. `all` means everything retained. */
const RANGES = {
    today: 1,
    '7d': 7,
    '30d': 30,
    '90d': 90,
    all: null
};

/**
 * GET /ui/usage — aggregated history.
 *
 * @query range one of today, 7d, 30d, 90d, all. Defaults to 7d.
 */
router.get('/usage', (req, res) => {
    const requested = typeof req.query.range === 'string' ? req.query.range : '7d';
    const range = Object.hasOwn(RANGES, requested) ? requested : '7d';
    const days = RANGES[range];

    const usage = readUsage(days ? { days } : {});

    // The last few requests come from live telemetry, not the rollups: the rollups
    // hold counters only, so they cannot show individual requests.
    const snapshot = requestTelemetry.snapshot(360);

    res.json({
        range,
        ...usage,
        recent: (snapshot.recent_requests || []).slice(0, 20),
        // Said plainly so the page can explain rather than imply completeness.
        note: 'Counters are kept per day per provider and model. No prompts or '
            + 'responses are stored. Individual requests come from the live window '
            + 'and are lost on restart.'
    });
});

/** DELETE /ui/usage — forget the history. */
router.delete('/usage', (req, res) => {
    clearUsage();
    res.json({ cleared: true });
});

/** POST /ui/usage/flush — write pending counters now, for tests and shutdown. */
router.post('/usage/flush', (req, res) => {
    flushUsageNow();
    res.json({ flushed: true });
});

export default router;
