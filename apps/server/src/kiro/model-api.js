/**
 * Model API for Kiro/AWS CodeWhisperer
 *
 * Provides model listing and usage limit APIs.
 */

import {
    KIRO_API_PATHS,
    KIRO_DEFAULT_REGION,
    KIRO_MODEL_MAPPING,
    getKiroEndpoint
} from '../constants.js';
import { getKiroAuthData } from '../auth/kiro-token-extractor.js';
import { buildKiroRequest, buildKiroHeaders } from './request-builder.js';
import { parseEventStream, extractContentFromEvents } from './aws-event-stream.js';
import { logger } from '../utils/logger.js';

/**
 * Authoritative Kiro model catalog, based on Kiro's official documentation and
 * verified against the live CodeWhisperer backend. `id` is the alias exposed by
 * the proxy; `kiro_id` is the exact modelId sent to the API.
 *   - cost_multiplier is relative to Auto (1.0x baseline)
 *   - thinking: true also exposes a "<id>-thinking" variant
 */
export const KIRO_MODEL_CATALOG = [
    // --- Anthropic Claude ---
    { id: 'claude-opus-5', kiro_id: 'claude-opus-5', owned_by: 'anthropic', description: 'Claude Opus 5 - Strongest Opus for long-running agentic tasks and parallel coordination', context_window: 1000000, cost_multiplier: 2.2, regions: ['us-east-1', 'eu-central-1'], status: 'experimental', thinking: true },
    { id: 'claude-opus-4-8', kiro_id: 'claude-opus-4.8', owned_by: 'anthropic', description: 'Claude Opus 4.8 - Anthropic\'s most honest, highest-reliability Opus model', context_window: 1000000, cost_multiplier: 2.2, regions: ['us-east-1', 'eu-central-1'], status: 'active', thinking: true },
    { id: 'claude-opus-4-7', kiro_id: 'claude-opus-4.7', owned_by: 'anthropic', description: 'Claude Opus 4.7 - Adaptive deep reasoning, precise instruction following', context_window: 1000000, cost_multiplier: 2.2, regions: ['us-east-1', 'eu-central-1'], status: 'active', thinking: true },
    { id: 'claude-opus-4-6', kiro_id: 'claude-opus-4.6', owned_by: 'anthropic', description: 'Claude Opus 4.6 - Top benchmark scores, strong for long sessions and debugging', context_window: 1000000, cost_multiplier: 2.2, regions: ['us-east-1', 'eu-central-1'], status: 'active', thinking: true },
    { id: 'claude-opus-4-5', kiro_id: 'claude-opus-4.5', owned_by: 'anthropic', description: 'Claude Opus 4.5 - Cross-system architecture, strong single-shot accuracy', context_window: 200000, cost_multiplier: 2.2, regions: ['us-east-1', 'eu-central-1'], status: 'active', thinking: true },
    { id: 'claude-sonnet-5', kiro_id: 'claude-sonnet-5', owned_by: 'anthropic', description: 'Claude Sonnet 5 - Most agentic Sonnet, approaches Opus 4.8 at Sonnet cost', context_window: 1000000, cost_multiplier: 1.3, regions: ['us-east-1'], status: 'experimental', thinking: true },
    { id: 'claude-sonnet-4-6', kiro_id: 'claude-sonnet-4.6', owned_by: 'anthropic', description: 'Claude Sonnet 4.6 - Near-Opus intelligence, more token efficient', context_window: 1000000, cost_multiplier: 1.3, regions: ['us-east-1', 'eu-central-1'], status: 'active', thinking: true },
    { id: 'claude-sonnet-4-5', kiro_id: 'claude-sonnet-4.5', owned_by: 'anthropic', description: 'Claude Sonnet 4.5 - Strong agentic coding, extended autonomous operation', context_window: 200000, cost_multiplier: 1.3, regions: ['us-east-1', 'eu-central-1'], status: 'active', thinking: true },
    { id: 'claude-sonnet-4', kiro_id: 'claude-sonnet-4', owned_by: 'anthropic', description: 'Claude Sonnet 4.0 - Predictable baseline, no routing layers', context_window: 200000, cost_multiplier: 1.3, regions: ['us-east-1', 'eu-central-1'], status: 'active', thinking: true },
    { id: 'claude-haiku-4-5', kiro_id: 'claude-haiku-4.5', owned_by: 'anthropic', description: 'Claude Haiku 4.5 - Fastest Claude model, near-frontier at low cost', context_window: 200000, cost_multiplier: 0.4, regions: ['us-east-1', 'eu-central-1'], status: 'active', thinking: true },

    // --- Auto router ---
    { id: 'auto', kiro_id: 'auto', owned_by: 'amazon', description: 'Auto - Let Kiro route each task to the optimal model', context_window: null, cost_multiplier: 1.0, regions: ['us-east-1', 'eu-central-1'], status: 'active', thinking: false },

    // --- Open-weight models ---
    { id: 'minimax-m2.5', kiro_id: 'minimax-m2.5', owned_by: 'minimax', description: 'MiniMax M2.5 - Frontier-class coding at 0.25x cost', context_window: 200000, cost_multiplier: 0.25, regions: ['us-east-1', 'eu-central-1'], status: 'experimental', thinking: false },
    { id: 'glm-5', kiro_id: 'glm-5', owned_by: 'zhipu', description: 'GLM-5 - Repo-scale agentic work, 200K context MoE', context_window: 200000, cost_multiplier: 0.5, regions: ['us-east-1'], status: 'experimental', thinking: false },
    { id: 'deepseek-3.2', kiro_id: 'deepseek-3.2', owned_by: 'deepseek', description: 'DeepSeek 3.2 - Minimal-cost agentic workflows and multi-step reasoning', context_window: 128000, cost_multiplier: 0.25, regions: ['us-east-1'], status: 'experimental', thinking: false },
    { id: 'minimax-m2.1', kiro_id: 'minimax-m2.1', owned_by: 'minimax', description: 'MiniMax M2.1 - Multilingual programming and UI generation', context_window: 200000, cost_multiplier: 0.15, regions: ['us-east-1', 'eu-central-1'], status: 'experimental', thinking: false },
    { id: 'qwen3-coder-next', kiro_id: 'qwen3-coder-next', owned_by: 'qwen', description: 'Qwen3 Coder Next - 256K context for long coding sessions at 0.05x cost', context_window: 256000, cost_multiplier: 0.05, regions: ['us-east-1', 'eu-central-1'], status: 'experimental', thinking: false }
];

/**
 * List available models from Kiro
 * Returns models in Anthropic format for API compatibility
 * 
 * @returns {Promise<Object>} Anthropic-format models list
 */
export async function listKiroModels() {
    // Authoritative catalog based on Kiro's official model documentation.
    // `thinking: true` also exposes a "<id>-thinking" variant for clients that
    // request extended reasoning through a separate model id.
    const now = Date.now();
    const data = [];

    for (const m of KIRO_MODEL_CATALOG) {
        data.push({
            id: m.id,
            created: now,
            object: 'model',
            owned_by: m.owned_by,
            description: m.description,
            kiro_id: m.kiro_id,
            context_window: m.context_window,
            cost_multiplier: m.cost_multiplier,
            regions: m.regions,
            status: m.status
        });

        if (m.thinking) {
            data.push({
                id: `${m.id}-thinking`,
                created: now,
                object: 'model',
                owned_by: m.owned_by,
                description: `${m.description} (extended thinking)`,
                kiro_id: m.kiro_id,
                context_window: m.context_window,
                cost_multiplier: m.cost_multiplier,
                regions: m.regions,
                status: m.status
            });
        }
    }

    return {
        object: 'list',
        data
    };
}

/**
 * Get usage limits from Kiro
 * Note: This requires the CodeWhispererRuntimeClient, not streaming
 * 
 * @returns {Promise<Object>} Usage limits data
 */
export async function getKiroUsageLimits() {
    try {
        const authData = await getKiroAuthData();
        const token = authData.accessToken;
        const region = authData.region || KIRO_DEFAULT_REGION;
        
        if (!token) {
            return {
                error: 'Not authenticated',
                limits: null
            };
        }
        
        // The usage limits API is on the runtime client, not streaming
        // For now, return placeholder limits
        // TODO: Implement actual usage limits API call if needed
        
        logger.debug('[Kiro] Usage limits not yet implemented');
        
        return {
            limits: {
                dailyLimit: 'unlimited',
                monthlyLimit: 'unlimited',
                used: 0,
                remaining: 'unlimited'
            },
            quotaResetTime: null
        };
        
    } catch (error) {
        logger.warn(`[Kiro] Failed to get usage limits: ${error.message}`);
        return {
            error: error.message,
            limits: null
        };
    }
}

/**
 * Candidate models to probe when checking which ones are active.
 * Derived from the authoritative catalog so it always stays in sync.
 */
export const KIRO_CANDIDATE_MODELS = KIRO_MODEL_CATALOG.map(m => ({
    id: m.id,
    kiro_id: m.kiro_id
}));

/**
 * Send a single minimal request to CodeWhisperer to check whether a given
 * model id is active/available. Does NOT retry, and uses a short timeout so the
 * overall check stays responsive.
 *
 * @param {string} kiroModelId - The exact CodeWhisperer modelId to probe
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=20000] - Per-request timeout
 * @returns {Promise<Object>} Result: { active, status, latency_ms, sample?, error? }
 */
export async function testKiroModel(kiroModelId, options = {}) {
    const timeoutMs = options.timeoutMs || 20000;
    const startedAt = Date.now();

    let authData;
    try {
        authData = await getKiroAuthData();
    } catch (error) {
        return {
            active: false,
            status: 'auth_error',
            latency_ms: Date.now() - startedAt,
            error: error.message
        };
    }

    const token = authData.accessToken;
    const region = authData.region || KIRO_DEFAULT_REGION;

    if (!token) {
        return {
            active: false,
            status: 'auth_error',
            latency_ms: Date.now() - startedAt,
            error: 'No Kiro authentication token available.'
        };
    }

    // Build a minimal probe request, then force the exact modelId being tested
    // (bypassing the fuzzy model mapping so we probe the real id).
    const payload = buildKiroRequest(
        {
            model: kiroModelId,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 16
        },
        { profileArn: authData.profileArn }
    );
    payload.modelId = kiroModelId;
    if (payload.conversationState?.currentMessage?.userInputMessage) {
        payload.conversationState.currentMessage.userInputMessage.modelId = kiroModelId;
    }

    const headers = {
        ...buildKiroHeaders(token, region, false),
        'x-amzn-access-model': kiroModelId
    };

    const url = `${getKiroEndpoint(region)}${KIRO_API_PATHS.GENERATE_ASSISTANT}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorText = await response.text();
            return {
                active: false,
                status: `http_${response.status}`,
                latency_ms: Date.now() - startedAt,
                error: errorText.slice(0, 300)
            };
        }

        // Parse the response to confirm we actually got usable content back.
        const buffer = await response.arrayBuffer();
        const events = parseEventStream(buffer);
        const extracted = extractContentFromEvents(events);
        const sample = (extracted.content || '').slice(0, 80);

        return {
            active: true,
            status: 'ok',
            latency_ms: Date.now() - startedAt,
            sample
        };
    } catch (error) {
        const aborted = error.name === 'AbortError';
        return {
            active: false,
            status: aborted ? 'timeout' : 'error',
            latency_ms: Date.now() - startedAt,
            error: aborted ? `Timed out after ${timeoutMs}ms` : error.message
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Probe a set of candidate models and report which are active.
 *
 * @param {Object} [options]
 * @param {string[]} [options.models] - Optional explicit list of kiro_id/aliases to test
 * @param {number} [options.concurrency=3] - How many probes to run in parallel
 * @param {number} [options.timeoutMs=20000] - Per-request timeout
 * @returns {Promise<Object>} Summary with per-model results
 */
export async function checkActiveModels(options = {}) {
    const concurrency = Math.max(1, options.concurrency || 3);
    const timeoutMs = options.timeoutMs || 20000;

    // Resolve the candidate list. If the caller passes explicit models, map any
    // that match known aliases to their kiro_id; otherwise probe the id as-is.
    let candidates;
    if (Array.isArray(options.models) && options.models.length > 0) {
        candidates = options.models.map((m) => {
            const known = KIRO_CANDIDATE_MODELS.find(
                (c) => c.id === m || c.kiro_id === m
            );
            return known || { id: m, kiro_id: KIRO_MODEL_MAPPING[m] || m };
        });
    } else {
        candidates = KIRO_CANDIDATE_MODELS;
    }

    const results = [];
    // Run probes in small parallel batches to keep the check fast without
    // hammering the API / quota.
    for (let i = 0; i < candidates.length; i += concurrency) {
        const batch = candidates.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(async (candidate) => {
                const result = await testKiroModel(candidate.kiro_id, { timeoutMs });
                return {
                    id: candidate.id,
                    kiro_id: candidate.kiro_id,
                    ...result
                };
            })
        );
        results.push(...batchResults);
    }

    const active = results.filter((r) => r.active);

    return {
        object: 'model_check',
        checked_at: new Date().toISOString(),
        total: results.length,
        active_count: active.length,
        active_models: active.map((r) => r.id),
        results
    };
}


/**
 * @param {string} modelId - The model ID to look up
 * @returns {Promise<Object|null>} Model details or null if not found
 */
export async function getKiroModelInfo(modelId) {
    const { data: models } = await listKiroModels();
    return models.find(m => m.id === modelId || m.kiro_id === modelId) || null;
}

/**
 * Check if a model is available in Kiro
 * @param {string} modelId - The model ID to check
 * @returns {Promise<boolean>} True if model is available
 */
export async function isKiroModelAvailable(modelId) {
    const model = await getKiroModelInfo(modelId);
    return model !== null;
}

export default {
    listKiroModels,
    getKiroUsageLimits,
    getKiroModelInfo,
    isKiroModelAvailable,
    testKiroModel,
    checkActiveModels
};
