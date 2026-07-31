/**
 * Route registry — mounts every HTTP router onto the Express app.
 *
 * Mount order matters: page/web routers first, then the core API router, then a
 * catch-all 404. Paths do not overlap, so this order is safe.
 */

import webAppRouter from './web-app.routes.js';
import dashboardRouter from './dashboard.routes.js';
import telemetryRouter from './telemetry.routes.js';
import oauthRouter from './oauth.routes.js';
import configRouter from './config.routes.js';
import apiRouter from './api.routes.js';
import { logger } from '../utils/logger.js';

/**
 * Register all application routes on the given Express app.
 * @param {import('express').Express} app
 */
export function registerRoutes(app) {
    // Production Vue dashboard. If dist/apps/web is absent, requests fall through
    // to the legacy server-rendered dashboard below.
    app.use('/', webAppRouter);

    // Local in-memory telemetry viewer and JSON snapshot.
    app.use('/ui/telemetry', telemetryRouter);

    // Dashboard (main menu) + embeddable viewer pages — mounted at the root.
    app.use('/', dashboardRouter);

    // Kiro OAuth / token-import (sign-in UI, auto-import, manual import).
    app.use('/oauth/kiro', oauthRouter);

    // Claude Code configuration UI/API (writes ~/.claude/settings.json).
    app.use('/config/claude', configRouter);

    // Core Anthropic-compatible API (/health, /v1/*).
    app.use('/', apiRouter);

    // Catch-all for unsupported endpoints.
    app.use('*', (req, res) => {
        if (logger.isDebugEnabled) {
            logger.debug(`[API] 404 Not Found: ${req.method} ${req.originalUrl}`);
        }
        res.status(404).json({
            type: 'error',
            error: {
                type: 'not_found_error',
                message: `Endpoint ${req.method} ${req.originalUrl} not found`
            }
        });
    });
}

export default registerRoutes;
