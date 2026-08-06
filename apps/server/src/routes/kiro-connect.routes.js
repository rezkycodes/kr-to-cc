/**
 * Kiro sign-in, one route per method.
 *
 * Kiro accepts credentials several ways, and which ones are actually available
 * differs from the list a user might expect. Rather than offering methods that
 * fail on submit, `/methods` reports what this build supports and why, and the UI
 * shows the rest as unavailable.
 *
 * Every method ends the same way: validate the credential by refreshing it, then
 * store it as a connection. Validating up front means a bad paste fails while the
 * user is still looking at the form.
 */

import express from 'express';

import {
    generatePKCE,
    buildSocialLoginUrl,
    exchangeSocialCode,
    parseCallback,
    discoverAllCredentialSources
} from '../auth/kiro-oauth.js';
import { connectKiroAccount } from '../providers/kiro/credentials.js';
import { redactConnection } from '../connections/store.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * Sign-in methods, in the order they are worth trying.
 *
 * `available: false` entries are declared rather than hidden: knowing a method
 * exists but is not wired here is more useful than wondering why it is missing.
 */
const METHODS = [
    {
        id: 'local',
        title: 'Import from this machine',
        description: 'Use a login the Kiro CLI or Kiro IDE already has.',
        icon: 'download',
        available: true
    },
    {
        id: 'social',
        title: 'Google / GitHub login',
        description: 'Sign in through Kiro in your browser.',
        icon: 'globe',
        available: true
    },
    {
        id: 'token',
        title: 'Import token',
        description: 'Paste a refresh token from the Kiro IDE.',
        icon: 'upload',
        available: true
    },
    {
        id: 'cliproxy',
        title: 'Import CLIProxyAPI JSON',
        description: 'Paste external_idp auth JSON from CLIProxyAPI / Kiro Microsoft login.',
        icon: 'braces',
        available: true
    },
    {
        id: 'builder-id',
        title: 'AWS Builder ID',
        description: 'Device authorization against AWS Builder ID.',
        icon: 'shield',
        available: false,
        unavailableReason:
            'Not implemented in this build — the device authorization flow has not been verified '
            + 'against Kiro. Use Google/GitHub login or import a token instead.'
    },
    {
        id: 'idc',
        title: 'AWS IAM Identity Center',
        description: 'For a custom IAM Identity Center start URL.',
        icon: 'building',
        available: false,
        unavailableReason:
            'Not implemented in this build. An IDC login imported from the Kiro CLI or IDE does '
            + 'work — use "Import from this machine".'
    },
    {
        id: 'api-key',
        title: 'API key',
        description: 'A long-lived Kiro/CodeWhisperer API key.',
        icon: 'key',
        available: false,
        unavailableReason:
            'Not implemented in this build. This proxy refreshes OAuth tokens; it has no verified '
            + 'long-lived key path.'
    }
];

/** Pending social sign-ins, keyed by state. In memory by design. */
const pendingSocial = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 16;

function prunePending() {
    const now = Date.now();
    for (const [state, entry] of pendingSocial) {
        if (entry.expiresAt <= now) pendingSocial.delete(state);
    }
    while (pendingSocial.size > MAX_PENDING) {
        pendingSocial.delete(pendingSocial.keys().next().value);
    }
}

function fail(res, message, status = 400) {
    res.status(status).json({
        type: 'error',
        error: { type: 'invalid_request_error', message }
    });
}

/**
 * GET /oauth/kiro/connect/methods
 */
router.get('/connect/methods', (req, res) => {
    res.json({ methods: METHODS });
});

/**
 * GET /oauth/kiro/connect/local — what this machine already has.
 */
router.get('/connect/local', async (req, res) => {
    try {
        const sources = await discoverAllCredentialSources();
        res.json({
            sources: sources.map((source) => ({
                id: source.source,
                label: source.label || source.source,
                // Never the token itself.
                hasRefreshToken: Boolean(source.refreshToken),
                region: source.region || null
            }))
        });
    } catch (error) {
        fail(res, `Could not read local credentials: ${error.message}`);
    }
});

/**
 * POST /oauth/kiro/connect/local — import one, or all of them.
 */
router.post('/connect/local', async (req, res) => {
    try {
        const sources = await discoverAllCredentialSources();
        const wanted = req.body?.sourceId
            ? sources.filter((s) => s.source === req.body.sourceId)
            : sources;

        if (wanted.length === 0) {
            return fail(res, 'No Kiro login found on this machine. Sign in to the Kiro CLI or IDE first.');
        }

        const connected = [];
        const failures = [];
        for (const source of wanted) {
            try {
                const connection = await connectKiroAccount(source, {
                    authType: 'imported',
                    label: source.label || source.source
                });
                connected.push(redactConnection(connection));
            } catch (error) {
                // One stale local credential should not block importing the others.
                failures.push(`${source.label || source.source}: ${error.message}`);
            }
        }

        if (connected.length === 0) {
            return fail(res, `Could not import any local login. ${failures.join(' | ')}`);
        }

        res.json({ connections: connected, failures });
    } catch (error) {
        logger.error('[Kiro] Local import failed:', error);
        fail(res, error.message);
    }
});

/**
 * GET /oauth/kiro/connect/social/start — the URL to send the user to.
 */
router.get('/connect/social/start', (req, res) => {
    prunePending();
    const provider = req.query.provider === 'github' ? 'github' : 'google';
    const { verifier, challenge, state } = generatePKCE();
    pendingSocial.set(state, { verifier, expiresAt: Date.now() + PENDING_TTL_MS });
    res.json({ authUrl: buildSocialLoginUrl(provider, challenge, state), state, provider });
});

/**
 * POST /oauth/kiro/connect/social/complete — finish from the pasted callback URL.
 */
router.post('/connect/social/complete', async (req, res) => {
    prunePending();
    try {
        const { code, state } = parseCallback(req.body?.callbackUrl);
        const entry = state ? pendingSocial.get(state) : null;
        if (!entry) {
            // Without the verifier the exchange cannot succeed, so say so plainly
            // rather than letting the upstream return something opaque.
            return fail(res, 'This sign-in expired or was started elsewhere. Start it again.');
        }
        pendingSocial.delete(state);

        const creds = await exchangeSocialCode(code, entry.verifier);
        const connection = await connectKiroAccount(creds, { authType: 'social' });
        res.json({ connection: redactConnection(connection) });
    } catch (error) {
        fail(res, error.message);
    }
});

/**
 * POST /oauth/kiro/connect/token — paste a refresh token.
 */
router.post('/connect/token', async (req, res) => {
    const refreshToken = String(req.body?.refreshToken || '').trim();
    if (!refreshToken) return fail(res, 'Paste a refresh token.');

    try {
        const connection = await connectKiroAccount(
            {
                refreshToken,
                authKey: req.body?.authKey || undefined,
                region: req.body?.region || undefined,
                clientId: req.body?.clientId || undefined,
                clientSecret: req.body?.clientSecret || undefined
            },
            { authType: 'token' }
        );
        res.json({ connection: redactConnection(connection) });
    } catch (error) {
        fail(res, `That token was rejected: ${error.message}`);
    }
});

/**
 * Pull Kiro credentials out of a CLIProxyAPI auth JSON blob.
 *
 * The shape varies by version and by which login produced it, so several nestings
 * are accepted rather than assuming one. Anything without a refresh token is
 * rejected, since that is the only field that makes the account usable.
 *
 * @param {string} raw
 * @returns {object} credentials
 */
export function parseCliProxyJson(raw) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('Paste the JSON from CLIProxyAPI.');

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('That is not valid JSON.');
    }

    // Known nestings, most specific first.
    const candidates = [
        parsed,
        parsed.external_idp,
        parsed.externalIdp,
        parsed.auth,
        parsed.credentials,
        parsed.kiro,
        parsed.data
    ].filter((value) => value && typeof value === 'object');

    for (const candidate of candidates) {
        const refreshToken = candidate.refreshToken
            || candidate.refresh_token
            || candidate.refreshTokenValue;
        if (!refreshToken) continue;

        return {
            refreshToken: String(refreshToken),
            accessToken: candidate.accessToken || candidate.access_token || null,
            // A CLIProxyAPI export is an SSO OIDC credential unless it says otherwise.
            authKey: candidate.authKey || candidate.auth_key || 'kirocli:odic:token',
            region: candidate.region || 'us-east-1',
            profileArn: candidate.profileArn || candidate.profile_arn || null,
            clientId: candidate.clientId || candidate.client_id || null,
            clientSecret: candidate.clientSecret || candidate.client_secret || null
        };
    }

    throw new Error('No refresh token in that JSON. Copy the whole auth file, including external_idp.');
}

/**
 * POST /oauth/kiro/connect/cliproxy — import a CLIProxyAPI auth JSON.
 */
router.post('/connect/cliproxy', async (req, res) => {
    try {
        const creds = parseCliProxyJson(req.body?.json);
        const connection = await connectKiroAccount(creds, { authType: 'cliproxy' });
        res.json({ connection: redactConnection(connection) });
    } catch (error) {
        fail(res, error.message);
    }
});

export default router;
