/**
 * Provider registry and model resolution.
 *
 * One place that knows which upstreams exist and which one serves a given model
 * id. Routes ask this module, never a provider module directly, so Stage 2 can
 * add Google/Antigravity by appending one entry to PROVIDERS.
 *
 * ## Model id forms
 *
 * Two spellings resolve, and both must keep working:
 *
 *   claude-sonnet-4-5        bare — searched across providers in order
 *   kiro/claude-sonnet-4-5   namespaced — pinned to one provider
 *
 * The bare form is what every existing Claude Code settings.json contains, so it
 * is the compatibility contract: it cannot break. The namespaced form exists to
 * disambiguate once two providers offer models with colliding names (Google will
 * also serve Claude models through Vertex, so this will happen).
 *
 * Ordering in PROVIDERS is therefore load-bearing: it decides who wins a bare id
 * that more than one provider claims. Kiro is first because it is the provider
 * every existing install is already configured against.
 */

import { kiroProvider } from './kiro/provider.js';
import { googleProvider } from './google/provider.js';
import { assertProvider } from './provider.js';

/**
 * Registered providers, in resolution priority order for bare model ids.
 * @type {import('./provider.js').Provider[]}
 */
const PROVIDERS = [kiroProvider, googleProvider].map(assertProvider);

/** Separator between provider namespace and model id. */
const NAMESPACE_SEPARATOR = '/';

/**
 * Every registered provider, in priority order.
 * @returns {import('./provider.js').Provider[]}
 */
export function listProviders() {
    return [...PROVIDERS];
}

/**
 * Look up a provider by its slug.
 * @param {string} id
 * @returns {import('./provider.js').Provider|null}
 */
export function getProvider(id) {
    if (typeof id !== 'string') return null;
    return PROVIDERS.find((p) => p.id === id.trim()) || null;
}

/**
 * Split a possibly-namespaced model id into its parts.
 *
 * `providerId` is set only when the prefix names a registered provider.
 * `prefix` reports the raw text before the first slash regardless, so callers can
 * tell "no namespace at all" apart from "namespace I do not recognise" — the two
 * deserve different errors.
 *
 * A model id that itself contains a slash (Google uses forms like
 * `models/gemini-...`) is therefore left intact rather than being mistaken for a
 * namespace.
 *
 * @param {string} modelId
 * @returns {{ providerId: string|null, bareId: string, prefix: string|null }}
 */
export function parseModelId(modelId) {
    const raw = typeof modelId === 'string' ? modelId.trim() : '';
    const separatorAt = raw.indexOf(NAMESPACE_SEPARATOR);
    if (separatorAt === -1) return { providerId: null, bareId: raw, prefix: null };

    const candidate = raw.slice(0, separatorAt);
    const rest = raw.slice(separatorAt + 1);
    if (rest && getProvider(candidate)) {
        return { providerId: candidate, bareId: rest, prefix: candidate };
    }
    return { providerId: null, bareId: raw, prefix: candidate || null };
}

/**
 * Resolve a model id to the provider that will serve it.
 *
 * @param {string} modelId bare ('claude-sonnet-4-5') or namespaced ('kiro/claude-sonnet-4-5')
 * @returns {{ provider: import('./provider.js').Provider, modelId: string, requestedId: string }}
 *   `modelId` is the bare id to hand the provider, with any namespace stripped.
 * @throws {Error} when the id is empty, names an unknown provider, or no provider claims it
 */
export function resolveModel(modelId) {
    const requestedId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!requestedId) {
        throw new Error('A model id is required.');
    }

    const { providerId, bareId, prefix } = parseModelId(requestedId);
    const known = PROVIDERS.map((p) => p.id).join(', ');

    // Namespaced and the provider exists: honour the pin, and say so plainly
    // when the model does not fit it.
    if (providerId) {
        const provider = getProvider(providerId);
        if (!provider.ownsModel(bareId)) {
            throw new Error(`Provider "${providerId}" does not serve model "${bareId}".`);
        }
        return { provider, modelId: bareId, requestedId };
    }

    // Bare: first provider in priority order that claims it.
    for (const provider of PROVIDERS) {
        if (provider.ownsModel(bareId)) {
            return { provider, modelId: bareId, requestedId };
        }
    }

    // Looked namespaced but the prefix is not a provider we have. Naming the
    // real providers is more useful than calling the whole string a bad model.
    if (prefix) {
        throw new Error(`Unknown provider "${prefix}" in model "${requestedId}". Available providers: ${known}.`);
    }

    throw new Error(`Unknown model "${requestedId}". Call ${'/v1/models'} to list what this proxy serves.`);
}

/**
 * Relative billing weight for a model id, across all providers.
 *
 * Synchronous, so telemetry can price a request at the HTTP boundary without
 * blocking. Returns null for an unknown model so callers report it as unpriced
 * rather than inventing a number.
 *
 * @param {string} modelId
 * @returns {number|null}
 */
export function modelCostMultiplier(modelId) {
    const { providerId, bareId } = parseModelId(modelId);
    if (!bareId) return null;

    if (providerId) {
        const provider = getProvider(providerId);
        return provider ? provider.costMultiplier(bareId) : null;
    }

    for (const provider of PROVIDERS) {
        if (provider.ownsModel(bareId)) return provider.costMultiplier(bareId);
    }
    return null;
}

/**
 * Which provider would serve a model id, without throwing.
 * @param {string} modelId
 * @returns {string|null} provider slug, or null when unresolvable
 */
export function providerIdForModel(modelId) {
    try {
        return resolveModel(modelId).provider.id;
    } catch {
        return null;
    }
}

/**
 * Merged model catalog across every provider.
 *
 * A provider that cannot serve traffic (not signed in, token refresh failed) is
 * skipped rather than failing the whole listing, so one broken upstream does not
 * hide the models you can actually reach. Its reason is returned in `unavailable`
 * so callers can surface it.
 *
 * If *every* provider is unavailable the first error is rethrown — with a single
 * provider registered that is exactly the old behaviour of erroring when Kiro is
 * not authenticated.
 *
 * Each entry gains a `provider` slug and a `namespaced_id`; the bare `id` is left
 * untouched so existing clients keep matching on it. The `object: 'list'`
 * envelope is preserved because `/v1/models` returns this verbatim.
 *
 * @returns {Promise<{ object: 'list', data: object[], unavailable: {provider: string, reason: string}[] }>}
 */
export async function listAllModels() {
    const data = [];
    const unavailable = [];
    let firstError = null;

    for (const provider of PROVIDERS) {
        try {
            await provider.ensureReady();
            const catalog = await provider.listModels();
            for (const model of catalog?.data || []) {
                data.push({
                    ...model,
                    provider: provider.id,
                    provider_label: provider.label,
                    namespaced_id: `${provider.id}${NAMESPACE_SEPARATOR}${model.id}`
                });
            }
        } catch (error) {
            if (!firstError) firstError = error;
            unavailable.push({ provider: provider.id, reason: error.message });
        }
    }

    if (data.length === 0 && firstError) throw firstError;

    return { object: 'list', data, unavailable };
}

export default {
    listProviders,
    getProvider,
    parseModelId,
    resolveModel,
    modelCostMultiplier,
    providerIdForModel,
    listAllModels
};
