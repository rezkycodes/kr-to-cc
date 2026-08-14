/**
 * Route registry — mounts every HTTP router onto the Express app.
 *
 * Mount order matters: page/web routers first, then the core API router, then a
 * catch-all 404. Paths do not overlap, so this order is safe.
 */

import express from 'express';
import webAppRouter from './web-app.routes.js';
import dashboardRouter from './dashboard.routes.js';
import telemetryRouter from './telemetry.routes.js';
import comboRouter from './combo.routes.js';
import connectionRouter from './connection.routes.js';
import kiroConnectRouter from './kiro-connect.routes.js';
import providerModelRouter from './provider-model.routes.js';
import usageRouter from './usage.routes.js';
import oauthRouter from './oauth.routes.js';
import configRouter from './config.routes.js';
import piConfigRouter from './pi-config.routes.js';
import apiRouter, { healthRouter } from './api.routes.js';
import { messagesTelemetry, proxyAuth } from './v1.middleware.js';
import { logger } from '../utils/logger.js';
import { API_VERSION } from '../constants.js';

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

    // Combo management, same loopback-only trust boundary as the rest of /ui.
    app.use('/ui', comboRouter);

    // Connection management under /ui, and the OAuth sign-in flow at its own
    // top-level path so the redirect URI stays stable and guessable.
    app.use('/ui', connectionRouter);
    app.use('/ui', providerModelRouter);
    app.use('/ui', usageRouter);
    app.use('/', connectionRouter);

    // Dashboard (main menu) + embeddable viewer pages — mounted at the root.
    app.use('/', dashboardRouter);

    // Kiro OAuth / token-import (sign-in UI, auto-import, manual import).
    // Multi-account sign-in sits under the same prefix as the legacy page.
    app.use('/oauth/kiro', kiroConnectRouter);
    app.use('/oauth/kiro', oauthRouter);

    // Claude Code configuration UI/API (writes ~/.claude/settings.json).
    app.use('/config/claude', configRouter);
    app.use('/config/pi', piConfigRouter);

    // Unversioned endpoint.
    app.use('/', healthRouter);

    // Core Anthropic-compatible API.
    //
    // Anthropic clients build every request as `baseURL + "/v1/messages"`, so the
    // version segment comes from the client. When ANTHROPIC_BASE_URL is just the
    // origin it arrives once; when the setting already ends in the version segment
    // it arrives twice. Mounting the router both under the version segment and at
    // the root of the mount absorbs that duplicate, so either spelling of the
    // setting reaches the same handlers.
    //
    // The prefix is written once, as API_VERSION. Nothing rewrites a request URL,
    // and the route handlers stay relative — `/messages`, never `/v1/messages`.
    //
    // Order matters: the version branch has to be tried first, because the root
    // branch also matches a path that still carries the segment.
    const versioned = express.Router();
    for (const inner of [API_VERSION, '/']) {
        versioned.use(inner, messagesTelemetry, proxyAuth, apiRouter);
    }
    app.use(API_VERSION, versioned);

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
