import crypto from 'crypto';

const DEFAULT_RETENTION_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 2_000;
const BUCKET_MS = 60_000;
const LIVE_BUCKET_MS = 1_000;
const DEFAULT_LIVE_SECONDS = 90;
const MAX_LIVE_SECONDS = 600;
const SAFE_OUTCOMES = new Set(['success', 'failure', 'canceled']);

function boundedLabel(value, fallback, maxLength = 128) {
    const text = typeof value === 'string' ? value.trim() : '';
    return (text || fallback).slice(0, maxLength);
}

function percentile(values, percent) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1);
    return sorted[index];
}

function latencySummary(events) {
    const durations = events
        .filter((event) => event.outcome !== 'canceled')
        .map((event) => event.duration_ms);
    return {
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
        p99: percentile(durations, 99),
        max: durations.length ? Math.max(...durations) : null
    };
}

/**
 * Sum a field across events, returning null when nothing reported it.
 *
 * The distinction matters: 0 means "the upstream told us zero", null means "we
 * were never told". Cached tokens are always the latter today.
 */
function sumReported(events, field) {
    let total = 0;
    let reported = 0;
    for (const event of events) {
        const value = event[field];
        if (typeof value === 'number' && Number.isFinite(value)) {
            total += value;
            reported++;
        }
    }
    return reported ? total : null;
}

/** Token and credit totals for a set of events. */
function usageSummary(events) {
    const input = sumReported(events, 'input_tokens');
    const output = sumReported(events, 'output_tokens');
    const cached = sumReported(events, 'cached_tokens');
    const priced = events.filter((event) => typeof event.cost_credits === 'number');
    const credits = priced.length
        ? Number(priced.reduce((sum, event) => sum + event.cost_credits, 0).toFixed(3))
        : null;
    return {
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
        total_tokens: input === null && output === null ? null : (input || 0) + (output || 0),
        // Kiro reports no usage, so these are heuristic unless that changes.
        estimated: events.some((event) => event.tokens_estimated === true),
        // Kiro bills per request in credits scaled by model, not per token.
        cost_credits: credits,
        priced_requests: priced.length,
        unpriced_requests: events.filter(
            (event) => event.outcome === 'success' && typeof event.cost_credits !== 'number'
        ).length
    };
}

export class RequestTelemetry {
    constructor({
        now = Date.now,
        retentionMs = DEFAULT_RETENTION_MS,
        maxEvents = DEFAULT_MAX_EVENTS
    } = {}) {
        this.now = now;
        this.retentionMs = Math.max(BUCKET_MS, retentionMs);
        this.maxEvents = Math.max(1, maxEvents);
        this.startedAt = this.now();
        this.events = [];
        this.active = new Map();
        this.listeners = new Set();
    }

    /**
     * Subscribe to telemetry mutations so transports (SSE) can push without
     * polling. Listeners are called synchronously and must not throw.
     * @param {(change: { type: 'start' | 'finish' }) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** @param {{ type: 'start' | 'finish' }} change */
    emit(change) {
        for (const listener of this.listeners) {
            try {
                listener(change);
            } catch {
                // A broken subscriber must never break request accounting.
            }
        }
    }

    start(metadata = {}) {
        const now = this.now();
        this.prune(now);
        const requestId = crypto.randomUUID();
        this.active.set(requestId, {
            request_id: requestId,
            started_at_ms: now,
            route: boundedLabel(metadata.route, '/v1/messages'),
            method: boundedLabel(metadata.method, 'POST', 16).toUpperCase(),
            model: boundedLabel(metadata.model, 'unknown'),
            stream: metadata.stream === true,
            // Kiro prices per request by model, so the rate is known up front.
            // Null means unpriced rather than free.
            cost_multiplier: Number.isFinite(metadata.costMultiplier)
                ? metadata.costMultiplier
                : null,
            usage: null
        });
        this.emit({ type: 'start' });
        return requestId;
    }

    /**
     * Attach token counts to an in-flight request.
     *
     * Counts arrive from the upstream response body, which the HTTP-boundary
     * middleware never sees, so the route handler reports them here and finish()
     * folds them into the event. Called more than once during a stream.
     *
     * Precedence: a non-zero count reported by the upstream always wins over a
     * local estimate, and a later value of the same kind replaces an earlier one.
     * Kiro currently reports nothing, so in practice these are estimates — the
     * `estimated` flag is what the dashboard labels them with.
     *
     * Only integer counts are kept — never prompt text, never a raw upstream
     * usage object.
     *
     * @param {string} requestId
     * @param {{ input_tokens?: number, output_tokens?: number, cached_tokens?: number,
     *           estimated?: boolean }} usage
     */
    recordUsage(requestId, usage = {}) {
        const active = this.active.get(requestId);
        if (!active) return null;
        const estimated = usage?.estimated === true;
        const current = active.usage || { estimated: {} };
        const next = { ...current, estimated: { ...current.estimated } };

        for (const field of ['input_tokens', 'output_tokens', 'cached_tokens']) {
            const value = Number(usage?.[field]);
            if (!Number.isFinite(value) || value < 0) continue;
            // An upstream zero carries no information here, so never let it
            // overwrite an estimate we already have.
            if (!estimated && value === 0 && next[field] != null) continue;
            if (estimated && next[field] != null && next.estimated[field] === false) continue;
            next[field] = Math.round(value);
            next.estimated[field] = estimated;
        }

        active.usage = next;
        return active.usage;
    }

    finish(requestId, result = {}) {
        const active = this.active.get(requestId);
        if (!active) return null;

        const now = this.now();
        this.active.delete(requestId);
        const outcome = SAFE_OUTCOMES.has(result.outcome)
            ? result.outcome
            : (Number(result.status) >= 400 ? 'failure' : 'success');
        const status = Number.isInteger(result.status)
            ? Math.min(599, Math.max(100, result.status))
            : (outcome === 'success' ? 200 : 500);
        const usage = this.recordUsage(requestId, result.usage || {}) || active.usage;
        const event = {
            request_id: active.request_id,
            timestamp: new Date(now).toISOString(),
            timestamp_ms: now,
            route: active.route,
            method: active.method,
            model: active.model,
            stream: active.stream,
            outcome,
            status,
            error_type: outcome === 'success'
                ? null
                : boundedLabel(result.errorType, outcome === 'canceled' ? 'client_abort' : 'api_error', 64),
            duration_ms: Math.max(0, Math.round(now - active.started_at_ms)),
            input_tokens: usage?.input_tokens ?? null,
            output_tokens: usage?.output_tokens ?? null,
            // Kiro does not report cache hits, so this stays null (unknown) rather
            // than 0, which would wrongly read as "nothing was cached".
            cached_tokens: usage?.cached_tokens ?? null,
            // True when any count came from the local heuristic rather than upstream.
            tokens_estimated: usage
                ? Object.values(usage.estimated || {}).some((value) => value === true)
                : false,
            // A request only consumes credits if it reached the model.
            cost_credits: outcome === 'success' ? active.cost_multiplier : null
        };

        this.events.push(event);
        this.prune(now);
        if (this.events.length > this.maxEvents) {
            this.events.splice(0, this.events.length - this.maxEvents);
        }
        this.emit({ type: 'finish' });
        return { ...event };
    }

    prune(now = this.now()) {
        const cutoff = now - this.retentionMs;
        if (this.events.length && this.events[0].timestamp_ms < cutoff) {
            this.events = this.events.filter((event) => event.timestamp_ms >= cutoff);
        }
        for (const [requestId, active] of this.active) {
            if (active.started_at_ms < cutoff) this.active.delete(requestId);
        }
    }

    reset() {
        this.events = [];
        this.active.clear();
        this.startedAt = this.now();
    }

    /**
     * Per-second outcome counts for the realtime trace. The minute buckets in
     * snapshot() are too coarse to animate against, so the streaming transport
     * uses this instead.
     * @param {number} [seconds] how far back to bucket, in seconds
     * @returns {Array<{ t: number, ok: number, fail: number, hold: number, p95: number | null }>}
     */
    liveSeries(seconds = DEFAULT_LIVE_SECONDS) {
        const now = this.now();
        const span = Math.min(
            MAX_LIVE_SECONDS,
            Math.max(1, Number.parseInt(seconds, 10) || DEFAULT_LIVE_SECONDS)
        );
        const currentBucket = Math.floor(now / LIVE_BUCKET_MS) * LIVE_BUCKET_MS;
        const oldestBucket = currentBucket - (span - 1) * LIVE_BUCKET_MS;

        const buckets = new Map();
        for (let timestampMs = oldestBucket; timestampMs <= currentBucket; timestampMs += LIVE_BUCKET_MS) {
            buckets.set(timestampMs, []);
        }
        for (const event of this.events) {
            if (event.timestamp_ms < oldestBucket) continue;
            const timestampMs = Math.floor(event.timestamp_ms / LIVE_BUCKET_MS) * LIVE_BUCKET_MS;
            if (buckets.has(timestampMs)) buckets.get(timestampMs).push(event);
        }

        return [...buckets.entries()].map(([t, bucketEvents]) => this.liveBucket(t, bucketEvents));
    }

    /**
     * The single most recent second, shaped like a liveSeries entry. Used for
     * the 1 Hz tick frame pushed over SSE.
     */
    liveTick() {
        const now = this.now();
        const t = Math.floor(now / LIVE_BUCKET_MS) * LIVE_BUCKET_MS;
        const bucketEvents = this.events.filter(
            (event) => event.timestamp_ms >= t && event.timestamp_ms < t + LIVE_BUCKET_MS
        );
        return { ...this.liveBucket(t, bucketEvents), in_flight: this.active.size };
    }

    /** @private */
    liveBucket(t, bucketEvents) {
        let ok = 0;
        let fail = 0;
        let hold = 0;
        for (const event of bucketEvents) {
            if (event.outcome === 'success') ok++;
            else if (event.outcome === 'failure') fail++;
            else hold++;
        }
        return { t, ok, fail, hold, p95: latencySummary(bucketEvents).p95 };
    }

    snapshot(windowMinutes = 60) {
        const now = this.now();
        this.prune(now);
        const boundedWindow = Math.min(
            Math.floor(this.retentionMs / BUCKET_MS),
            Math.max(1, Number.parseInt(windowMinutes, 10) || 60)
        );
        const cutoff = now - boundedWindow * BUCKET_MS;
        const events = this.events.filter((event) => event.timestamp_ms >= cutoff);
        const success = events.filter((event) => event.outcome === 'success').length;
        const failed = events.filter((event) => event.outcome === 'failure').length;
        const canceled = events.filter((event) => event.outcome === 'canceled').length;
        const measured = success + failed;

        const modelGroups = new Map();
        const errorGroups = new Map();
        for (const event of events) {
            const group = modelGroups.get(event.model) || [];
            group.push(event);
            modelGroups.set(event.model, group);
            if (event.error_type) {
                errorGroups.set(event.error_type, (errorGroups.get(event.error_type) || 0) + 1);
            }
        }

        const currentBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
        const buckets = new Map();
        for (let index = boundedWindow - 1; index >= 0; index--) {
            const timestampMs = currentBucket - index * BUCKET_MS;
            buckets.set(timestampMs, []);
        }
        for (const event of events) {
            const timestampMs = Math.floor(event.timestamp_ms / BUCKET_MS) * BUCKET_MS;
            if (buckets.has(timestampMs)) buckets.get(timestampMs).push(event);
        }

        return {
            generated_at: new Date(now).toISOString(),
            process_started_at: new Date(this.startedAt).toISOString(),
            window_minutes: boundedWindow,
            retention_minutes: Math.floor(this.retentionMs / BUCKET_MS),
            max_events: this.maxEvents,
            totals: {
                requests: events.length,
                success,
                failed,
                canceled,
                in_flight: this.active.size,
                success_rate: measured ? Number(((success / measured) * 100).toFixed(1)) : null
            },
            latency_ms: latencySummary(events),
            usage: usageSummary(events),
            series: [...buckets.entries()].map(([timestampMs, bucketEvents]) => ({
                timestamp: new Date(timestampMs).toISOString(),
                success: bucketEvents.filter((event) => event.outcome === 'success').length,
                failed: bucketEvents.filter((event) => event.outcome === 'failure').length,
                canceled: bucketEvents.filter((event) => event.outcome === 'canceled').length,
                p95_latency_ms: latencySummary(bucketEvents).p95
            })),
            by_model: [...modelGroups.entries()]
                .map(([model, modelEvents]) => {
                    const modelSuccess = modelEvents.filter((event) => event.outcome === 'success').length;
                    const modelFailed = modelEvents.filter((event) => event.outcome === 'failure').length;
                    const modelMeasured = modelSuccess + modelFailed;
                    return {
                        model,
                        requests: modelEvents.length,
                        success: modelSuccess,
                        failed: modelFailed,
                        canceled: modelEvents.filter((event) => event.outcome === 'canceled').length,
                        success_rate: modelMeasured
                            ? Number(((modelSuccess / modelMeasured) * 100).toFixed(1))
                            : null,
                        p95_latency_ms: latencySummary(modelEvents).p95,
                        usage: usageSummary(modelEvents)
                    };
                })
                .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
            by_error: [...errorGroups.entries()]
                .map(([type, count]) => ({ type, count }))
                .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
            // Newest first, every outcome — the token columns are only meaningful
            // next to the request that produced them.
            recent_requests: events
                .slice(-25)
                .reverse()
                .map(({ timestamp_ms, ...event }) => event),
            recent_failures: events
                .filter((event) => event.outcome !== 'success')
                .slice(-20)
                .reverse()
                .map(({ timestamp_ms, ...event }) => event),
            privacy: {
                storage: 'memory_only',
                collects: [
                    'request_id', 'route', 'method', 'model', 'stream', 'outcome', 'status',
                    'error_type', 'duration_ms', 'timestamp',
                    'input_tokens', 'output_tokens', 'cached_tokens', 'cost_credits',
                    'tokens_estimated'
                ],
                // Token *counts* are collected; credentials and content are not.
                excludes: ['prompt', 'system', 'messages', 'tools', 'headers', 'auth_tokens', 'response_body']
            }
        };
    }
}

export const requestTelemetry = new RequestTelemetry();

export default requestTelemetry;
