/**
 * Per-provider model catalog, quota, and testing.
 *
 * Quota means different things per provider, and flattening that would mislead:
 *
 *   - **Google** meters per model. Each catalog entry carries its own remaining
 *     fraction and reset time.
 *   - **Kiro** meters the account in credits. One monthly allowance is shared by
 *     every model, each drawing at its own multiplier. There is no per-model
 *     remaining figure, so the response reports `quotaScope: 'account'` and the
 *     UI says so rather than repeating one number on every row as if it were
 *     per-model.
 */

import express from 'express';

import { getProvider, listProviders } from '../providers/index.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * Budget for a model test.
 *
 * Has to clear a thinking model's reasoning as well as the reply: at 16 tokens a
 * Gemini thinking model spends the lot on thought and returns no text, so the test
 * passes while proving nothing. Still small enough to be cheap.
 */
const TEST_MAX_TOKENS = 512;
const TEST_PROMPT = 'Reply with OK.';

/**
 * Quota for a provider, in whatever shape that provider actually meters.
 * @param {string} providerId
 */
async function providerQuota(providerId) {
    if (providerId === 'kiro') {
        const [{ getKiroUsageLimits }, { listConnections }, { refreshConnection }, { setActiveKiroCredentials }] =
            await Promise.all([
                import('../providers/kiro/usage.js'),
                import('../connections/store.js'),
                import('../providers/kiro/credentials.js'),
                import('../auth/kiro-token-extractor.js')
            ]);

        // Reported per account, not once for the provider. Accounts can be on
        // different plans with different allowances — one was KIRO FREE and another
        // KIRO PRO here — so a single figure would describe whichever account
        // happened to be picked and misrepresent the rest.
        const accounts = [];
        for (const connection of listConnections('kiro')) {
            try {
                const ready = await refreshConnection(connection);
                setActiveKiroCredentials(ready.credentials);
                const usage = await getKiroUsageLimits();
                accounts.push({
                    connectionId: connection.id,
                    label: connection.email || connection.label,
                    plan: usage.plan,
                    resetAt: usage.resetAt,
                    quotas: usage.quotas,
                    // Some tokens cannot read the usage API even though they can
                    // serve requests, so this is reported rather than hidden.
                    error: usage.error || null
                });
            } catch (error) {
                accounts.push({
                    connectionId: connection.id,
                    label: connection.email || connection.label,
                    plan: null,
                    resetAt: null,
                    quotas: [],
                    error: error.message
                });
            }
        }

        return {
            scope: 'account',
            note: 'Kiro meters each account in credits shared by every model. '
                + 'Each model spends at its own multiplier, so there is no per-model figure.',
            accounts,
            error: null
        };
    }

    if (providerId === 'google') {
        const { getGoogleAccountQuotas } = await import('../providers/google/usage.js');
        // Per model *and* per account: each account holds its own set of model
        // allowances, so the figures are reported per account rather than merged.
        return {
            scope: 'model',
            note: 'Google meters each model separately, and every account has its own '
                + 'set of allowances. Pick an account to see its remaining quota.',
            accounts: await getGoogleAccountQuotas(),
            error: null
        };
    }

    return { scope: 'unknown', note: null, accounts: [], error: null };
}

/**
 * GET /ui/providers — the list, for navigation.
 */
router.get('/providers', (req, res) => {
    res.json({
        providers: listProviders().map((p) => ({ id: p.id, label: p.label }))
    });
});

/**
 * GET /ui/providers/:id/models — that provider's catalog, with quota.
 */
router.get('/providers/:id/models', async (req, res) => {
    const provider = getProvider(req.params.id);
    if (!provider) {
        return res.status(404).json({
            type: 'error',
            error: { type: 'not_found_error', message: `No provider "${req.params.id}".` }
        });
    }

    // The catalog does not need a working account — only quota and testing do. So
    // a spent or revoked account must not empty the model list; it just means the
    // quota figures and Test buttons will not work, which is reported separately.
    let unavailable = null;
    try {
        await provider.ensureReady();
    } catch (error) {
        unavailable = error.message;
    }

    try {
        // The live catalog lists more models than the static seed, so it is worth
        // waiting for even though quota now comes from the per-account maps.
        if (provider.id === 'google') {
            const [{ acquireConnection }, { refreshCatalog }] = await Promise.all([
                import('../providers/google/credentials.js'),
                import('../providers/google/models.js')
            ]);
            try {
                const { accessToken, projectId } = await acquireConnection();
                await refreshCatalog(accessToken, projectId);
            } catch (error) {
                // A failed refresh costs catalog breadth, not the listing.
                logger.debug?.(`[Providers] Google catalog refresh failed: ${error.message}`);
            }
        }

        const catalog = await provider.listModels();
        const quota = await providerQuota(provider.id).catch(() => null);

        const models = (catalog?.data || []).map((model) => ({
            id: model.id,
            namespacedId: `${provider.id}/${model.id}`,
            description: model.description || null,
            contextWindow: model.context_window ?? null,
            costMultiplier: model.cost_multiplier ?? null,
            status: model.status || 'active',
            thinking: model.thinking === true
        }));

        // Nothing below should assume quota was readable.
        if (!quota) {
            return res.json({
                provider: { id: provider.id, label: provider.label },
                models,
                quota: null,
                unavailable
            });
        }

        res.json({
            provider: { id: provider.id, label: provider.label },
            models,
            quota,
            unavailable
        });
    } catch (error) {
        logger.error(`[Providers] Could not list ${provider.id} models:`, error);
        res.status(500).json({
            type: 'error',
            error: { type: 'api_error', message: error.message }
        });
    }
});

/**
 * POST /ui/providers/:id/models/:model/test — does this model actually answer?
 *
 * Sends one tiny non-streaming request. That costs a little quota, which is why
 * the UI tests on demand rather than on load.
 */
router.post('/providers/:id/models/:model/test', async (req, res) => {
    const provider = getProvider(req.params.id);
    if (!provider) {
        return res.status(404).json({
            type: 'error',
            error: { type: 'not_found_error', message: `No provider "${req.params.id}".` }
        });
    }

    const modelId = req.params.model;
    if (!provider.ownsModel(modelId)) {
        return res.status(404).json({
            type: 'error',
            error: { type: 'not_found_error', message: `${provider.id} does not serve "${modelId}".` }
        });
    }

    const startedAt = Date.now();
    try {
        await provider.ensureReady();
        const response = await provider.sendMessage({
            model: modelId,
            max_tokens: TEST_MAX_TOKENS,
            messages: [{ role: 'user', content: TEST_PROMPT }]
        });

        const text = (response?.content || [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();

        res.json({
            ok: true,
            model: modelId,
            durationMs: Date.now() - startedAt,
            // A thinking model can spend the whole budget on thought and return no
            // text; that is a pass, so the reason is reported rather than judged.
            reply: text || null,
            stopReason: response?.stop_reason ?? null,
            usage: response?.usage ?? null
        });
    } catch (error) {
        res.json({
            ok: false,
            model: modelId,
            durationMs: Date.now() - startedAt,
            error: error.message
        });
    }
});

export default router;
