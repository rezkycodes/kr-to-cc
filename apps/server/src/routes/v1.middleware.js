/**
 * Middleware that belongs to the versioned API surface.
 *
 * These are mounted together with the `/v1` router, so every path they inspect
 * is relative to that prefix — `/messages`, not `/v1/messages`. Keeping them
 * here rather than in server.js means the prefix is declared exactly once, by
 * the route registry.
 */

import crypto from 'crypto';
import { requestTelemetry } from '../telemetry/request-telemetry.js';
import { modelCostMultiplier } from '../kiro/model-api.js';
import { API_VERSION } from '../constants.js';

/** Constant-time comparison so a wrong key cannot be timed out character by character. */
export function safeEqual(actual, expected) {
    const actualBuffer = Buffer.from(actual || '');
    const expectedBuffer = Buffer.from(expected || '');
    return actualBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

/** The key a client may present, in any of the header spellings Anthropic clients use. */
export function requestApiKey(req) {
    const authorization = req.get('authorization') || '';
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    return req.get('x-api-key') || req.get('anthropic-api-key') || bearer || '';
}

/** Map an HTTP status onto the Anthropic error taxonomy for telemetry. */
export function telemetryErrorType(statusCode) {
    if (statusCode === 400) return 'invalid_request_error';
    if (statusCode === 401) return 'authentication_error';
    if (statusCode === 403) return 'permission_error';
    if (statusCode === 429) return 'rate_limit_error';
    return statusCode >= 500 ? 'api_error' : null;
}

/**
 * Track message generation at the HTTP boundary so auth/validation failures and
 * client disconnects are visible too. The collector only receives allowlisted
 * metadata; request bodies, headers, prompts, tools, and tokens are never stored.
 *
 * Runs before the auth guard on purpose: a rejected key is itself a data point.
 */
export function messagesTelemetry(req, res, next) {
    if (req.method !== 'POST' || req.path !== '/messages') return next();

    const requestId = requestTelemetry.start({
        // Label the canonical wire path, not the mount-relative one, so the
        // dashboard reads the same regardless of which mount matched.
        route: `${API_VERSION}/messages`,
        method: req.method,
        model: req.body?.model,
        stream: req.body?.stream,
        costMultiplier: modelCostMultiplier(req.body?.model)
    });
    req.telemetryRequestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    res.once('finish', () => {
        const failed = res.statusCode >= 400;
        requestTelemetry.finish(requestId, {
            outcome: failed ? 'failure' : 'success',
            status: res.statusCode,
            errorType: failed ? telemetryErrorType(res.statusCode) : null
        });
    });
    res.once('close', () => {
        if (!res.writableEnded) {
            requestTelemetry.finish(requestId, {
                outcome: 'canceled',
                status: 499,
                errorType: 'client_abort'
            });
        }
    });
    return next();
}

/**
 * Optional local proxy authentication. Claude Code can send this through
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY when PROXY_API_KEY is configured.
 */
export function proxyAuth(req, res, next) {
    const expected = process.env.PROXY_API_KEY;
    if (!expected || safeEqual(requestApiKey(req), expected)) return next();
    return res.status(401).json({
        type: 'error',
        error: {
            type: 'authentication_error',
            message: 'Invalid or missing proxy API key.'
        }
    });
}
