/**
 * Kiro OAuth Service
 *
 * Adapted from the 9router Kiro OAuth implementation for this standalone proxy.
 * Supports:
 *   1. Google / GitHub social login (Authorization Code + PKCE, manual callback)
 *   2. Auto-import of an existing token from the Kiro CLI SQLite DB or the
 *      AWS SSO cache (Kiro IDE)
 *   3. Manual refresh-token import
 *
 * All imported credentials are persisted to the proxy token store so the
 * auto-refresh mechanism keeps them alive without re-running `kiro auth`.
 */

import crypto from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import {
    KIRO_AUTH_SERVICE,
    KIRO_SOCIAL_REDIRECT_URI,
    KIRO_REFRESH_TOKEN_PREFIX,
    assertValidAwsRegion
} from '../constants.js';
import { getKiroAuthStatus, getKiroDeviceRegistration } from './kiro-token-extractor.js';
import { refreshKiroToken } from './token-refresher.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/** Generate a PKCE code verifier (base64url). */
export function generateCodeVerifier(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

/** Generate the S256 code challenge for a verifier. */
export function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Generate a random CSRF state value. */
export function generateState() {
    return crypto.randomBytes(32).toString('base64url');
}

/** Generate a complete PKCE set. */
export function generatePKCE(bytes = 32) {
    const codeVerifier = generateCodeVerifier(bytes);
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();
    return { codeVerifier, codeChallenge, state };
}

// ---------------------------------------------------------------------------
// Social login (Google / GitHub)
// ---------------------------------------------------------------------------

/**
 * Build the Google/GitHub social login URL for the manual-callback flow.
 * @param {string} provider - "google" or "github"
 * @param {string} codeChallenge - PKCE S256 challenge
 * @param {string} state - CSRF state
 * @returns {string} authorization URL
 */
export function buildSocialLoginUrl(provider, codeChallenge, state) {
    const idp = provider === 'google' ? 'Google' : 'Github';
    return (
        `${KIRO_AUTH_SERVICE}/login` +
        `?idp=${idp}` +
        `&redirect_uri=${encodeURIComponent(KIRO_SOCIAL_REDIRECT_URI)}` +
        `&code_challenge=${codeChallenge}` +
        `&code_challenge_method=S256` +
        `&state=${state}` +
        `&prompt=select_account`
    );
}

/**
 * Exchange an authorization code for tokens (social login).
 * @param {string} code
 * @param {string} codeVerifier
 * @returns {Promise<Object>} { accessToken, refreshToken, profileArn, expiresIn }
 */
export async function exchangeSocialCode(code, codeVerifier) {
    const response = await fetch(`${KIRO_AUTH_SERVICE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code,
            code_verifier: codeVerifier,
            redirect_uri: KIRO_SOCIAL_REDIRECT_URI
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error.slice(0, 300)}`);
    }

    const data = await response.json();
    if (!data.accessToken) {
        throw new Error('Token exchange response missing accessToken.');
    }
    return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        profileArn: data.profileArn,
        expiresIn: data.expiresIn || 3600
    };
}

/**
 * Parse `code` and `state` out of a pasted callback value. Accepts either the
 * full `kiro://...` redirect URL or a bare code string.
 * @param {string} pasted
 * @returns {{ code: string, state: string|null }}
 */
export function parseCallback(pasted) {
    const value = (pasted || '').trim();
    if (!value) return { code: '', state: null };

    // Bare code (no URL structure)
    if (!value.includes('://') && !value.includes('?') && !value.includes('=')) {
        return { code: value, state: null };
    }

    try {
        // Custom protocol URLs parse fine with the WHATWG URL parser.
        const url = new URL(value);
        return {
            code: url.searchParams.get('code') || '',
            state: url.searchParams.get('state')
        };
    } catch {
        // Fall back to a query-string parse.
        const qIndex = value.indexOf('?');
        const query = qIndex >= 0 ? value.slice(qIndex + 1) : value;
        const params = new URLSearchParams(query);
        return { code: params.get('code') || '', state: params.get('state') };
    }
}

// ---------------------------------------------------------------------------
// JWT email extraction (best-effort, for display)
// ---------------------------------------------------------------------------

/**
 * Extract an email/identifier from a JWT access token, if present.
 * @param {string} accessToken
 * @returns {string|null}
 */
export function extractEmailFromJWT(accessToken) {
    try {
        const parts = (accessToken || '').split('.');
        if (parts.length !== 3) return null;
        let payload = parts[1];
        while (payload.length % 4) payload += '=';
        const decoded = JSON.parse(
            Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
        );
        return decoded.email || decoded.preferred_username || decoded.sub || null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Auto-import
// ---------------------------------------------------------------------------

/**
 * Try to read credentials from the Kiro CLI SQLite database.
 * @returns {Object|null} { refreshToken, authKey, region, profileArn, provider, source }
 */
function autoImportFromCliDb() {
    try {
        const status = getKiroAuthStatus();
        if (!status.refreshToken) return null;

        const creds = {
            authKey: status.authKey,
            refreshToken: status.refreshToken,
            region: status.region || 'us-east-1',
            profileArn: status.profileArn || null,
            provider: status.provider || null,
            source: 'kiro-cli-db'
        };

        // SSO logins need client credentials from the device registration.
        if (status.authKey && !status.authKey.includes('social')) {
            const reg = getKiroDeviceRegistration();
            if (reg) {
                creds.clientId = reg.clientId || reg.client_id || null;
                creds.clientSecret = reg.clientSecret || reg.client_secret || null;
            }
        }
        return creds;
    } catch (error) {
        logger.debug(`[Kiro OAuth] CLI DB auto-import skipped: ${error.message}`);
        return null;
    }
}

/**
 * Resolve the CodeWhisperer profileArn from Kiro IDE's profile.json, if present.
 * The runtime gateway requires the ARN to use us-east-1, so we normalize it.
 * @returns {Promise<string|null>}
 */
async function resolveIdeProfileArn() {
    const profilePaths = [
        join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
        join(homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
        join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json')
    ];
    for (const p of profilePaths) {
        try {
            const profileData = JSON.parse(await readFile(p, 'utf-8'));
            if (profileData.arn) {
                return profileData.arn.replace(
                    /arn:aws:codewhisperer:[^:]+:/,
                    'arn:aws:codewhisperer:us-east-1:'
                );
            }
        } catch {
            // Continue.
        }
    }
    return null;
}

/**
 * Human-friendly label for an AWS SSO cache token file.
 * @param {string} file
 * @returns {string}
 */
function labelForSsoFile(file) {
    if (file === 'kiro-auth-token.json') return 'Kiro IDE';
    if (file === 'kiro-auth-token-cli.json') return 'Kiro CLI (SSO cache)';
    return `AWS SSO cache (${file})`;
}

/**
 * Read every Kiro credential candidate from the AWS SSO cache
 * (~/.aws/sso/cache/*.json), resolving client credentials and profileArn.
 * @returns {Promise<Object[]>} Array of credential candidates
 */
async function readSsoCacheCandidates() {
    const cachePath = join(homedir(), '.aws/sso/cache');

    let files;
    try {
        files = await readdir(cachePath);
    } catch {
        return [];
    }

    // Kiro IDE token first, then CLI, then any others.
    const priority = ['kiro-auth-token.json', 'kiro-auth-token-cli.json'];
    const ordered = [
        ...priority.filter(f => files.includes(f)),
        ...files.filter(f => !priority.includes(f))
    ];

    const profileArn = await resolveIdeProfileArn();
    const candidates = [];

    for (const file of ordered) {
        if (!file.endsWith('.json')) continue;
        // Skip client registration files.
        if (file.endsWith('.registration.json')) continue;
        let data;
        try {
            data = JSON.parse(await readFile(join(cachePath, file), 'utf-8'));
        } catch {
            continue;
        }
        if (!data.refreshToken || !data.refreshToken.startsWith(KIRO_REFRESH_TOKEN_PREFIX)) {
            continue;
        }

        const isSocial = (data.authMethod || '').toLowerCase() === 'social' || !data.clientIdHash;
        const creds = {
            source: `sso-cache:${file}`,
            label: labelForSsoFile(file),
            refreshToken: data.refreshToken,
            region: data.region || 'us-east-1',
            authKey: isSocial ? 'kirocli:social:token' : 'kirocli:odic:token',
            provider: data.provider || data.authMethod || null,
            profileArn: data.profileArn || profileArn || null,
            expiresAt: data.expiresAt || null
        };

        // For SSO OIDC (non-social), resolve clientId/clientSecret.
        if (!isSocial && data.clientIdHash) {
            try {
                const clientData = JSON.parse(
                    await readFile(join(cachePath, `${data.clientIdHash}.json`), 'utf-8')
                );
                creds.clientId = clientData.clientId || clientData.client_id || null;
                creds.clientSecret = clientData.clientSecret || clientData.client_secret || null;
            } catch {
                // Registration file missing.
            }
        }

        candidates.push(creds);
    }

    return candidates;
}

/**
 * Discover ALL local Kiro credential sources: the Kiro CLI database plus every
 * token in the AWS SSO cache (Kiro IDE, Kiro CLI, etc.). Duplicate refresh
 * tokens are de-duplicated, keeping the first (highest-priority) source.
 * @returns {Promise<Object[]>} Array of credential candidates with metadata
 */
export async function discoverAllCredentialSources() {
    const sources = [];

    const cliDb = autoImportFromCliDb();
    if (cliDb) {
        sources.push({ ...cliDb, label: 'Kiro CLI (database)' });
    }

    const ssoCandidates = await readSsoCacheCandidates();
    sources.push(...ssoCandidates);

    // De-duplicate by refresh token, preserving order/priority.
    const seen = new Set();
    const unique = [];
    for (const s of sources) {
        const key = s.refreshToken;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        unique.push(s);
    }
    return unique;
}

/**
 * Discover Kiro credentials from local sources. If `sourceId` is given, returns
 * that specific source; otherwise returns the first (highest-priority) one.
 * @param {string} [sourceId]
 * @returns {Promise<Object|null>}
 */
export async function discoverLocalCredentials(sourceId) {
    const all = await discoverAllCredentialSources();
    if (!all.length) return null;
    if (sourceId) {
        return all.find(s => s.source === sourceId) || null;
    }
    return all[0];
}

/**
 * Validate a set of credentials by performing a refresh, returning a full
 * credential object ready to persist (with a fresh accessToken + expiry).
 * @param {Object} creds - Must contain refreshToken (+ clientId/secret for SSO)
 * @returns {Promise<Object>}
 */
export async function validateAndBuildCredentials(creds) {
    if (creds.region) assertValidAwsRegion(creds.region);
    if (!creds.refreshToken) {
        throw new Error('No refresh token available to validate.');
    }

    const refreshed = await refreshKiroToken({
        authKey: creds.authKey || 'kirocli:social:token',
        refreshToken: creds.refreshToken,
        region: creds.region || 'us-east-1',
        profileArn: creds.profileArn || null,
        clientId: creds.clientId || null,
        clientSecret: creds.clientSecret || null
    });

    return {
        authKey: creds.authKey || 'kirocli:social:token',
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || creds.refreshToken,
        expiresAt: refreshed.expiresAt,
        region: creds.region || 'us-east-1',
        profileArn: refreshed.profileArn || creds.profileArn || null,
        provider: creds.provider || null,
        clientId: creds.clientId || null,
        clientSecret: creds.clientSecret || null
    };
}

export default {
    generatePKCE,
    buildSocialLoginUrl,
    exchangeSocialCode,
    parseCallback,
    extractEmailFromJWT,
    discoverAllCredentialSources,
    discoverLocalCredentials,
    validateAndBuildCredentials
};
