/**
 * Express App — Anthropic-compatible API proxied to AWS CodeWhisperer via Kiro.
 */

import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { REQUEST_BODY_LIMIT } from './constants.js';
import { logger } from './utils/logger.js';
import { requestTelemetry } from './telemetry/request-telemetry.js';
import { registerRoutes } from './routes/index.js';

const app = express();
const uiAssetsDirectory = fileURLToPath(new URL('./ui/assets/', import.meta.url));
app.disable('x-powered-by');

function configuredOrigins() {
    return new Set(
        (process.env.ALLOWED_ORIGINS || '')
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean)
    );
}

function isAllowedBrowserOrigin(origin) {
    if (!origin) return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) return true;
    return configuredOrigins().has(origin);
}

function safeEqual(actual, expected) {
    const actualBuffer = Buffer.from(actual || '');
    const expectedBuffer = Buffer.from(expected || '');
    return actualBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function requestApiKey(req) {
    const authorization = req.get('authorization') || '';
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    return req.get('x-api-key') || req.get('anthropic-api-key') || bearer || '';
}

function telemetryErrorType(statusCode) {
    if (statusCode === 400) return 'invalid_request_error';
    if (statusCode === 401) return 'authentication_error';
    if (statusCode === 403) return 'permission_error';
    if (statusCode === 429) return 'rate_limit_error';
    return statusCode >= 500 ? 'api_error' : null;
}

// Baseline headers that do not break the inline local management pages.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
});

app.use(cors({
    origin(origin, callback) {
        callback(null, isAllowedBrowserOrigin(origin) ? origin || false : false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
        'authorization',
        'content-type',
        'x-api-key',
        'anthropic-api-key',
        'anthropic-version',
        'anthropic-beta'
    ],
    maxAge: 600
}));
app.use('/ui/assets', express.static(uiAssetsDirectory, {
    fallthrough: false,
    immutable: true,
    maxAge: '1y'
}));
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

// Support base URLs with or without a trailing /v1 segment.
app.use((req, res, next) => {
    if (req.url.startsWith('/v1/v1/')) req.url = req.url.slice(3);
    next();
});

// Track message generation at the HTTP boundary so auth/validation failures and
// client disconnects are visible too. The collector only receives allowlisted
// metadata; request bodies, headers, prompts, tools, and tokens are never stored.
app.use((req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/v1/messages') return next();

    const requestId = requestTelemetry.start({
        route: '/v1/messages',
        method: req.method,
        model: req.body?.model,
        stream: req.body?.stream
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
});

// Optional local proxy authentication. Claude Code can send this through
// ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY when PROXY_API_KEY is configured.
app.use('/v1', (req, res, next) => {
    const expected = process.env.PROXY_API_KEY;
    if (!expected || safeEqual(requestApiKey(req), expected)) return next();
    return res.status(401).json({
        type: 'error',
        error: {
            type: 'authentication_error',
            message: 'Invalid or missing proxy API key.'
        }
    });
});

app.use((req, res, next) => {
    logger.info(`[${req.method}] ${req.path}`);
    next();
});

registerRoutes(app);

export { isAllowedBrowserOrigin, safeEqual };
export default app;
