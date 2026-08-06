/**
 * Combo management API.
 *
 * Local-only management surface, mounted under /ui alongside the telemetry
 * endpoints. It writes to a file in the user's home directory, so it inherits the
 * same trust boundary as the rest of the management UI: the server binds to
 * loopback by default, and `PROXY_API_KEY` guards it when it does not.
 */

import express from 'express';

import {
    COMBO_STRATEGIES,
    listCombos,
    getCombo,
    saveCombo,
    deleteCombo,
    validateCombo
} from '../combos/store.js';
import { listAllModels } from '../providers/index.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/** Describe each strategy for the UI, so the wording lives in one place. */
const STRATEGY_INFO = {
    failover: {
        label: 'Failover',
        summary: 'Try members in order; move to the next when one errors or hits its quota.',
        detail: 'Cheapest option — only one member is called per request.'
    },
    'load-balance': {
        label: 'Load balance',
        summary: 'Spread requests across members in rotation to stretch several quotas.',
        detail: 'A member that just failed is skipped briefly, then retried.'
    },
    router: {
        label: 'Router',
        summary: 'Pick a member from the shape of the request.',
        detail: 'Heuristic, not a model call: requests with tools or a large prompt go to the '
            + 'last member, small ones to the first. List members cheapest first.'
    },
    race: {
        label: 'Race',
        summary: 'Ask several members at once and keep the fastest reply.',
        detail: 'Spends quota on every member for one answer. Streaming uses the first member '
            + 'only, since a stream has to commit before latency is known.'
    }
};

/**
 * GET /ui/combos — current combos, strategy metadata, and selectable models.
 */
router.get('/combos', async (req, res) => {
    let models = [];
    try {
        const catalog = await listAllModels();
        models = catalog.data.map((m) => ({
            id: m.id,
            namespaced_id: m.namespaced_id,
            provider: m.provider,
            description: m.description
        }));
    } catch (error) {
        // The picker degrades to free text rather than failing the page.
        logger.debug?.(`[Combo] Model list unavailable: ${error.message}`);
    }

    res.json({
        combos: listCombos(),
        strategies: COMBO_STRATEGIES.map((id) => ({ id, ...STRATEGY_INFO[id] })),
        models
    });
});

/**
 * POST /ui/combos — create or replace a combo.
 *
 * Body: {name, strategy, members: [{model}], replaces?}
 */
router.post('/combos', (req, res) => {
    const { name, strategy, members, replaces } = req.body || {};
    const definition = { name, strategy, members };

    const problems = validateCombo(definition, { existingName: replaces });
    if (problems.length > 0) {
        return res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: problems.join(' '), problems }
        });
    }

    try {
        const combo = saveCombo(definition, { existingName: replaces });
        res.json({ combo });
    } catch (error) {
        logger.error('[Combo] Save failed:', error);
        res.status(500).json({
            type: 'error',
            error: { type: 'api_error', message: error.message }
        });
    }
});

/**
 * DELETE /ui/combos/:name
 */
router.delete('/combos/:name', (req, res) => {
    const existed = deleteCombo(req.params.name);
    if (!existed) {
        return res.status(404).json({
            type: 'error',
            error: { type: 'not_found_error', message: `No combo named "${req.params.name}".` }
        });
    }
    res.json({ deleted: req.params.name });
});

/**
 * GET /ui/combos/:name
 */
router.get('/combos/:name', (req, res) => {
    const combo = getCombo(req.params.name);
    if (!combo) {
        return res.status(404).json({
            type: 'error',
            error: { type: 'not_found_error', message: `No combo named "${req.params.name}".` }
        });
    }
    res.json({ combo });
});

export default router;
