/**
 * Gateway address helpers.
 *
 * The UI is served from Express in production, but during development Vite
 * serves it on 3210 and proxies /config, /health, /v1 … to Express on 4000.
 * That means the browser's Host header is the *dev server*, not the gateway,
 * so anything Claude Code has to dial must be built from Express' own port.
 */

import { API_VERSION, DEFAULT_PORT } from '../constants.js';

/**
 * Port Express is actually listening on. index.js records the bound port via
 * app.set('gatewayPort'); the env/default fallback covers apps that are mounted
 * without listening (tests).
 * @param {import('express').Request} req
 * @returns {number}
 */
export function gatewayPort(req) {
    const bound = Number(req?.app?.get('gatewayPort'));
    if (Number.isInteger(bound) && bound > 0) return bound;
    const fromEnv = Number(process.env.PORT);
    return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

/**
 * Origin of this gateway as reachable by the caller: the hostname they used,
 * paired with Express' real port.
 * @param {import('express').Request} req
 * @returns {string}
 */
export function gatewayOrigin(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const hostname = req.hostname || 'localhost';
    // Bare IPv6 literals need brackets before a port can be appended.
    const host = hostname.includes(':') ? `[${hostname}]` : hostname;
    return `${proto}://${host}:${gatewayPort(req)}`;
}

/** Hostnames that all mean "this machine" and must compare as equal. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Canonical `scheme://host:port` for comparison. Trailing slashes, host casing
 * and the loopback aliases are ignored, because this proxy answers on all of
 * them. Any path is deliberately preserved by the caller, not folded away.
 *
 * @param {URL} url
 * @returns {string}
 */
function normalizeOrigin(url) {
    const hostname = url.hostname.toLowerCase();
    const host = LOOPBACK.has(hostname) ? 'localhost' : hostname;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${url.protocol}//${host}:${port}`;
}

/**
 * Explain why a configured ANTHROPIC_BASE_URL will not reach this gateway, or
 * null when it will.
 *
 * Claude Code builds its request as `new URL(baseURL + '/v1/messages')` and never
 * strips a path, so the setting may be the bare origin or end in `/v1`; the route
 * registry mounts the API at both resulting prefixes. Any other path is a
 * mistake, because it would be carried into the request untouched.
 *
 * @param {import('express').Request} req
 * @param {string | null | undefined} value
 * @returns {string | null} human-readable problem, or null when correct
 */
export function baseUrlIssue(req, value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return 'ANTHROPIC_BASE_URL is not set.';

    let url;
    try {
        url = new URL(raw);
    } catch {
        return `"${raw}" is not a valid URL.`;
    }

    const path = url.pathname.replace(/\/+$/, '');
    if (normalizeOrigin(url) !== normalizeOrigin(new URL(gatewayOrigin(req)))) {
        return `Points at ${url.origin}, not this gateway.`;
    }
    if (path === '' || path.toLowerCase() === API_VERSION) return null;
    return `Remove the "${path}" path. Use the origin, optionally followed by ${API_VERSION}.`;
}

/**
 * True when a configured base URL would reach this gateway.
 * @param {import('express').Request} req
 * @param {string | null | undefined} value
 * @returns {boolean}
 */
export function pointsAtGateway(req, value) {
    return baseUrlIssue(req, value) === null;
}
