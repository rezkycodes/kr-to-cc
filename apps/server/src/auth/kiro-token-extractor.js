/**
 * Kiro Token Extractor Module
 * Extracts OAuth tokens from Kiro CLI's SQLite database
 *
 * Kiro uses AWS OIDC authentication and stores tokens in:
 * - macOS: ~/Library/Application Support/kiro-cli/data.sqlite3
 * - Windows: ~/AppData/Roaming/kiro-cli/data.sqlite3
 * - Linux: ~/.config/kiro-cli/data.sqlite3
 */

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import {
    KIRO_DB_PATH,
    KIRO_TOKEN_KEYS,
    KIRO_DEVICE_REGISTRATION_KEYS,
    KIRO_CONFIG_PATH,
    TOKEN_REFRESH_BUFFER_MS
} from '../constants.js';
import { refreshKiroToken } from './token-refresher.js';
import { logger } from '../utils/logger.js';

// In-memory active credential (the currently valid token + metadata).
let activeCreds = null;
// Promise lock so concurrent requests share a single in-flight refresh.
let refreshInFlight = null;

/**
 * Parse a stored auth_kv value into a JSON object.
 * Kiro may store the value either as plain JSON or in a "key|json" format.
 * @param {string} value
 * @returns {Object}
 */
function parseStoredValue(value) {
    const jsonPart = value.includes('|')
        ? value.substring(value.indexOf('|') + 1)
        : value;
    return JSON.parse(jsonPart);
}

/**
 * Look up the first available auth token row across all known key variants.
 * @param {Database} db - Open better-sqlite3 database
 * @returns {{key: string, tokenData: Object}|null}
 */
function findTokenRow(db) {
    const stmt = db.prepare('SELECT value FROM auth_kv WHERE key = ?');
    for (const key of KIRO_TOKEN_KEYS) {
        const row = stmt.get(key);
        if (row && row.value) {
            try {
                const tokenData = parseStoredValue(row.value);
                if (tokenData && tokenData.access_token) {
                    return { key, tokenData };
                }
            } catch {
                // Try the next key variant.
            }
        }
    }
    return null;
}

/**
 * Query Kiro database for authentication tokens
 * @param {string} [dbPath] - Optional custom database path
 * @returns {Object} Parsed auth data with access_token, refresh_token, etc.
 * @throws {Error} If database doesn't exist, query fails, or no auth found
 */
export function getKiroAuthStatus(dbPath = KIRO_DB_PATH) {
    let db;
    try {
        // Open database in read-only mode
        db = new Database(dbPath, {
            readonly: true,
            fileMustExist: true
        });

        // Query for token data across all known key variants (social / SSO).
        const found = findTokenRow(db);

        if (!found) {
            throw new Error(
                `No auth token found in Kiro database (looked for keys: ${KIRO_TOKEN_KEYS.join(', ')}). ` +
                'Make sure you are logged in with "kiro auth".'
            );
        }

        const tokenData = found.tokenData;

        if (!tokenData.access_token) {
            throw new Error('Auth data missing access_token field');
        }

        return {
            authKey: found.key,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: tokenData.expires_at ? new Date(tokenData.expires_at) : null,
            region: tokenData.region || 'us-east-1',
            startUrl: tokenData.start_url,
            profileArn: tokenData.profile_arn || null,
            provider: tokenData.provider || null,
            scopes: tokenData.scopes || []
        };
    } catch (error) {
        // Enhance error messages for common issues
        if (error.code === 'SQLITE_CANTOPEN') {
            throw new Error(
                `Kiro database not found at ${dbPath}. ` +
                'Make sure Kiro CLI is installed and you are logged in.'
            );
        }
        if (error.message.includes('No auth token') || error.message.includes('missing access_token')) {
            throw error;
        }
        throw new Error(`Failed to read Kiro database: ${error.message}`);
    } finally {
        if (db) {
            db.close();
        }
    }
}

/**
 * Get device registration info (client credentials)
 * @param {string} [dbPath] - Optional custom database path
 * @returns {Object} Device registration data
 */
export function getKiroDeviceRegistration(dbPath = KIRO_DB_PATH) {
    let db;
    try {
        db = new Database(dbPath, {
            readonly: true,
            fileMustExist: true
        });

        const stmt = db.prepare('SELECT value FROM auth_kv WHERE key = ?');
        for (const key of KIRO_DEVICE_REGISTRATION_KEYS) {
            const row = stmt.get(key);
            if (row && row.value) {
                try {
                    return parseStoredValue(row.value);
                } catch {
                    // Try the next key variant.
                }
            }
        }
        return null;
    } catch (error) {
        logger.warn(`[Kiro] Failed to get device registration: ${error.message}`);
        return null;
    } finally {
        if (db) {
            db.close();
        }
    }
}

/**
 * Read the proxy's own token store (separate from Kiro CLI's DB).
 * Used to persist rotated refresh tokens so the proxy survives restarts.
 * @returns {Object|null} Stored credentials or null
 */
function readProxyStore() {
    try {
        if (!existsSync(KIRO_CONFIG_PATH)) return null;
        const raw = readFileSync(KIRO_CONFIG_PATH, 'utf-8');
        const data = JSON.parse(raw);
        if (!data || !data.accessToken) return null;
        return {
            authKey: data.authKey,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
            region: data.region || 'us-east-1',
            profileArn: data.profileArn || null,
            provider: data.provider || null,
            clientId: data.clientId || null,
            clientSecret: data.clientSecret || null
        };
    } catch (error) {
        logger.warn(`[Kiro] Failed to read proxy token store: ${error.message}`);
        return null;
    }
}

/**
 * Persist credentials to the proxy's own token store.
 * @param {Object} creds
 */
function writeProxyStore(creds) {
    try {
        mkdirSync(dirname(KIRO_CONFIG_PATH), { recursive: true });
        const payload = {
            authKey: creds.authKey,
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
            expiresAt: creds.expiresAt ? new Date(creds.expiresAt).toISOString() : null,
            region: creds.region,
            profileArn: creds.profileArn,
            provider: creds.provider,
            clientId: creds.clientId || null,
            clientSecret: creds.clientSecret || null,
            updatedAt: new Date().toISOString()
        };
        writeFileSync(KIRO_CONFIG_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch (error) {
        logger.warn(`[Kiro] Failed to persist proxy token store: ${error.message}`);
    }
}

/**
 * Load credentials from the DB, enriching SSO logins with client credentials
 * from the device registration (needed for OIDC refresh).
 * @returns {Object|null}
 */
function loadCredentialsFromDb() {
    try {
        const data = getKiroAuthStatus();
        const creds = { ...data };
        // For SSO OIDC, pull clientId/clientSecret from device registration.
        if (!creds.authKey || !creds.authKey.includes('social')) {
            const reg = getKiroDeviceRegistration();
            if (reg) {
                creds.clientId = reg.clientId || reg.client_id || null;
                creds.clientSecret = reg.clientSecret || reg.client_secret || null;
            }
        }
        return creds;
    } catch (error) {
        logger.debug(`[Kiro] Could not load credentials from DB: ${error.message}`);
        return null;
    }
}

/**
 * Pick the freshest credentials between the DB and the proxy store, based on
 * expiry. This lets a fresh `kiro auth` (which updates the DB) override an older
 * proxy-stored token, while the proxy store wins after we've refreshed.
 * @returns {Object} Best available credentials
 * @throws {Error} If neither source has a usable token
 */
function loadBestCredentials() {
    const dbCreds = loadCredentialsFromDb();
    const storeCreds = readProxyStore();

    if (dbCreds && storeCreds) {
        const dbExp = dbCreds.expiresAt ? dbCreds.expiresAt.getTime() : 0;
        const storeExp = storeCreds.expiresAt ? storeCreds.expiresAt.getTime() : 0;
        // Prefer whichever expires later (i.e. was issued/refreshed most recently),
        // but carry over client credentials if only one side has them.
        const best = dbExp >= storeExp ? { ...dbCreds } : { ...storeCreds };
        best.clientId = best.clientId || dbCreds.clientId || storeCreds.clientId || null;
        best.clientSecret = best.clientSecret || dbCreds.clientSecret || storeCreds.clientSecret || null;
        best.profileArn = best.profileArn || dbCreds.profileArn || storeCreds.profileArn || null;
        return best;
    }

    const creds = dbCreds || storeCreds;
    if (!creds) {
        throw new Error('No Kiro credentials found in database or proxy store. Please run "kiro auth".');
    }
    return creds;
}

/**
 * Whether the given credentials need a refresh (expired or within the buffer).
 * @param {Object} creds
 * @returns {boolean}
 */
function needsRefresh(creds) {
    if (!creds || !creds.accessToken) return true;
    if (!creds.expiresAt) return false; // No expiry info; assume still valid.
    return Date.now() >= creds.expiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS;
}

/**
 * Ensure we have a valid (non-expiring) access token, refreshing if needed.
 * Concurrent callers share a single in-flight refresh.
 * @returns {Promise<Object>} Valid credentials
 */
export async function ensureValidKiroToken() {
    if (!activeCreds) {
        activeCreds = loadBestCredentials();
    }

    if (!needsRefresh(activeCreds)) {
        return activeCreds;
    }

    // If a refresh is already running, wait for it.
    if (refreshInFlight) {
        return refreshInFlight;
    }

    refreshInFlight = (async () => {
        try {
            // Re-check in case another path reloaded fresh creds meanwhile.
            const current = activeCreds || loadBestCredentials();

            if (!current.refreshToken) {
                // Can't refresh; fall back to whatever token we have.
                if (current.accessToken && !isExpired(current)) {
                    activeCreds = current;
                    return current;
                }
                throw new Error('Kiro token expired and no refresh token available. Please run "kiro auth".');
            }

            const updated = await refreshKiroToken(current);
            activeCreds = {
                ...current,
                accessToken: updated.accessToken,
                refreshToken: updated.refreshToken,
                expiresAt: updated.expiresAt,
                profileArn: updated.profileArn || current.profileArn || null
            };
            writeProxyStore(activeCreds);
            logger.success(`[Kiro] Token refreshed, valid until ${activeCreds.expiresAt?.toISOString()}`);
            return activeCreds;
        } catch (error) {
            logger.error(`[Kiro] Token refresh failed: ${error.message}`);
            // If the existing token is still technically valid, keep using it.
            if (activeCreds && activeCreds.accessToken && !isExpired(activeCreds)) {
                return activeCreds;
            }
            throw error;
        } finally {
            refreshInFlight = null;
        }
    })();

    return refreshInFlight;
}

/**
 * Whether credentials are fully expired (past expiry, no buffer).
 * @param {Object} creds
 */
function isExpired(creds) {
    if (!creds || !creds.expiresAt) return false;
    return Date.now() >= creds.expiresAt.getTime();
}

/**
 * Get the current OAuth token (auto-refreshing when needed).
 * @returns {Promise<string>} The access token
 */
export async function getKiroToken() {
    const creds = await ensureValidKiroToken();
    return creds.accessToken;
}

/**
 * Get all Kiro auth data (token + metadata), auto-refreshing when needed.
 * @returns {Promise<Object>} Full auth data
 */
export async function getKiroAuthData() {
    return ensureValidKiroToken();
}

/**
 * Check if Kiro database exists and is accessible
 * @param {string} [dbPath] - Optional custom database path
 * @returns {boolean} True if database exists and can be opened
 */
export function isKiroDatabaseAccessible(dbPath = KIRO_DB_PATH) {
    // The proxy store alone is enough to operate (it holds refreshable creds),
    // even if the Kiro CLI DB is temporarily unavailable.
    if (readProxyStore()) {
        return true;
    }
    let db;
    try {
        db = new Database(dbPath, {
            readonly: true,
            fileMustExist: true
        });
        return true;
    } catch {
        return false;
    } finally {
        if (db) {
            db.close();
        }
    }
}

/**
 * Check if Kiro is authenticated. Considers a token authenticated if it is
 * either still valid OR expired-but-refreshable (has a refresh token), since
 * the proxy can transparently refresh it.
 * @returns {boolean} True if authenticated
 */
export function isKiroAuthenticated() {
    try {
        const creds = loadBestCredentials();
        if (!creds.accessToken) return false;

        // Valid now?
        if (!creds.expiresAt || new Date() < creds.expiresAt) {
            return true;
        }

        // Expired but we can refresh it.
        if (creds.refreshToken) {
            logger.debug('[Kiro] Access token expired but a refresh token is available.');
            return true;
        }

        logger.warn('[Kiro] Token is expired and cannot be refreshed.');
        return false;
    } catch {
        return false;
    }
}

/**
 * Clear the token cache (for testing or forced refresh)
 */
export function clearKiroTokenCache() {
    activeCreds = null;
    refreshInFlight = null;
}

/**
 * Persist a full set of Kiro credentials (from OAuth login, auto-import, or a
 * manual token import) into the proxy token store and make them the active
 * credentials immediately. This is the entry point used by the OAuth routes.
 *
 * @param {Object} creds
 * @param {string} creds.accessToken
 * @param {string} [creds.refreshToken]
 * @param {Date|string|number} [creds.expiresAt]
 * @param {string} [creds.region]
 * @param {string} [creds.profileArn]
 * @param {string} [creds.provider]
 * @param {string} [creds.authKey] - e.g. 'kirocli:social:token' (defaults to social)
 * @param {string} [creds.clientId] - for SSO OIDC refresh
 * @param {string} [creds.clientSecret] - for SSO OIDC refresh
 * @returns {Object} The stored credentials (with expiresAt as Date)
 */
export function saveKiroCredentials(creds) {
    if (!creds || !creds.accessToken) {
        throw new Error('Cannot save Kiro credentials without an access token.');
    }

    const normalized = {
        authKey: creds.authKey || 'kirocli:social:token',
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken || null,
        expiresAt: creds.expiresAt ? new Date(creds.expiresAt) : null,
        region: creds.region || 'us-east-1',
        profileArn: creds.profileArn || null,
        provider: creds.provider || null,
        clientId: creds.clientId || null,
        clientSecret: creds.clientSecret || null
    };

    writeProxyStore(normalized);
    activeCreds = normalized;
    logger.success('[Kiro] Credentials saved to proxy token store.');
    return normalized;
}

export default {
    getKiroToken,
    getKiroAuthData,
    getKiroAuthStatus,
    getKiroDeviceRegistration,
    ensureValidKiroToken,
    saveKiroCredentials,
    isKiroDatabaseAccessible,
    isKiroAuthenticated,
    clearKiroTokenCache
};
