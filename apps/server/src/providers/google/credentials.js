/**
 * Google (Antigravity) credentials, across several accounts.
 *
 * Each signed-in account is a connection with its own quota. Requests rotate
 * between them, which is the whole point of supporting more than one: on a free
 * tier, four accounts is four times the ceiling.
 *
 * Accounts already present on the machine (Antigravity CLI) are imported once
 * so an existing setup keeps working without signing in again. Additional
 * Google accounts are added through the browser sign-in flow
 * (connections/google-oauth.js), which mints tokens for the same Antigravity
 * OAuth client and therefore refresh reliably.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { GOOGLE_OAUTH, GOOGLE_OAUTH_CLIENT, TOKEN_REFRESH_LEAD_MS } from './constants.js';
import {
    listConnections,
    listUsableConnections,
    saveConnection,
    updateConnection,
    markConnectionFailed
} from '../../connections/store.js';
import { logger } from '../../utils/logger.js';

/**
 * Accounts a vendor CLI may already have on this machine.
 *
 * The Antigravity CLI nests its token under `token`; the Gemini CLI stores the
 * OAuth response flat. Both are the same kind of credential.
 */
const LOCAL_SOURCES = [
    {
        id: 'antigravity-cli',
        label: 'Antigravity CLI',
        file: () => path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
        parse: (raw) => {
            const token = JSON.parse(raw)?.token || {};
            return {
                accessToken: token.access_token,
                refreshToken: token.refresh_token,
                // This one serialises RFC 3339 rather than epoch milliseconds.
                expiresAt: token.expiry ? Date.parse(token.expiry) : null
            };
        }
    }
];

/** Read a local credential without throwing. */
function readLocalSource(source) {
    try {
        const file = source.file();
        if (!fs.existsSync(file)) return null;
        const parsed = source.parse(fs.readFileSync(file, 'utf8'));
        // An expired access token is recoverable; a missing refresh token is not.
        return parsed.refreshToken ? parsed : null;
    } catch (error) {
        logger.debug?.(`[Google] Could not read ${source.label}: ${error.message}`);
        return null;
    }
}

/** Local accounts discoverable on this machine, for the UI to offer importing. */
export function discoverCredentialSources() {
    return LOCAL_SOURCES.map((source) => {
        const found = readLocalSource(source);
        return {
            id: source.id,
            label: source.label,
            present: found !== null,
            expired: found?.expiresAt ? found.expiresAt <= Date.now() : null
        };
    });
}

/** Runs at most once per process. */
let importAttempted = false;

/**
 * Import CLI accounts as connections, once, if there are none yet.
 *
 * Deliberately only when the store is empty: re-importing on every start would
 * resurrect accounts the user deliberately deleted.
 *
 * @returns {number} how many were imported
 */
export function importLocalCredentials() {
    if (importAttempted) return 0;
    importAttempted = true;

    if (listConnections('google').length > 0) return 0;

    let imported = 0;
    for (const source of LOCAL_SOURCES) {
        const found = readLocalSource(source);
        if (!found) continue;
        try {
            saveConnection({
                provider: 'google',
                authType: 'imported',
                // The email is unknown until the token is used; the source names it
                // well enough to tell accounts apart in the meantime.
                label: source.label,
                credentials: found
            });
            imported += 1;
        } catch (error) {
            logger.debug?.(`[Google] Could not import ${source.label}: ${error.message}`);
        }
    }

    if (imported > 0) {
        logger.info(`[Google] Imported ${imported} existing account(s) from local CLIs`);
    }
    return imported;
}

/** Round-robin cursor and how many requests the current pick has served. */
let cursor = 0;
let stickyRemaining = 0;
let stickyConnectionId = null;

/**
 * How many consecutive requests one account serves before rotating.
 *
 * Rotating on literally every request would defeat prompt caching upstream, which
 * is keyed per account. A small run keeps caching useful while still spreading
 * load.
 */
const STICKY_REQUESTS = Math.max(
    1,
    Number.parseInt(process.env.GOOGLE_STICKY_REQUESTS || '1', 10) || 1
);

/**
 * Choose the account to serve the next request.
 *
 * @returns {object} a usable connection
 * @throws {Error} when no account can serve
 */
export function selectConnection() {
    importLocalCredentials();

    const usable = listUsableConnections('google');
    if (usable.length === 0) {
        const total = listConnections('google').length;
        throw new Error(
            total === 0
                ? 'No Google account connected. Add one on the Providers page.'
                : `All ${total} Google account(s) are disabled or rate-limited. Check the Providers page.`
        );
    }

    // Stay on the current account while its run lasts, provided it is still usable.
    if (stickyRemaining > 0 && stickyConnectionId) {
        const current = usable.find((c) => c.id === stickyConnectionId);
        if (current) {
            stickyRemaining -= 1;
            return current;
        }
    }

    const chosen = usable[cursor % usable.length];
    cursor = (cursor + 1) % usable.length;
    stickyConnectionId = chosen.id;
    stickyRemaining = STICKY_REQUESTS - 1;
    return chosen;
}

/** De-duplicates concurrent refreshes per connection. */
const refreshInFlight = new Map();

/**
 * Exchange a refresh token for a fresh access token.
 *
 * @param {string} refreshToken
 * @returns {Promise<{accessToken: string, expiresAt: number}>}
 */
async function requestRefresh(refreshToken) {
    const response = await fetch(GOOGLE_OAUTH.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: GOOGLE_OAUTH_CLIENT.clientId,
            client_secret: GOOGLE_OAUTH_CLIENT.clientSecret
        })
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        // invalid_grant means the user revoked access; no amount of retrying helps.
        const reason = detail.includes('invalid_grant')
            ? 'the Google login was revoked or expired'
            : `HTTP ${response.status}`;
        throw new Error(`Token refresh failed: ${reason}. Sign in to this account again.`);
    }

    const payload = await response.json();
    if (!payload.access_token) throw new Error('Token refresh returned no access token.');

    return {
        accessToken: payload.access_token,
        expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000
    };
}

/**
 * A valid access token for one connection, refreshing when needed.
 *
 * Concurrent callers on the same account share one refresh: without that, a burst
 * of requests on a stale token would each start their own, and Google rate-limits
 * the token endpoint.
 *
 * @param {object} connection
 * @returns {Promise<object>} the connection with a usable access token
 */
export async function refreshConnection(connection) {
    const creds = connection.credentials || {};
    const stillFresh = creds.accessToken
        && Number.isFinite(creds.expiresAt)
        && creds.expiresAt - TOKEN_REFRESH_LEAD_MS > Date.now();
    if (stillFresh) return connection;

    if (!creds.refreshToken) {
        throw new Error('This account has no refresh token. Sign in to it again.');
    }

    const existing = refreshInFlight.get(connection.id);
    if (existing) return existing;

    const attempt = (async () => {
        try {
            const refreshed = await requestRefresh(creds.refreshToken);
            const updated = updateConnection(connection.id, { credentials: refreshed });
            logger.info(`[Google] Refreshed token for ${connection.email || connection.label}`);
            return updated || { ...connection, credentials: { ...creds, ...refreshed } };
        } finally {
            refreshInFlight.delete(connection.id);
        }
    })();

    refreshInFlight.set(connection.id, attempt);
    return attempt;
}

/**
 * Pick an account and make it ready to use.
 *
 * A refresh failure is attributed to that account and the next one is tried, so
 * one revoked login does not take the provider down.
 *
 * @returns {Promise<{connection: object, accessToken: string, projectId: string|null}>}
 */
export async function acquireConnection() {
    const attempted = new Set();
    let lastError = null;

    // Bounded by the number of accounts: every iteration marks one as attempted.
    for (let i = 0; i < 8; i += 1) {
        let connection;
        try {
            connection = selectConnection();
        } catch (error) {
            throw lastError || error;
        }

        if (attempted.has(connection.id)) break;
        attempted.add(connection.id);

        try {
            const ready = await refreshConnection(connection);
            return {
                connection: ready,
                accessToken: ready.credentials.accessToken,
                projectId: ready.credentials.projectId || null
            };
        } catch (error) {
            lastError = error;
            markConnectionFailed(connection.id, error);
            logger.warn?.(`[Google] Account ${connection.email || connection.label} unusable: ${error.message}`);
        }
    }

    throw lastError || new Error('No usable Google account.');
}

/** Whether any Google account is connected. */
export function isAuthenticated() {
    importLocalCredentials();
    return listConnections('google').length > 0;
}

/** Reset rotation state. Used by tests. */
export function resetRotation() {
    cursor = 0;
    stickyRemaining = 0;
    stickyConnectionId = null;
    importAttempted = false;
    refreshInFlight.clear();
}

export default {
    discoverCredentialSources,
    importLocalCredentials,
    selectConnection,
    refreshConnection,
    acquireConnection,
    isAuthenticated,
    resetRotation
};
