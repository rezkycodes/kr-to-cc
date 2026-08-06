/**
 * Connection management and provider sign-in.
 *
 * Two surfaces:
 *   /oauth/google/*   the browser sign-in flow
 *   /ui/connections   listing, enabling, reordering, testing, deleting
 *
 * Credentials never leave this process: every response goes through
 * `redactConnection`, so the UI can show state without ever holding a token.
 */

import express from 'express';

import {
    listConnections,
    getConnection,
    redactConnection,
    updateConnection,
    deleteConnection,
    reorderConnections,
    markConnectionHealthy,
    markConnectionFailed
} from '../connections/store.js';
import {
    startAuthorization,
    completeAuthorization,
    parseCallback
} from '../connections/google-oauth.js';
import { listProviders } from '../providers/index.js';
import { importLocalCredentials } from '../providers/google/credentials.js';
import { gatewayOrigin } from '../utils/gateway-address.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/** Where Google should send the browser back to. */
function callbackUrl(req) {
    return `${gatewayOrigin(req)}/oauth/google/callback`;
}

/**
 * Minimal HTML for the popup to land on.
 *
 * Tries to close itself, and says what to do when it cannot — a popup opened in a
 * different browser profile has no opener to notify.
 */
function callbackPage({ ok, message }) {
    const title = ok ? 'Connected' : 'Sign-in failed';
    const detail = ok
        ? 'This window can be closed.'
        : escapeHtml(message || 'Something went wrong.');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; display:grid; place-items:center; min-height:100vh;
         font:14px/1.5 ui-sans-serif,system-ui,sans-serif; background:#0a0a0a; color:#e5e5e5 }
  main { text-align:center; padding:2rem; max-width:32rem }
  h1 { font-size:15px; font-weight:500; margin:0 0 .5rem }
  p { margin:0; color:#a3a3a3; font-size:13px }
</style></head>
<body><main>
  <h1>${title}</h1>
  <p>${detail}</p>
</main>
<script>
  // The opener refreshes its own list; this window is only a landing pad.
  try { window.opener && window.opener.postMessage({ source: 'kiro-proxy-oauth', ok: ${ok} }, '*'); } catch (e) {}
  setTimeout(function () { try { window.close(); } catch (e) {} }, ${ok ? 400 : 4000});
</script></body></html>`;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * GET /oauth/google/start — the URL to send the user to.
 *
 * Returns the URL rather than redirecting, so the frontend can open it in a popup
 * and also show it for manual copying.
 */
router.get('/oauth/google/start', (req, res) => {
    const redirectUri = callbackUrl(req);
    const { authUrl, state } = startAuthorization(redirectUri);
    res.json({ authUrl, state, redirectUri });
});

/**
 * GET /oauth/google/callback — where Google sends the browser.
 */
router.get('/oauth/google/callback', async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // This page runs its own inline script; keep it off the app's stricter policy.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");

    const { code, state, error } = req.query;
    if (error) {
        return res.status(400).send(callbackPage({ ok: false, message: `Google reported "${error}".` }));
    }
    if (!code) {
        return res.status(400).send(callbackPage({ ok: false, message: 'No authorization code was returned.' }));
    }

    try {
        await completeAuthorization({ code: String(code), state: state ? String(state) : null, redirectUri: callbackUrl(req) });
        res.send(callbackPage({ ok: true }));
    } catch (cause) {
        logger.error('[OAuth] Google sign-in failed:', cause);
        res.status(400).send(callbackPage({ ok: false, message: cause.message }));
    }
});

/**
 * POST /oauth/google/manual — finish a sign-in from a pasted callback URL.
 *
 * The fallback for when the popup cannot report back.
 */
router.post('/oauth/google/manual', async (req, res) => {
    try {
        const { code, state } = parseCallback(req.body?.callbackUrl);
        const connection = await completeAuthorization({ code, state, redirectUri: callbackUrl(req) });
        res.json({ connection: redactConnection(connection) });
    } catch (cause) {
        res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: cause.message }
        });
    }
});

/**
 * GET /ui/connections — every provider with its accounts.
 *
 * Shaped for the provider list and detail views at once: one request populates
 * both, so switching between them needs no refetch.
 */
router.get('/connections', (req, res) => {
    // Surfaces accounts a vendor CLI already has, so a working setup does not show
    // up as "no connections". Runs at most once per process and only when the
    // store is empty.
    importLocalCredentials();

    const providers = listProviders().map((provider) => {
        const connections = listConnections(provider.id);
        return {
            id: provider.id,
            label: provider.label,
            // How this provider signs in, so the UI opens the right dialog rather
            // than inferring it from the provider id.
            signIn: provider.id === 'google' ? 'google-oauth'
                : provider.id === 'kiro' ? 'kiro-methods'
                    : null,
            supportsOAuth: provider.id === 'google' || provider.id === 'kiro',
            connectionCount: connections.length,
            enabledCount: connections.filter((c) => c.enabled !== false).length,
            connections: connections.map(redactConnection)
        };
    });
    res.json({ providers });
});

/**
 * PATCH /ui/connections/:id — enable, disable, or relabel.
 */
router.patch('/connections/:id', (req, res) => {
    const updated = updateConnection(req.params.id, req.body || {});
    if (!updated) {
        return res.status(404).json({
            type: 'error',
            error: { type: 'not_found_error', message: 'No such connection.' }
        });
    }
    res.json({ connection: redactConnection(updated) });
});

/**
 * POST /ui/connections/reorder — set the rotation order for one provider.
 */
router.post('/connections/reorder', (req, res) => {
    const { provider, ids } = req.body || {};
    if (!provider || !Array.isArray(ids)) {
        return res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Send a provider and an array of connection ids.' }
        });
    }
    res.json({ connections: reorderConnections(provider, ids).map(redactConnection) });
});

/**
 * DELETE /ui/connections/:id
 */
router.delete('/connections/:id', (req, res) => {
    if (!deleteConnection(req.params.id)) {
        return res.status(404).json({
            type: 'error',
            error: { type: 'not_found_error', message: 'No such connection.' }
        });
    }
    res.json({ deleted: req.params.id });
});

/**
 * POST /ui/connections/:id/test — check one account against its upstream.
 *
 * Refreshes the token, which is the cheapest call that proves the account still
 * works, and records the outcome so the list reflects reality.
 */
router.post('/connections/:id/test', async (req, res) => {
    const connection = getConnection(req.params.id);
    if (!connection) {
        return res.status(404).json({
            type: 'error',
            error: { type: 'not_found_error', message: 'No such connection.' }
        });
    }

    try {
        const { refreshConnection } = await import('../providers/google/credentials.js');
        await refreshConnection(connection);
        markConnectionHealthy(connection.id);
        res.json({ ok: true, connection: redactConnection(getConnection(connection.id)) });
    } catch (cause) {
        markConnectionFailed(connection.id, cause);
        res.json({
            ok: false,
            error: cause.message,
            connection: redactConnection(getConnection(connection.id))
        });
    }
});

export default router;
