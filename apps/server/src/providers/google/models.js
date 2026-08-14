/**
 * Google (Antigravity) model catalog.
 *
 * The live catalog comes from `fetchAvailableModels`, which also reports the
 * account's remaining quota per model. But the provider contract needs a
 * *synchronous* `ownsModel` — it runs on every request and cannot await a network
 * call — so a static seed answers until a live fetch has populated the cache.
 *
 * The seed is the set observed on a real account; the live list supersedes it and
 * may legitimately differ per account and tier.
 */

import {
    ANTIGRAVITY_USER_AGENT,
    ANTIGRAVITY_IDE_VERSION,
    endpoints
} from './constants.js';
import { logger } from '../../utils/logger.js';

/**
 * Models known to exist, used before the live catalog has been fetched.
 *
 * `contextWindow` and `costWeight` are our own annotations. Google publishes no
 * per-token price for this API, so the weight is a coarse relative hint, in the
 * same spirit as Kiro's credit multiplier — not a billing figure.
 */
// Retired ids are deliberately absent: the live catalog reports
// `gemini-3.1-pro-high` as replaced by `gemini-pro-agent`, and the backend rejects
// the old id with a bare "Request contains an invalid argument".
export const GOOGLE_MODEL_SEED = [
    { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)', contextWindow: 1048576, costWeight: 0.5, thinking: true },
    { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)', contextWindow: 1048576, costWeight: 0.4, thinking: true },
    { id: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)', contextWindow: 1048576, costWeight: 0.3, thinking: true },
    { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)', contextWindow: 1048576, costWeight: 1.0, thinking: true },
    { id: 'gemini-pro-agent', label: 'Gemini 3.1 Pro (Agent)', contextWindow: 1048576, costWeight: 1.5, thinking: true },
    { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Medium)', contextWindow: 1048576, costWeight: 0.4, thinking: true },
    { id: 'gemini-3.5-flash-extra-low', label: 'Gemini 3.5 Flash (Low)', contextWindow: 1048576, costWeight: 0.25, thinking: true },
    { id: 'gemini-3-flash', label: 'Gemini 3 Flash', contextWindow: 1048576, costWeight: 0.4, thinking: false },
    { id: 'gemini-3-flash-agent', label: 'Gemini 3.5 Flash (Agent)', contextWindow: 1048576, costWeight: 0.5, thinking: true },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', contextWindow: 1048576, costWeight: 0.15, thinking: false },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1048576, costWeight: 1.5, thinking: true },
    // Claude and open-weight models served through Antigravity. These names also
    // exist on Kiro, which is why the registry namespaces providers.
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', contextWindow: 200000, costWeight: 1.3, thinking: true },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', contextWindow: 200000, costWeight: 2.2, thinking: true },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', contextWindow: 128000, costWeight: 0.3, thinking: false }
];

/**
 * Catalog entries the upstream returns that are not usable as chat models.
 *
 * `tab_*` back the IDE's inline completion and `chat_*` are unnamed internal
 * experiments; neither has a displayName and neither answers a Messages request.
 */
const INTERNAL_ID_PATTERNS = [/^tab_/, /^chat_\d+$/];

function isInternalModel(id, meta) {
    if (INTERNAL_ID_PATTERNS.some((re) => re.test(id))) return true;
    // An entry with no display name is not meant to be user-selectable.
    return !meta?.displayName;
}

/** Live catalog, populated by refreshCatalog(). */
let liveCatalog = null;
/** When the live catalog was fetched, epoch ms. */
let liveFetchedAt = 0;
/** How long a fetched catalog stays fresh. Quota figures move, ids rarely do. */
const CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch the account's real catalog.
 *
 * @param {string} accessToken
 * @param {string} projectId
 * @returns {Promise<{models: object[], defaultModelId: string|null}>}
 */
/**
 * Deprecated id -> its successor, as reported by the catalog.
 *
 * Kept so a request naming a retired model gets told what to use instead of a
 * generic 400 from the upstream.
 */
const replacements = new Map();

/** The successor for a retired model id, or undefined if it is not retired. */
export function replacementFor(modelId) {
    return replacements.get(modelId);
}

export async function fetchAvailableModels(accessToken, projectId) {
    const response = await fetch(endpoints.fetchAvailableModels(), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': ANTIGRAVITY_USER_AGENT,
            // Both are required here; without them the call is rejected.
            'X-Client-Name': 'antigravity',
            'X-Client-Version': ANTIGRAVITY_IDE_VERSION
        },
        // This endpoint wants `project`. Sending `metadata`, as loadCodeAssist
        // does, fails with "Unknown name metadata".
        body: JSON.stringify(projectId ? { project: projectId } : {})
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`fetchAvailableModels failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }

    const payload = await response.json();
    // `models` is a map of id -> metadata, not an array.
    return normalizeCatalogPayload(payload);
}

/**
 * Turn a `fetchAvailableModels` payload into catalog entries.
 *
 * Separated from the request so the parsing — which is where the surprises live —
 * can be tested without a network or an account.
 *
 * @param {object} payload the raw response
 * @returns {{models: object[], defaultModelId: string|null}}
 */
export function normalizeCatalogPayload(payload) {
const raw = payload.models || {};
    const entries = Array.isArray(raw) ? raw.map((m) => [m.modelId, m]) : Object.entries(raw);

    // The catalog names its own retirements and their successors. A deprecated id
    // is still listed in `models` but the backend rejects it with a bare
    // "Request contains an invalid argument", which says nothing about why — so it
    // is dropped here and the replacement remembered for the error message.
    const deprecated = payload.deprecatedModelIds && typeof payload.deprecatedModelIds === 'object'
        ? payload.deprecatedModelIds
        : {};
    for (const [id, info] of Object.entries(deprecated)) {
        replacements.set(id, info?.newModelId || null);
    }

    const models = [];
    for (const [id, meta] of entries) {
        if (Object.hasOwn(deprecated, id)) continue;
        if (isInternalModel(id, meta)) continue;
        models.push({
            id,
            label: meta.displayName || id,
            contextWindow: Number.isFinite(meta.maxTokens) ? meta.maxTokens : null,
            maxOutputTokens: Number.isFinite(meta.maxOutputTokens) ? meta.maxOutputTokens : null,
            thinking: meta.supportsThinking === true,
            supportsImages: meta.supportsImages === true,
            recommended: meta.recommended === true,
            // 1 means untouched, 0 means exhausted. Null when not reported.
            quotaRemaining: Number.isFinite(meta.quotaInfo?.remainingFraction)
                ? meta.quotaInfo.remainingFraction
                : null,
            quotaResetAt: meta.quotaInfo?.resetTime || null,
            costWeight: seedWeight(id)
        });
    }

    return { models, defaultModelId: payload.defaultAgentModelId || null };
}

/** Cost weight from the seed, so live entries keep a comparable figure. */
function seedWeight(id) {
    const seed = GOOGLE_MODEL_SEED.find((m) => m.id === id);
    return seed ? seed.costWeight : null;
}

/**
 * Refresh the cached catalog, ignoring failures.
 *
 * A failed refresh must not break a request: the seed still answers ownsModel, so
 * generation keeps working with a slightly stale model list.
 *
 * @param {string} accessToken
 * @param {string} projectId
 */
export async function refreshCatalog(accessToken, projectId) {
    if (liveCatalog && Date.now() - liveFetchedAt < CATALOG_TTL_MS) return liveCatalog;
    try {
        const { models } = await fetchAvailableModels(accessToken, projectId);
        if (models.length > 0) {
            liveCatalog = models;
            liveFetchedAt = Date.now();
        }
    } catch (error) {
        logger.debug?.(`[Google] Catalog refresh failed, using seed: ${error.message}`);
    }
    return liveCatalog;
}

/** Current best catalog: live when we have one, seed otherwise. */
export function currentCatalog() {
    return liveCatalog || GOOGLE_MODEL_SEED;
}

/**
 * Whether this provider serves a model id. Synchronous by contract.
 *
 * Checks the live catalog when present and always falls back to the seed, so a
 * model the seed knows keeps resolving even if the live fetch dropped it.
 *
 * @param {string} modelId
 * @returns {boolean}
 */
export function ownsModel(modelId) {
    const id = typeof modelId === 'string' ? modelId.trim() : '';
    if (!id) return false;
    if (liveCatalog?.some((m) => m.id === id)) return true;
    return GOOGLE_MODEL_SEED.some((m) => m.id === id);
}

/**
 * Relative cost weight for a model, or null when unknown.
 * @param {string} modelId
 * @returns {number|null}
 */
export function costMultiplier(modelId) {
    const id = typeof modelId === 'string' ? modelId.trim() : '';
    if (!id) return null;
    const found = currentCatalog().find((m) => m.id === id)
        || GOOGLE_MODEL_SEED.find((m) => m.id === id);
    return Number.isFinite(found?.costWeight) ? found.costWeight : null;
}

/**
 * Catalog in the shape `/v1/models` returns.
 * @returns {{object: 'list', data: object[]}}
 */
export function listModels() {
    const now = Date.now();
    return {
        object: 'list',
        data: currentCatalog().map((m) => ({
            id: m.id,
            created: now,
            object: 'model',
            owned_by: m.id.startsWith('claude') ? 'anthropic'
                : m.id.startsWith('gpt') ? 'openai' : 'google',
            description: m.label,
            context_window: m.contextWindow ?? null,
            cost_multiplier: m.costWeight ?? null,
            status: 'active',
            thinking: m.thinking === true,
            // Surfaced so a client config can declare image input honestly rather
            // than guessing. Absent elsewhere, which callers read as text-only.
            supports_images: m.supportsImages === true,
            quota_remaining: m.quotaRemaining ?? null,
            quota_reset_at: m.quotaResetAt ?? null
        }))
    };
}

/** Drop the cached live catalog. Used by tests. */
export function clearCatalogCache() {
    liveCatalog = null;
    liveFetchedAt = 0;
}

export default {
    GOOGLE_MODEL_SEED,
    fetchAvailableModels,
    refreshCatalog,
    currentCatalog,
    ownsModel,
    costMultiplier,
    listModels,
    clearCatalogCache
};
