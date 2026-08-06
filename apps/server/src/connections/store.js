/**
 * Provider connections.
 *
 * A connection is one signed-in account on one provider. Providers hold several,
 * which is the point: each account carries its own quota, so rotating between
 * them multiplies the usable ceiling — especially on a free tier.
 *
 * Stored in `~/.config/kiro-proxy/connections.json` with owner-only permissions.
 * This file holds refresh tokens, so nothing here logs a credential value and the
 * API layer never returns one.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import { logger } from '../utils/logger.js';

/** Overridden by tests so they never touch the real config. */
let storeOverride = null;

function storePath() {
    return storeOverride || path.join(os.homedir(), '.config', 'kiro-proxy', 'connections.json');
}

/**
 * Point the store at a different file. Test-only.
 * @param {string|null} filePath
 */
export function __setStorePathForTests(filePath) {
    storeOverride = filePath;
    cache = null;
}

/** In-process cache; connections change only through this module. */
let cache = null;

/**
 * Fields that are credentials. Stripped from anything the API returns, so a
 * token cannot leak through the management UI.
 */
const SECRET_FIELDS = ['accessToken', 'refreshToken', 'idToken', 'clientSecret'];

function read() {
    if (cache) return cache;
    try {
        const file = storePath();
        if (!fs.existsSync(file)) {
            cache = [];
            return cache;
        }
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        cache = Array.isArray(parsed?.connections) ? parsed.connections : [];
    } catch (error) {
        // A corrupt store must not take the proxy down; it degrades to "no
        // accounts", which the UI can show and the user can fix.
        logger.warn?.(`[Connections] Could not read store, treating as empty: ${error.message}`);
        cache = [];
    }
    return cache;
}

function persist(connections) {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ connections }, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    cache = connections;
}

/**
 * Every connection, ordered by provider then priority.
 * @param {string} [provider] limit to one provider
 * @returns {object[]}
 */
export function listConnections(provider) {
    const all = read();
    const filtered = provider ? all.filter((c) => c.provider === provider) : all;
    return [...filtered].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
}

/**
 * Connections that may serve traffic right now.
 *
 * Excludes disabled accounts and ones still inside a rate-limit window. An
 * account with a past error is *not* excluded: errors expire, and permanently
 * sidelining an account on one failure would quietly shrink capacity.
 *
 * @param {string} provider
 * @returns {object[]}
 */
export function listUsableConnections(provider) {
    const now = Date.now();
    return listConnections(provider).filter((c) => {
        if (c.enabled === false) return false;
        if (c.rateLimitedUntil && Date.parse(c.rateLimitedUntil) > now) return false;
        return Boolean(c.credentials?.refreshToken || c.credentials?.accessToken);
    });
}

/**
 * Find one connection by id.
 * @param {string} id
 * @returns {object|null}
 */
export function getConnection(id) {
    return read().find((c) => c.id === id) || null;
}

/**
 * Strip credentials for anything crossing the API boundary.
 * @param {object} connection
 * @returns {object}
 */
export function redactConnection(connection) {
    if (!connection) return connection;
    const credentials = { ...(connection.credentials || {}) };
    for (const field of SECRET_FIELDS) delete credentials[field];
    return {
        ...connection,
        credentials: {
            // Enough to show state without exposing anything usable.
            hasRefreshToken: Boolean(connection.credentials?.refreshToken),
            expiresAt: connection.credentials?.expiresAt ?? null,
            projectId: credentials.projectId ?? null
        }
    };
}

/**
 * Add or replace a connection.
 *
 * Identity is the email when there is one, and the refresh token otherwise.
 * Imported credentials often have no email — the address only appears once a token
 * has been used — so without the token fallback every re-import would pile up a
 * duplicate of the same account.
 *
 * @param {object} input {provider, email, authType, credentials, ...}
 * @returns {object} the stored connection
 */
export function saveConnection(input) {
    if (!input?.provider) throw new Error('A connection needs a provider.');
    if (!input?.credentials?.refreshToken && !input?.credentials?.accessToken) {
        throw new Error('A connection needs a token.');
    }

    const all = read();
    const email = input.email || null;
    const refreshToken = input.credentials?.refreshToken || null;

    const existing = all.find((c) => {
        if (c.provider !== input.provider) return false;
        if (email && c.email === email) return true;
        // Same credential, so the same account — regardless of how it was added.
        if (refreshToken && c.credentials?.refreshToken === refreshToken) return true;
        return false;
    }) || null;

    const now = new Date().toISOString();
    const connection = {
        id: existing?.id || crypto.randomUUID(),
        provider: input.provider,
        authType: input.authType || 'oauth',
        email,
        label: input.label || email || 'account',
        // Appended at the end unless it already had a place in the order.
        priority: existing?.priority
            ?? all.filter((c) => c.provider === input.provider).length + 1,
        enabled: existing?.enabled ?? true,
        credentials: { ...(existing?.credentials || {}), ...input.credentials },
        // Re-authenticating clears whatever was wrong before.
        lastError: null,
        lastErrorAt: null,
        rateLimitedUntil: null,
        lastTested: existing?.lastTested ?? null,
        createdAt: existing?.createdAt || now,
        updatedAt: now
    };

    const others = all.filter((c) => c.id !== connection.id);
    persist([...others, connection]);
    logger.info(`[Connections] Saved ${connection.provider} account ${email || connection.id}`);
    return connection;
}

/**
 * Update the mutable parts of a connection.
 *
 * Credentials are merged rather than replaced so refreshing an access token does
 * not drop the refresh token.
 *
 * @param {string} id
 * @param {object} patch
 * @returns {object|null}
 */
export function updateConnection(id, patch = {}) {
    const all = read();
    const index = all.findIndex((c) => c.id === id);
    if (index === -1) return null;

    const current = all[index];
    const updated = {
        ...current,
        ...('enabled' in patch ? { enabled: patch.enabled !== false } : {}),
        ...('priority' in patch ? { priority: Number(patch.priority) || current.priority } : {}),
        ...('label' in patch ? { label: String(patch.label).slice(0, 120) } : {}),
        ...('lastError' in patch ? { lastError: patch.lastError } : {}),
        ...('lastErrorAt' in patch ? { lastErrorAt: patch.lastErrorAt } : {}),
        ...('lastTested' in patch ? { lastTested: patch.lastTested } : {}),
        ...('rateLimitedUntil' in patch ? { rateLimitedUntil: patch.rateLimitedUntil } : {}),
        ...(patch.credentials
            ? { credentials: { ...current.credentials, ...patch.credentials } }
            : {}),
        updatedAt: new Date().toISOString()
    };

    const next = [...all];
    next[index] = updated;
    persist(next);
    return updated;
}

/**
 * Failures that mean "this account is out of allowance for now".
 *
 * Wording and status differ by upstream: Google says "quota" with 429, while Kiro
 * says "You have reached the limit" with 402. Matching only 429/quota let a
 * spent Kiro account stay in rotation and fail every request it was handed, so
 * both spellings are covered.
 */
export const QUOTA_EXHAUSTED_PATTERN =
    /quota|rate.?limit|\b429\b|\b402\b|reached the limit|limit reached|exhausted|insufficient.{0,12}credit/i;

/**
 * Record that a connection failed.
 *
 * A quota error parks the account for a while rather than disabling it, because
 * quota comes back. Anything else is recorded but leaves the account in
 * rotation — one transient failure should not cost capacity.
 *
 * @param {string} id
 * @param {Error|string} error
 * @param {{rateLimitedForMs?: number}} [options]
 */
export function markConnectionFailed(id, error, options = {}) {
    const message = String(error?.message || error || 'unknown error').slice(0, 300);
    const now = new Date().toISOString();
    const patch = { lastError: message, lastErrorAt: now };

    const quotaHit = QUOTA_EXHAUSTED_PATTERN.test(message);
    const parkMs = options.rateLimitedForMs
        ?? (quotaHit ? 10 * 60 * 1000 : 0);
    if (parkMs > 0) {
        patch.rateLimitedUntil = new Date(Date.now() + parkMs).toISOString();
    }

    return updateConnection(id, patch);
}

/** Record that a connection worked, clearing prior failure state. */
export function markConnectionHealthy(id) {
    return updateConnection(id, {
        lastError: null,
        lastErrorAt: null,
        rateLimitedUntil: null,
        lastTested: new Date().toISOString()
    });
}

/**
 * Remove a connection.
 * @param {string} id
 * @returns {boolean} whether it existed
 */
export function deleteConnection(id) {
    const all = read();
    const remaining = all.filter((c) => c.id !== id);
    if (remaining.length === all.length) return false;
    persist(remaining);
    logger.info(`[Connections] Deleted connection ${id}`);
    return true;
}

/**
 * Set the order of a provider's connections.
 *
 * Order matters: it is the rotation order, and the first usable account is the
 * one a non-rotating provider uses.
 *
 * @param {string} provider
 * @param {string[]} orderedIds
 */
export function reorderConnections(provider, orderedIds) {
    const all = read();
    const position = new Map(orderedIds.map((id, index) => [id, index + 1]));
    const next = all.map((c) =>
        c.provider === provider && position.has(c.id)
            ? { ...c, priority: position.get(c.id), updatedAt: new Date().toISOString() }
            : c
    );
    persist(next);
    return listConnections(provider);
}

/** Drop the cache so the next read hits disk. Used by tests. */
export function clearCache() {
    cache = null;
}

export default {
    listConnections,
    listUsableConnections,
    getConnection,
    redactConnection,
    saveConnection,
    updateConnection,
    markConnectionFailed,
    markConnectionHealthy,
    deleteConnection,
    reorderConnections,
    clearCache
};
