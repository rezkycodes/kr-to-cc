/**
 * Pi Agent configuration.
 *
 * Pi Agent reads `~/.pi/agent/models.json` and speaks OpenAI, so the entry it
 * needs points at `/v1/chat/completions` rather than the Anthropic route the
 * Claude Code config writes.
 *
 * Mounted separately from the Claude config because that router is scoped to
 * `/config/claude`.
 */

import express from 'express';

import { API_VERSION } from '../constants.js';
import {
    applyPiConfig,
    buildPiProvider,
    piConfigPath,
    readPiConfig,
    removePiProvider,
    unavailableProviders,
    PI_PROVIDER_KEY
} from '../config/pi-agent.js';

const router = express.Router();

/** The origin a client on this machine should use to reach the gateway. */
function suggestedBaseUrl(req) {
    const host = req.get('host') || `localhost:${process.env.PORT || DEFAULT_PORT}`;
    const protocol = req.protocol || 'http';
    return `${protocol}://${host}${API_VERSION}`;
}


/**
 * GET /state — what is on disk, and what would be written.
 *
 * Pi Agent speaks OpenAI, so the entry it needs points at /v1/chat/completions
 * rather than the Anthropic route the Claude Code config uses.
 */
router.get('/state', async (req, res) => {
    const { exists, config, error } = readPiConfig();
    const baseUrl = suggestedBaseUrl(req);

    const current = config?.providers?.[PI_PROVIDER_KEY] ?? null;
    const proposed = await buildPiProvider({ baseUrl, apiKey: process.env.PROXY_API_KEY || 'dummy' });

    res.json({
        path: piConfigPath(),
        exists,
        // A file that cannot be parsed is reported, not overwritten: it holds the
        // user's other providers.
        error,
        providerKey: PI_PROVIDER_KEY,
        suggestedBaseUrl: baseUrl,
        // Whether the entry on disk already points at this gateway.
        pointsHere: current?.baseUrl === baseUrl && current?.api === 'openai-completions',
        current,
        proposed,
        otherProviders: Object.keys(config?.providers || {}).filter((k) => k !== PI_PROVIDER_KEY),
        // Any provider here contributes no models, so the config would be partial.
        unavailable: await unavailableProviders()
    });
});

/** POST /apply — merge this gateway's provider into the file. */
router.post('/apply', async (req, res) => {
    const baseUrl = typeof req.body?.baseUrl === 'string' && req.body.baseUrl
        ? req.body.baseUrl
        : suggestedBaseUrl(req);
    const apiKey = typeof req.body?.apiKey === 'string' && req.body.apiKey
        ? req.body.apiKey
        : (process.env.PROXY_API_KEY || 'dummy');

    const result = await applyPiConfig({ baseUrl, apiKey });
    res.status(result.ok ? 200 : 409).json(result);
});

/** DELETE /config/pi — remove this gateway's block, leaving others alone. */
router.delete('/', (req, res) => {
    const result = removePiProvider();
    res.status(result.ok ? 200 : 500).json(result);
});

export default router;
