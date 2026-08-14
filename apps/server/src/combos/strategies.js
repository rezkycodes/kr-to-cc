/**
 * Combo strategies.
 *
 * Each strategy turns a combo's member list into an attempt order, then a shared
 * runner walks that order. The strategies differ only in ordering and in whether
 * they run members concurrently, which keeps the failure handling in one place.
 *
 * ## The streaming constraint
 *
 * Once the first event has been handed to the client, the response has begun:
 * `message_start` is out, and a different model cannot take over without the
 * client seeing two conflicting messages. So a member may only be replaced
 * *before* it produces its first event. A failure after that is reported as a
 * failure — not papered over by silently restarting on another model, which would
 * duplicate content the client already has.
 *
 * This is why `runStream` buffers nothing and switches only on a pre-first-event
 * error: correctness over apparent resilience.
 */

import { logger } from '../utils/logger.js';

/**
 * Errors worth trying another member for.
 *
 * Quota and transient upstream faults are the point of a combo. A malformed
 * request is not: every member would reject it identically, so retrying wastes
 * quota and delays the error the caller needs to see.
 */
const RETRYABLE_PATTERNS = [
    /quota/i,
    /rate.?limit/i,
    /\b429\b/,
    // Kiro reports a spent allowance as 402 "You have reached the limit", which is
    // exactly the case a combo should move past.
    /\b402\b/,
    /reached the limit/i,
    /limit reached/i,
    /exhausted/i,
    /\b50[0234]\b/,
    /unavailable/i,
    /timeout/i,
    /capacity/i,
    /high traffic/i,
    // A 400 from one member says nothing about the next when members sit on
    // different providers. A retired Gemini id, a schema its backend will not
    // accept, or a model pulled from a plan all surface as a bare 400 — and
    // aborting the combo over it wasted four healthy members. Each member is still
    // tried at most once, so the cost is bounded; if the request really is
    // malformed every member rejects it and the last error is surfaced.
    /\b400\b/,
    /invalid.?argument/i,
    /overloaded/i,
    /not signed in/i,
    /not authenticated/i,
    /token refresh failed/i
];

/**
 * Whether a failure justifies moving to the next member.
 * @param {Error} error
 * @returns {boolean}
 */
export function isRetryable(error) {
    const message = String(error?.message || '');

    // Final only where the next member genuinely cannot do better: a mapping
    // mistake, or a body no backend could parse.
    //
    // A bare `400` used to be listed here on the assumption that every member
    // would reject it identically. That assumption is wrong once members span
    // providers — a retired Gemini id and a schema Gemini alone refuses both
    // arrive as a plain 400, and treating them as final threw away four healthy
    // members. The cost of being wrong the other way is bounded: each member is
    // tried at most once, and if the request really is bad the last error surfaces.
    if (/malformed|does not serve model/i.test(message)) return false;

    return RETRYABLE_PATTERNS.some((re) => re.test(message));
}

/** Round-robin cursor per combo, so load-balance actually rotates. */
const cursors = new Map();

/** Recently failed members, so load-balance skips them briefly. */
const coolingOff = new Map();
const COOL_OFF_MS = 30_000;

function markFailed(key) {
    coolingOff.set(key, Date.now() + COOL_OFF_MS);
}

function isCoolingOff(key) {
    const until = coolingOff.get(key);
    if (!until) return false;
    if (until <= Date.now()) {
        coolingOff.delete(key);
        return false;
    }
    return true;
}

/** Stable key for a member. */
function memberKey(combo, target) {
    return `${combo.name}:${target.provider.id}/${target.modelId}`;
}

/**
 * Classify a request to pick a member, for the `router` strategy.
 *
 * A deliberately simple heuristic over request shape — there is no model call
 * here, because paying for a classification before every request would defeat the
 * point. It reads three signals:
 *
 *   - tools present        => agentic work, prefer a stronger member
 *   - large prompt         => needs context headroom
 *   - short, no tools      => cheap member is fine
 *
 * "Stronger" means later in the member list. The ordering convention is the
 * user's: members are listed cheapest-first, and the router reaches further down
 * for harder work. That is a convention, not something we can detect, so it is
 * documented in the UI.
 *
 * @param {object} request Anthropic Messages request
 * @returns {'light'|'standard'|'heavy'}
 */
export function classifyRequest(request) {
    const hasTools = Array.isArray(request?.tools) && request.tools.length > 0;

    let characters = 0;
    for (const message of request?.messages || []) {
        const content = message?.content;
        characters += typeof content === 'string' ? content.length : JSON.stringify(content || '').length;
    }
    if (typeof request?.system === 'string') characters += request.system.length;

    if (hasTools || characters > 24_000) return 'heavy';
    if (characters > 2_000) return 'standard';
    return 'light';
}

/**
 * Attempt order for a combo.
 *
 * @param {object} combo
 * @param {{provider: object, modelId: string}[]} plan resolved members, in listed order
 * @param {object} request
 * @returns {{order: object[], concurrent: boolean}}
 */
export function planAttempts(combo, plan, request) {
    switch (combo.strategy) {
        case 'failover':
            // Listed order is the user's preference order.
            return { order: plan, concurrent: false };

        case 'load-balance': {
            const healthy = plan.filter((t) => !isCoolingOff(memberKey(combo, t)));
            // If everything is cooling off, ignore the cooldown rather than fail:
            // a stale cooldown must not take the combo down entirely.
            const pool = healthy.length > 0 ? healthy : plan;
            const cursor = cursors.get(combo.name) ?? 0;
            cursors.set(combo.name, cursor + 1);
            const start = cursor % pool.length;
            // Rotate so the chosen member is first, and the rest remain as
            // fallbacks: balancing should not mean failing when one member is down.
            const rotated = [...pool.slice(start), ...pool.slice(0, start)];
            return { order: rotated, concurrent: false };
        }

        case 'router': {
            const weight = classifyRequest(request);
            // Members are listed cheapest-first by convention.
            const index = weight === 'heavy'
                ? plan.length - 1
                : weight === 'standard'
                    ? Math.floor((plan.length - 1) / 2)
                    : 0;
            const chosen = plan[index];
            const rest = plan.filter((t) => t !== chosen);
            return { order: [chosen, ...rest], concurrent: false };
        }

        case 'race':
            return { order: plan, concurrent: true };

        default:
            return { order: plan, concurrent: false };
    }
}

/**
 * Run a non-streaming request through a combo.
 *
 * @param {object} combo
 * @param {{provider: object, modelId: string}[]} plan
 * @param {object} request
 * @param {(target: object) => Promise<object>} attempt
 * @returns {Promise<{result: object, target: object}>}
 */
export async function runOnce(combo, plan, request, attempt) {
    const { order, concurrent } = planAttempts(combo, plan, request);

    if (concurrent) return raceOnce(combo, order, attempt);

    const failures = [];
    for (const target of order) {
        try {
            const result = await attempt(target);
            return { result, target };
        } catch (error) {
            failures.push(`${target.provider.id}/${target.modelId}: ${error.message}`);
            markFailed(memberKey(combo, target));
            if (!isRetryable(error)) throw error;
            logger.warn?.(`[Combo ${combo.name}] ${target.provider.id}/${target.modelId} failed, trying next`);
        }
    }

    throw new Error(`Combo "${combo.name}" exhausted every member. ${failures.join(' | ')}`);
}

/**
 * Race members, keep the first success, abort the rest.
 *
 * Spends quota on every member for one answer, which is the documented tradeoff.
 * Losers are aborted as soon as a winner appears so the waste is bounded by the
 * winner's latency rather than the slowest member's.
 */
async function raceOnce(combo, order, attempt) {
    const controllers = order.map(() => new AbortController());

    // Each entry resolves to a tagged outcome and removes itself when settled, so
    // the pending set shrinks without having to identify promises by value.
    const pending = new Map();
    order.forEach((target, index) => {
        const promise = attempt(target, controllers[index].signal).then(
            (result) => ({ ok: true, result, target, index }),
            (error) => ({ ok: false, error, target, index })
        );
        pending.set(index, promise);
    });

    const failures = [];

    while (pending.size > 0) {
        const outcome = await Promise.race(pending.values());
        pending.delete(outcome.index);

        if (outcome.ok) {
            controllers.forEach((controller, index) => {
                if (index !== outcome.index) controller.abort();
            });
            return { result: outcome.result, target: outcome.target };
        }

        failures.push(`${outcome.target.provider.id}/${outcome.target.modelId}: ${outcome.error.message}`);
        markFailed(memberKey(combo, outcome.target));
    }

    throw new Error(`Combo "${combo.name}" exhausted every member. ${failures.join(' | ')}`);
}

/**
 * Run a streaming request through a combo.
 *
 * Yields `{event, target}` so the caller can attribute the response. A member is
 * replaced only if it fails before its first event; see the note at the top of
 * this file for why.
 *
 * @param {object} combo
 * @param {{provider: object, modelId: string}[]} plan
 * @param {object} request
 * @param {(target: object) => AsyncGenerator<object>} attempt
 * @returns {AsyncGenerator<{event: object, target: object}>}
 */
export async function* runStream(combo, plan, request, attempt) {
    // Racing streams would mean committing to one before knowing which is
    // fastest, so a raced combo streams from its first-listed member instead.
    const { order } = planAttempts(combo, plan, request);
    const failures = [];

    for (const target of order) {
        let produced = false;
        try {
            for await (const event of attempt(target)) {
                produced = true;
                yield { event, target };
            }
            return;
        } catch (error) {
            if (produced) {
                // Past the point of no return: the client already has part of a
                // message from this member. Surface the truth.
                throw new Error(
                    `Combo "${combo.name}" member ${target.provider.id}/${target.modelId} failed mid-stream: ${error.message}`
                );
            }
            failures.push(`${target.provider.id}/${target.modelId}: ${error.message}`);
            markFailed(memberKey(combo, target));
            if (!isRetryable(error)) throw error;
            logger.warn?.(`[Combo ${combo.name}] ${target.provider.id}/${target.modelId} failed before first event, trying next`);
        }
    }

    throw new Error(`Combo "${combo.name}" exhausted every member. ${failures.join(' | ')}`);
}

/** Reset rotation and cooldown state. Used by tests. */
export function resetState() {
    cursors.clear();
    coolingOff.clear();
}

export default {
    isRetryable,
    classifyRequest,
    planAttempts,
    runOnce,
    runStream,
    resetState
};
