/**
 * Persistent usage rollups.
 *
 * The live telemetry in `request-telemetry.js` keeps six hours of individual
 * events in memory and loses them on restart, which is fine for a realtime trace
 * but useless for answering "which provider served my traffic this week". This
 * store exists for that question.
 *
 * What is kept is deliberately narrow: **counters only**, bucketed per day per
 * served provider and model. No prompts, no responses, no request ids, no
 * timestamps beyond the day and a `last_used`. That keeps the file small and means
 * losing it leaks nothing about what was asked.
 *
 * Writes are debounced because a busy proxy would otherwise hit the disk on every
 * request.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logger } from '../utils/logger.js';

/** How long a day's rollup is kept before it is dropped. */
const RETENTION_DAYS = 90;

/** Coalesce writes; a burst of requests should cost one write, not hundreds. */
const FLUSH_DELAY_MS = 2_000;

/** Overridden by tests so they never touch the real config. */
let storeOverride = null;

function storePath() {
    return storeOverride || path.join(os.homedir(), '.config', 'kiro-proxy', 'usage.json');
}

/**
 * Point the store at a different file, and drop what is cached. Test-only.
 * @param {string|null} filePath
 */
export function __setStorePathForTests(filePath) {
    storeOverride = filePath;
    cache = null;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
}

/** @type {{days: Record<string, Record<string, object>>}|null} */
let cache = null;
let flushTimer = null;

/** The UTC day a timestamp falls in. UTC so a rollup never shifts with the TZ. */
function dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function emptyRow(provider, model) {
    return {
        provider,
        model,
        requests: 0,
        ok: 0,
        failed: 0,
        input_tokens: 0,
        output_tokens: 0,
        // Null until something reports a cache figure: Kiro never does, and 0
        // would read as "nothing was cached" rather than "not reported".
        cached_tokens: null,
        cost_credits: 0,
        estimated_requests: 0,
        measured_requests: 0,
        duration_ms_total: 0,
        last_used: null
    };
}

function load() {
    if (cache) return cache;
    try {
        const raw = fs.readFileSync(storePath(), 'utf8');
        const parsed = JSON.parse(raw);
        cache = parsed && typeof parsed.days === 'object' ? { days: parsed.days } : { days: {} };
    } catch {
        // A missing or unreadable file simply means no history yet.
        cache = { days: {} };
    }
    return cache;
}

/** Drop rollups older than the retention window. */
function prune(store) {
    const cutoff = dayKey(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    for (const day of Object.keys(store.days)) {
        if (day < cutoff) delete store.days[day];
    }
}

function flush() {
    flushTimer = null;
    if (!cache) return;
    const file = storePath();
    try {
        prune(cache);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // 0600: usage counts are not secrets, but this sits beside the token
        // store and inherits the same expectation.
        fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch (error) {
        // Never surface this: usage history is decoration and must not be able to
        // affect a request.
        logger.debug?.(`[Usage] Could not persist usage rollups: ${error.message}`);
    }
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    // Do not hold the process open just to write counters.
    flushTimer.unref?.();
}

/** Write immediately. Used on shutdown and by tests. */
export function flushUsageNow() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    flush();
}

/**
 * Fold one completed request into the rollups.
 *
 * Attribution is on **who served** the request, not what was asked for, so a
 * combo's traffic lands against the member that actually answered.
 *
 * @param {object} event a completed telemetry event
 */
export function recordUsageEvent(event) {
    // Arrays pass a bare typeof check and would create a bogus row, so the shape
    // is checked properly. Nothing here may throw: a bad event must be dropped,
    // never surfaced.
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;

    const store = load();
    const when = Number.isFinite(event.timestamp_ms) ? event.timestamp_ms : Date.now();
    const day = dayKey(when);
    const provider = event.served_provider || event.provider || 'unresolved';
    // A request that failed before a member was chosen keeps the namespaced id the
    // client sent, so `kiro/claude-haiku-4-5` would sit in a row already labelled
    // kiro. Stripped here so the provider is named once.
    const rawModel = event.served_model || event.model || 'unknown';
    const model = rawModel.startsWith(`${provider}/`)
        ? rawModel.slice(provider.length + 1)
        : rawModel;
    const key = `${provider}/${model}`;

    const bucket = (store.days[day] ||= {});
    const row = (bucket[key] ||= emptyRow(provider, model));

    row.requests += 1;
    if (event.outcome === 'success') row.ok += 1;
    else row.failed += 1;

    if (Number.isFinite(event.input_tokens)) row.input_tokens += event.input_tokens;
    if (Number.isFinite(event.output_tokens)) row.output_tokens += event.output_tokens;
    if (Number.isFinite(event.cached_tokens)) {
        row.cached_tokens = (row.cached_tokens ?? 0) + event.cached_tokens;
    }
    if (Number.isFinite(event.cost_credits)) row.cost_credits += event.cost_credits;
    if (Number.isFinite(event.duration_ms)) row.duration_ms_total += event.duration_ms;

    // Recorded per request so a mixed window can say how much of it was measured.
    if (event.tokens_estimated === true) row.estimated_requests += 1;
    else if (event.tokens_estimated === false) row.measured_requests += 1;

    row.last_used = new Date(when).toISOString();

    scheduleFlush();
}

/** Add two rows' counters together, keeping `cached_tokens` null when unreported. */
function addInto(target, row) {
    target.requests += row.requests;
    target.ok += row.ok;
    target.failed += row.failed;
    target.input_tokens += row.input_tokens;
    target.output_tokens += row.output_tokens;
    if (row.cached_tokens != null) {
        target.cached_tokens = (target.cached_tokens ?? 0) + row.cached_tokens;
    }
    target.cost_credits += row.cost_credits;
    target.estimated_requests += row.estimated_requests;
    target.measured_requests += row.measured_requests;
    target.duration_ms_total += row.duration_ms_total;
    if (row.last_used && (!target.last_used || row.last_used > target.last_used)) {
        target.last_used = row.last_used;
    }
}

/**
 * Aggregated usage over a window.
 *
 * @param {{days?: number}} [options] how many days back, inclusive of today.
 *   Omit for everything retained.
 */
export function readUsage(options = {}) {
    const store = load();
    const dayKeys = Object.keys(store.days).sort();

    let selected = dayKeys;
    if (Number.isFinite(options.days) && options.days > 0) {
        const cutoff = dayKey(Date.now() - (options.days - 1) * 24 * 60 * 60 * 1000);
        selected = dayKeys.filter((day) => day >= cutoff);
    }

    const totals = emptyRow('all', 'all');
    const byProvider = new Map();
    const byModel = new Map();
    const series = [];

    for (const day of selected) {
        const dayTotal = emptyRow('all', 'all');

        for (const row of Object.values(store.days[day])) {
            addInto(totals, row);
            addInto(dayTotal, row);

            const provider = byProvider.get(row.provider) || emptyRow(row.provider, 'all');
            addInto(provider, row);
            byProvider.set(row.provider, provider);

            // Keyed by provider and model together: the same model id exists on
            // two providers, and merging them would hide where traffic went.
            const modelKey = `${row.provider}/${row.model}`;
            const model = byModel.get(modelKey) || emptyRow(row.provider, row.model);
            addInto(model, row);
            byModel.set(modelKey, model);
        }

        series.push({
            date: day,
            requests: dayTotal.requests,
            ok: dayTotal.ok,
            failed: dayTotal.failed,
            input_tokens: dayTotal.input_tokens,
            output_tokens: dayTotal.output_tokens,
            cost_credits: dayTotal.cost_credits
        });
    }

    return {
        // Stated so a caller never has to guess the unit. Kiro bills in credits
        // and publishes no per-token rate, so there is no dollar figure here.
        cost_unit: 'kiro_credits',
        days_covered: selected.length,
        retention_days: RETENTION_DAYS,
        // The earliest day still on record, so the UI can say how far back it goes
        // rather than implying the window is complete.
        earliest_day: dayKeys[0] ?? null,
        totals,
        by_provider: [...byProvider.values()].sort((a, b) => b.requests - a.requests),
        by_model: [...byModel.values()].sort((a, b) => b.requests - a.requests),
        series
    };
}

/** Forget everything. Test-only, and used by the UI's reset. */
export function clearUsage() {
    cache = { days: {} };
    flushUsageNow();
}

export default { recordUsageEvent, readUsage, clearUsage, flushUsageNow };
