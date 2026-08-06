/**
 * Google/Antigravity usage and quota.
 *
 * Google meters **per model**, unlike Kiro which meters an account in shared
 * credits. But quota is still held **per account**: two signed-in accounts have
 * two independent sets of per-model allowances. So this reports a per-model map
 * for each account rather than one map for the provider — picking whichever
 * account rotation happened to choose would describe one account and misstate
 * the others.
 *
 * The figures come from `fetchAvailableModels`, which is also the quota endpoint
 * (there is no separate one for Antigravity; `retrieveUserQuota` is Gemini CLI).
 *
 * Adapted from 9router (MIT, © 2024-2026 decolua and contributors).
 */

import { listConnections } from '../../connections/store.js';
import { logger } from '../../utils/logger.js';
import { CLIENT_METADATA, endpoints } from './constants.js';
import { refreshConnection } from './credentials.js';
import { fetchAvailableModels } from './models.js';

/** Interpret Google's reset timestamp, which may be RFC3339 or a duration. */
function parseReset(value) {
    if (!value) return null;
    // A plain ISO timestamp.
    const asDate = new Date(value);
    if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();

    // Otherwise a duration like "2h7m23s" from now.
    const match = String(value).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
    if (!match || !match.slice(1).some(Boolean)) return null;
    const ms =
        (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
    return ms > 0 ? new Date(Date.now() + ms).toISOString() : null;
}

/**
 * The account's plan name.
 *
 * Antigravity returns `allowedTiers` but often no `currentTier`, so the default
 * allowed tier is used. Reported as null rather than guessed when absent.
 */
async function fetchTier(accessToken) {
    try {
        const response = await fetch(endpoints.loadCodeAssist(), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ metadata: CLIENT_METADATA }),
            signal: AbortSignal.timeout(15_000)
        });
        if (!response.ok) return null;

        const data = await response.json();
        if (data.currentTier?.name) return data.currentTier.name;
        const preferred =
            (data.allowedTiers || []).find((tier) => tier.isDefault) || (data.allowedTiers || [])[0];
        return preferred?.name || null;
    } catch {
        return null;
    }
}

/**
 * Per-model quota for every signed-in Google account.
 *
 * Never throws — quota is decoration and must not be able to fail a request. A
 * per-account error is reported on that account instead.
 *
 * @returns {Promise<Array<{connectionId: string, label: string, plan: string|null,
 *   models: Record<string, {remainingFraction: number, resetAt: string|null}>,
 *   error: string|null}>>}
 */
export async function getGoogleAccountQuotas() {
    const accounts = [];

    for (const connection of listConnections('google')) {
        const entry = {
            connectionId: connection.id,
            label: connection.email || connection.label,
            plan: null,
            models: {},
            error: null
        };

        try {
            const ready = await refreshConnection(connection);
            const { accessToken, projectId } = ready.credentials;

            entry.plan = await fetchTier(accessToken);

            // `models` is already normalised into an array here, with quota flattened
            // onto each entry — not the raw id-keyed map the API returns.
            const { models } = await fetchAvailableModels(accessToken, projectId);
            for (const model of models || []) {
                if (model.quotaRemaining == null) continue;
                entry.models[model.id] = {
                    remainingFraction: model.quotaRemaining,
                    resetAt: parseReset(model.quotaResetAt)
                };
            }
        } catch (error) {
            // A revoked login lands here. Surfaced, not hidden — the account still
            // appears in the list with the reason it cannot report.
            entry.error = error.message;
            logger.debug?.(`[Google] Quota unavailable for ${entry.label}: ${error.message}`);
        }

        accounts.push(entry);
    }

    return accounts;
}

export default { getGoogleAccountQuotas };
