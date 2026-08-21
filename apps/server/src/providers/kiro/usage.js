/**
 * Kiro usage and quota.
 *
 * Kiro meters an account in **credits**, not per model: one monthly allowance is
 * shared by every model, and each model draws from it at its own multiplier (see
 * `cost_multiplier` in the catalog). So there is no such thing as a per-model
 * remaining figure here — a caller asking for one has to be told the truth.
 *
 * Google is the opposite: its quota really is per model. Anything presenting both
 * providers side by side has to keep that difference visible rather than
 * flattening it.
 *
 * The endpoint is AWS Coral-style: a POST to the service root with an
 * `x-amz-target` header. A plain REST POST to `/getUsageLimits` answers HTTP 200
 * with `UnknownOperationException`, which is easy to mistake for success.
 *
 * Adapted from 9router (MIT, © 2024-2026 decolua and contributors).
 */

import { getKiroAuthData } from '../../auth/kiro-token-extractor.js';
import { KIRO_HEADERS, KIRO_DEFAULT_PROFILE_ARNS, buildAmzSdkHeaders } from '../../constants.js';
import { resolveDefaultProfileArn } from './request-builder.js';
import { logger } from '../../utils/logger.js';

const CODEWHISPERER_HOST = 'https://codewhisperer.us-east-1.amazonaws.com';
const Q_HOST = 'https://q.us-east-1.amazonaws.com';
const LIMITS_PATH = '/getUsageLimits';

/** The Coral operation name. Without this header the service does not route. */
const TARGET = 'AmazonCodeWhispererService.GetUsageLimits';

/** Interpret the reset timestamp, which arrives as epoch seconds. */
function parseReset(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    // Guard against a value already in milliseconds.
    const ms = seconds > 1e11 ? seconds : seconds * 1000;
    return new Date(ms).toISOString();
}

/**
 * Turn one usage breakdown into a quota figure.
 * @param {object} breakdown
 * @param {string|null} fallbackReset
 */
function toQuota(breakdown, fallbackReset) {
    const used = Number(breakdown.currentUsageWithPrecision ?? breakdown.currentUsage ?? 0) || 0;
    const total = Number(breakdown.usageLimitWithPrecision ?? breakdown.usageLimit ?? 0) || 0;
    return {
        resource: String(breakdown.resourceType || 'unknown').toLowerCase(),
        label: breakdown.displayNamePlural || breakdown.displayName || breakdown.resourceType || 'usage',
        unit: breakdown.unit || null,
        used,
        total,
        remaining: total > 0 ? Math.max(0, total - used) : null,
        // Null rather than 0 when there is no limit to divide by, so the UI can
        // tell "nothing left" apart from "no limit reported".
        remainingFraction: total > 0 ? Math.max(0, 1 - used / total) : null,
        resetAt: parseReset(breakdown.nextDateReset) || fallbackReset
    };
}

/**
 * Fetch the account's real usage limits.
 *
 * @returns {Promise<{plan: string|null, quotas: object[], resetAt: string|null, error?: string}>}
 */
export async function getKiroUsageLimits() {
    let auth;
    try {
        auth = await getKiroAuthData();
    } catch (error) {
        return { plan: null, quotas: [], resetAt: null, error: `Not authenticated: ${error.message}` };
    }

    if (!auth?.accessToken) {
        return { plan: null, quotas: [], resetAt: null, error: 'Not authenticated.' };
    }

    const profileArn = auth.profileArn || resolveDefaultProfileArn(auth.authKey);
    const body = JSON.stringify({
        origin: 'AI_EDITOR',
        profileArn,
        resourceType: 'AGENTIC_REQUEST'
    });

    // The Coral POST is the form that actually works; the REST variants are kept
    // as fallbacks because which one answers has changed before.
    const attempts = [
        {
            name: 'codewhisperer-coral',
            url: CODEWHISPERER_HOST,
            init: {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${auth.accessToken}`,
                    'Content-Type': 'application/x-amz-json-1.0',
                    'x-amz-target': TARGET,
                    Accept: 'application/json',
                    ...KIRO_HEADERS,
                    ...buildAmzSdkHeaders()
                },
                body
            }
        },
        {
            name: 'q-rest',
            url: `${Q_HOST}${LIMITS_PATH}?${new URLSearchParams({
                origin: 'AI_EDITOR',
                profileArn,
                resourceType: 'AGENTIC_REQUEST'
            })}`,
            init: {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${auth.accessToken}`,
                    Accept: 'application/json',
                    ...KIRO_HEADERS,
                    ...buildAmzSdkHeaders()
                }
            }
        }
    ];

    const failures = [];

    for (const attempt of attempts) {
        try {
            const response = await fetch(attempt.url, {
                ...attempt.init,
                signal: AbortSignal.timeout(15_000)
            });
            const text = await response.text();

            // A 200 carrying an exception envelope is a failure, not a result.
            if (!response.ok || text.includes('Exception')) {
                failures.push(`${attempt.name}: HTTP ${response.status}`);
                continue;
            }

            const data = JSON.parse(text);
            const resetAt = parseReset(data.nextDateReset ?? data.resetDate);
            const quotas = [];

            for (const breakdown of data.usageBreakdownList || []) {
                quotas.push(toQuota(breakdown, resetAt));

                // A free trial is a separate allowance, so it gets its own row
                // rather than being folded into the paid one.
                const trial = breakdown.freeTrialInfo;
                if (trial) {
                    const used = Number(trial.currentUsageWithPrecision ?? 0) || 0;
                    const total = Number(trial.usageLimitWithPrecision ?? 0) || 0;
                    quotas.push({
                        resource: `${String(breakdown.resourceType || 'unknown').toLowerCase()}_free_trial`,
                        label: 'Free trial',
                        unit: breakdown.unit || null,
                        used,
                        total,
                        remaining: total > 0 ? Math.max(0, total - used) : null,
                        remainingFraction: total > 0 ? Math.max(0, 1 - used / total) : null,
                        resetAt: parseReset(trial.freeTrialExpiry) || resetAt
                    });
                }
            }

            return {
                plan: data.subscriptionInfo?.subscriptionTitle || null,
                quotas,
                resetAt,
                daysUntilReset: Number.isFinite(data.daysUntilReset) ? data.daysUntilReset : null,
                // Account-level, not per model. Stated so callers cannot mistake it.
                scope: 'account'
            };
        } catch (error) {
            failures.push(`${attempt.name}: ${error.message}`);
        }
    }

    logger.debug?.(`[Kiro] Usage limits unavailable: ${failures.join(' | ')}`);
    return {
        plan: null,
        quotas: [],
        resetAt: null,
        scope: 'account',
        error: `Could not read Kiro usage. ${failures.join(' | ')}`
    };
}

export default { getKiroUsageLimits };
