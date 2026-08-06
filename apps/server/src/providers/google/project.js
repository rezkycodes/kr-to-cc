/**
 * Google Code Assist project provisioning.
 *
 * Generation requests must name a `cloudaicompanionProject`. Discovering it takes
 * two calls: `loadCodeAssist` reports the project and the account's tier, and
 * `onboardUser` provisions one when the account has never used Code Assist. The
 * result is cached for the process — it does not change between requests.
 *
 * Adapted from 9router (MIT, © 2024-2026 decolua and contributors).
 */

import {
    ANTIGRAVITY_USER_AGENT,
    CLIENT_METADATA,
    endpoints
} from './constants.js';
import { logger } from '../../utils/logger.js';

/**
 * Headers for the discovery calls.
 *
 * Deliberately minimal. The real IDE does not send `X-Goog-Api-Client` or
 * `Client-Metadata` here, and Google fingerprints those: include them and the
 * backend silently declines to provision a project, returning success with an
 * empty result. That failure looks like an account problem, so it is worth being
 * explicit about not adding headers to this request.
 *
 * @param {string} accessToken
 */
function discoveryHeaders(accessToken) {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': ANTIGRAVITY_USER_AGENT,
        'x-request-source': 'local'
    };
}

/** Cached project id, keyed by nothing — one account per process. */
let cachedProject = null;

/**
 * Ask Code Assist which project this account uses.
 *
 * @param {string} accessToken
 * @returns {Promise<{projectId: string, tierId: string}>}
 */
export async function loadCodeAssist(accessToken) {
    const response = await fetch(endpoints.loadCodeAssist(), {
        method: 'POST',
        headers: discoveryHeaders(accessToken),
        body: JSON.stringify({ metadata: CLIENT_METADATA })
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`loadCodeAssist failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const data = await response.json();
    // The field is sometimes an object with an id, sometimes the id itself.
    const project = data.cloudaicompanionProject;
    const projectId = (typeof project === 'string' ? project : project?.id) || '';

    let tierId = 'legacy-tier';
    for (const tier of data.allowedTiers || []) {
        if (tier.isDefault && tier.id) {
            tierId = String(tier.id).trim();
            break;
        }
    }

    return { projectId, tierId };
}

/**
 * Provision Code Assist for an account that has none.
 *
 * Long-running on Google's side, so it is polled. Returns the project id once
 * onboarding reports done, or null if it never does.
 *
 * @param {string} accessToken
 * @param {string} tierId
 * @param {{attempts?: number, delayMs?: number}} [options]
 * @returns {Promise<string|null>}
 */
export async function onboardUser(accessToken, tierId, options = {}) {
    const attempts = options.attempts ?? 6;
    const delayMs = options.delayMs ?? 3000;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const response = await fetch(endpoints.onboardUser(), {
            method: 'POST',
            headers: discoveryHeaders(accessToken),
            body: JSON.stringify({ tierId, metadata: CLIENT_METADATA })
        });

        if (response.ok) {
            const result = await response.json();
            if (result.done === true) {
                const project = result.response?.cloudaicompanionProject;
                return (typeof project === 'string' ? project : project?.id) || null;
            }
        }

        if (attempt < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    return null;
}

/**
 * The project id to send with generation requests.
 *
 * Cached after the first success. Onboarding only runs when loadCodeAssist
 * reports no project, which is the first-use case.
 *
 * @param {string} accessToken
 * @returns {Promise<string>}
 * @throws {Error} when no project could be obtained
 */
export async function ensureProject(accessToken) {
    if (cachedProject) return cachedProject;

    const { projectId, tierId } = await loadCodeAssist(accessToken);
    if (projectId) {
        cachedProject = projectId;
        logger.info('[Google] Code Assist project resolved');
        return cachedProject;
    }

    logger.info(`[Google] No Code Assist project yet; onboarding on tier ${tierId}`);
    const onboarded = await onboardUser(accessToken, tierId);
    if (!onboarded) {
        throw new Error(
            'Google Code Assist has no project for this account and onboarding did not complete. '
            + 'Open Antigravity once to finish setup, then retry.'
        );
    }

    cachedProject = onboarded;
    return cachedProject;
}

/** Drop the cached project. Used by tests and after switching accounts. */
export function clearProjectCache() {
    cachedProject = null;
}

export default { loadCodeAssist, onboardUser, ensureProject, clearProjectCache };
