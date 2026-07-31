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
            stream: metadata.stream === true
        });
        this.emit({ type: 'start' });
        return requestId;
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
            duration_ms: Math.max(0, Math.round(now - active.started_at_ms))
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
                        p95_latency_ms: latencySummary(modelEvents).p95
                    };
                })
                .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
            by_error: [...errorGroups.entries()]
                .map(([type, count]) => ({ type, count }))
                .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
            recent_failures: events
                .filter((event) => event.outcome !== 'success')
                .slice(-20)
                .reverse()
                .map(({ timestamp_ms, ...event }) => event),
            privacy: {
                storage: 'memory_only',
                collects: ['request_id', 'route', 'method', 'model', 'stream', 'outcome', 'status', 'error_type', 'duration_ms', 'timestamp'],
                excludes: ['prompt', 'system', 'messages', 'tools', 'headers', 'tokens', 'response_body']
            }
        };
    }
}

export const requestTelemetry = new RequestTelemetry();

export default requestTelemetry;
