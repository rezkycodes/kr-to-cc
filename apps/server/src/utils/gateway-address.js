/**
 * Gateway address helpers.
 *
 * The UI is served from Express in production, but during development Vite
 * serves it on 3210 and proxies /config, /health, /v1 … to Express on 4000.
 * That means the browser's Host header is the *dev server*, not the gateway,
 * so anything Claude Code has to dial must be built from Express' own port.
 */

import { DEFAULT_PORT } from '../constants.js';

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
