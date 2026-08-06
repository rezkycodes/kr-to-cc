/**
 * Google (Antigravity) browser sign-in.
 *
 * Standard OAuth authorization-code flow against the Antigravity desktop client.
 * The redirect lands on this server, so no separate callback listener is needed —
 * and because a popup cannot always reach back (different browser profile, remote
 * host, popup blocked), the same code can be completed by pasting the callback URL.
 *
 * `access_type=offline` and `prompt=consent` are both required: without them
 * Google returns no refresh token on a repeat authorisation, and an account that
 * cannot refresh is useless to a long-running proxy.
 */

import crypto from 'crypto';

import {
    GOOGLE_OAUTH,
    GOOGLE_OAUTH_CLIENT,
    ANTIGRAVITY_USER_AGENT
} from '../providers/google/constants.js';
import { loadCodeAssist } from '../providers/google/project.js';
import { saveConnection } from './store.js';
import { logger } from '../utils/logger.js';

/**
 * Pending authorisations, keyed by state.
 *
 * In memory only: an interrupted sign-in should not leave anything on disk, and a
 * restart legitimately invalidates a half-finished flow.
 */
const pending = new Map();

/** How long a started sign-in stays valid. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** Cap the map so a stream of abandoned sign-ins cannot grow it without bound. */
const MAX_PENDING = 16;

function prunePending() {
    const now = Date.now();
    for (const [state, entry] of pending) {
        if (entry.expiresAt <= now) pending.delete(state);
    }
    while (pending.size > MAX_PENDING) {
        // Oldest first: Map preserves insertion order.
        pending.delete(pending.keys().next().value);
    }
}

/**
 * Begin a sign-in.
 *
 * @param {string} redirectUri must match what the callback route serves
 * @returns {{authUrl: string, state: string}}
 */
export function startAuthorization(redirectUri) {
    prunePending();
    const state = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: GOOGLE_OAUTH.scopes.join(' '),
        state,
        // Both are load-bearing; see the note at the top of this file.
        access_type: 'offline',
        prompt: 'consent'
    });

    pending.set(state, { redirectUri, expiresAt: Date.now() + PENDING_TTL_MS });

    return { authUrl: `${GOOGLE_OAUTH.authorizeUrl}?${params.toString()}`, state };
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param {string} code
 * @param {string} redirectUri must be identical to the one used to get the code
 * @returns {Promise<object>} raw token response
 */
async function exchangeCode(code, redirectUri) {
    const response = await fetch(GOOGLE_OAUTH.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: GOOGLE_OAUTH_CLIENT.clientId,
            client_secret: GOOGLE_OAUTH_CLIENT.clientSecret,
            code,
            redirect_uri: redirectUri
        })
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        // redirect_uri_mismatch is the common mistake and worth naming.
        const hint = detail.includes('redirect_uri_mismatch')
            ? ' The redirect URI did not match the one the sign-in started with.'
            : '';
        throw new Error(`Google rejected the authorization code (HTTP ${response.status}).${hint}`);
    }

    return response.json();
}

/**
 * Read the account's email from the access token.
 *
 * Used to label the connection and to recognise a repeat sign-in as the same
 * account rather than a new one.
 *
 * @param {string} accessToken
 * @returns {Promise<string|null>}
 */
async function fetchEmail(accessToken) {
    try {
        const response = await fetch(`${GOOGLE_OAUTH.userInfoUrl}?alt=json`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'User-Agent': ANTIGRAVITY_USER_AGENT,
                'x-request-source': 'local'
            }
        });
        if (!response.ok) return null;
        const info = await response.json();
        return info.email || null;
    } catch {
        // A missing email costs a nice label, not the sign-in.
        return null;
    }
}

/**
 * Extract `code` and `state` from a pasted callback URL.
 *
 * Accepts a full URL or a bare query string, since what a user copies out of the
 * address bar varies.
 *
 * @param {string} pasted
 * @returns {{code: string, state: string|null}}
 * @throws {Error} when no code is present
 */
export function parseCallback(pasted) {
    const text = String(pasted || '').trim();
    if (!text) throw new Error('Paste the URL your browser landed on after approving access.');

    let params;
    try {
        params = new URL(text).searchParams;
    } catch {
        params = new URLSearchParams(text.replace(/^[^?]*\?/, ''));
    }

    const error = params.get('error');
    if (error) {
        throw new Error(`Google reported "${error}". Approve access and try again.`);
    }

    const code = params.get('code');
    if (!code) {
        throw new Error('That URL has no authorization code. Copy the full address after approving access.');
    }

    return { code, state: params.get('state') };
}

/**
 * Complete a sign-in and store the account.
 *
 * @param {{code: string, state?: string|null, redirectUri?: string}} input
 * @returns {Promise<object>} the stored connection
 */
export async function completeAuthorization(input) {
    prunePending();

    const entry = input.state ? pending.get(input.state) : null;
    // A pasted callback may arrive after a restart, so fall back to the caller's
    // redirect URI rather than refusing a sign-in that is otherwise fine.
    const redirectUri = entry?.redirectUri || input.redirectUri;
    if (!redirectUri) {
        throw new Error('This sign-in expired. Start it again.');
    }
    if (input.state) pending.delete(input.state);

    const tokens = await exchangeCode(input.code, redirectUri);
    if (!tokens.refresh_token) {
        // Without this the account works for an hour and then dies silently.
        throw new Error(
            'Google returned no refresh token. Remove this app from your Google account permissions, then sign in again.'
        );
    }

    const email = await fetchEmail(tokens.access_token);

    // Resolve the Code Assist project now so a first request does not have to.
    let projectId = null;
    try {
        ({ projectId } = await loadCodeAssist(tokens.access_token));
    } catch (error) {
        logger.warn?.(`[Google] Signed in but could not resolve a project: ${error.message}`);
    }

    const connection = saveConnection({
        provider: 'google',
        authType: 'oauth',
        email,
        credentials: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
            projectId
        }
    });

    logger.info(`[Google] Connected account ${email || connection.id}`);
    return connection;
}

/** How many sign-ins are waiting. Used by tests. */
export function pendingCount() {
    prunePending();
    return pending.size;
}

/** Drop pending sign-ins. Used by tests. */
export function resetPending() {
    pending.clear();
}

export default {
    startAuthorization,
    completeAuthorization,
    parseCallback,
    pendingCount,
    resetPending
};
