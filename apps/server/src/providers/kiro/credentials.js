/**
 * Kiro credentials, across several accounts.
 *
 * Mirrors the Google provider: each signed-in Kiro account is a connection with
 * its own quota, and requests rotate between them.
 *
 * Kiro credentials carry more than a token. `authKey` selects the refresh
 * protocol (social vs SSO OIDC), and SSO accounts also need a region, a profile
 * ARN, and a client id/secret pair. All of it rides on the connection, because
 * two accounts can legitimately differ in every one of those fields.
 */

import {
    listConnections,
    listUsableConnections,
    saveConnection,
    updateConnection,
    markConnectionFailed
} from '../../connections/store.js';
import {
    discoverAllCredentialSources,
    validateAndBuildCredentials,
    extractEmailFromJWT
} from '../../auth/kiro-oauth.js';
import { logger } from '../../utils/logger.js';

/** Fields a Kiro connection needs beyond the token itself. */
function credentialsFrom(creds) {
    return {
        accessToken: creds.accessToken || null,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt ? new Date(creds.expiresAt).getTime() : null,
        // Selects the refresh protocol, so it must survive round-trips.
        authKey: creds.authKey || 'kirocli:social:token',
        region: creds.region || 'us-east-1',
        profileArn: creds.profileArn || null,
        clientId: creds.clientId || null,
        clientSecret: creds.clientSecret || null
    };
}

/**
 * Store a Kiro account after proving the token actually works.
 *
 * Validation happens here rather than on first use: a bad paste should fail while
 * the user is looking at the form, not silently later.
 *
 * @param {object} creds raw credentials from any sign-in method
 * @param {{authType: string, label?: string}} meta
 * @returns {Promise<object>} the stored connection
 */
export async function connectKiroAccount(creds, meta) {
    const validated = await validateAndBuildCredentials(creds);

    // Best-effort: the label is nicer with an email, but not worth failing over.
    let email = null;
    try {
        email = extractEmailFromJWT(validated.accessToken);
    } catch {
        email = null;
    }

    const connection = saveConnection({
        provider: 'kiro',
        authType: meta.authType,
        email,
        label: meta.label || email || meta.authType,
        credentials: credentialsFrom(validated)
    });

    logger.info(`[Kiro] Connected account ${email || connection.id} via ${meta.authType}`);
    return connection;
}

/** Runs at most once per process. */
let importAttempted = false;

/**
 * Import Kiro accounts already on this machine, once, if there are none yet.
 *
 * Sources are the Kiro CLI database and the AWS SSO cache the Kiro IDE writes.
 * Only when the store is empty, so a deleted account stays deleted.
 *
 * @returns {Promise<number>} how many were imported
 */
export async function importLocalCredentials() {
    if (importAttempted) return 0;
    importAttempted = true;

    if (listConnections('kiro').length > 0) return 0;

    let sources = [];
    try {
        sources = await discoverAllCredentialSources();
    } catch (error) {
        logger.debug?.(`[Kiro] Could not discover local credentials: ${error.message}`);
        return 0;
    }

    let imported = 0;
    for (const source of sources) {
        if (!source.refreshToken) continue;
        try {
            // Not validated here: a stale local token should still appear in the
            // list, with its error visible, rather than being silently dropped.
            saveConnection({
                provider: 'kiro',
                authType: 'imported',
                label: source.label || source.source || 'Kiro (local)',
                credentials: credentialsFrom(source)
            });
            imported += 1;
        } catch (error) {
            logger.debug?.(`[Kiro] Could not import ${source.label}: ${error.message}`);
        }
    }

    if (imported > 0) {
        logger.info(`[Kiro] Imported ${imported} existing account(s) from this machine`);
    }
    return imported;
}

/** Round-robin cursor and how many requests the current pick has served. */
let cursor = 0;
let stickyRemaining = 0;
let stickyConnectionId = null;

/**
 * How many consecutive requests one account serves before rotating.
 * Same reasoning as Google: rotating every request defeats upstream caching.
 */
const STICKY_REQUESTS = Math.max(
    1,
    Number.parseInt(process.env.KIRO_STICKY_REQUESTS || '1', 10) || 1
);

/**
 * Choose the account to serve the next request.
 * @returns {object} a usable connection
 * @throws {Error} when no account can serve
 */
export function selectConnection() {
    const usable = listUsableConnections('kiro');
    if (usable.length === 0) {
        const total = listConnections('kiro').length;
        throw new Error(
            total === 0
                ? 'No Kiro account connected. Add one on the Providers page.'
                : `All ${total} Kiro account(s) are disabled or rate-limited. Check the Providers page.`
        );
    }

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

/** Refresh this far ahead of expiry so a request never races the deadline. */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

/**
 * A valid access token for one connection, refreshing when needed.
 *
 * @param {object} connection
 * @returns {Promise<object>} the connection with a usable access token
 */
export async function refreshConnection(connection) {
    const creds = connection.credentials || {};
    const stillFresh = creds.accessToken
        && Number.isFinite(creds.expiresAt)
        && creds.expiresAt - REFRESH_LEAD_MS > Date.now();
    if (stillFresh) return connection;

    if (!creds.refreshToken) {
        throw new Error('This account has no refresh token. Connect it again.');
    }

    const existing = refreshInFlight.get(connection.id);
    if (existing) return existing;

    const attempt = (async () => {
        try {
            const refreshed = await validateAndBuildCredentials(creds);
            const updated = updateConnection(connection.id, {
                credentials: credentialsFrom(refreshed)
            });
            logger.info(`[Kiro] Refreshed token for ${connection.email || connection.label}`);
            return updated || { ...connection, credentials: credentialsFrom(refreshed) };
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
 * A refresh failure is attributed to that account and the next is tried, so one
 * revoked login does not take the provider down.
 *
 * @returns {Promise<{connection: object, credentials: object}>}
 */
export async function acquireConnection() {
    await importLocalCredentials();

    const attempted = new Set();
    let lastError = null;

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
            return { connection: ready, credentials: ready.credentials };
        } catch (error) {
            lastError = error;
            markConnectionFailed(connection.id, error);
            logger.warn?.(`[Kiro] Account ${connection.email || connection.label} unusable: ${error.message}`);
        }
    }

    throw lastError || new Error('No usable Kiro account.');
}

/** Whether any Kiro account is connected. */
export async function isAuthenticated() {
    await importLocalCredentials();
    return listConnections('kiro').length > 0;
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
    connectKiroAccount,
    importLocalCredentials,
    selectConnection,
    refreshConnection,
    acquireConnection,
    isAuthenticated,
    resetRotation
};
