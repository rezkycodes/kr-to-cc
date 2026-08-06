/**
 * Express App — Anthropic-compatible API proxied to AWS CodeWhisperer via Kiro.
 */

import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { REQUEST_BODY_LIMIT } from './constants.js';
import { logger } from './utils/logger.js';
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

app.use((req, res, next) => {
    logger.info(`[${req.method}] ${req.path}`);
    next();
});

registerRoutes(app);

export { isAllowedBrowserOrigin };
export { safeEqual } from './routes/v1.middleware.js';
export default app;
