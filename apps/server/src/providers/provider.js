/**
 * Provider contract.
 *
 * A provider is one upstream that can serve an Anthropic Messages request. Kiro
 * (AWS CodeWhisperer) is the first; Google Cloud Code (Antigravity / Gemini CLI
 * credentials) is the second. Everything above this layer — routes, telemetry,
 * the model registry, and later the combo resolver — talks only through this
 * shape, so adding an upstream never means touching a route handler.
 *
 * Two rules keep providers interchangeable:
 *
 *  1. Providers speak Anthropic. `sendMessage` returns an Anthropic Messages
 *     response and `sendMessageStream` yields Anthropic SSE event objects. Any
 *     translation to and from the upstream's own dialect belongs inside the
 *     provider, not in the caller.
 *  2. Providers own their auth. `ensureReady()` is the single gate a route calls
 *     before dispatching, and it throws a message meant for a human when the
 *     upstream is not usable.
 */

/**
 * @typedef {object} ModelDescriptor
 * @property {string} id            Model id as exposed by this proxy, without a provider prefix.
 * @property {string} owned_by      Originating vendor, e.g. 'anthropic', 'google'.
 * @property {string} [description] One-line human description.
 * @property {number|null} [context_window] Context size in tokens, null when unknown.
 * @property {number|null} [cost_multiplier] Relative billing weight, null when unpriced.
 * @property {string} [status]      'active' | 'experimental' | 'deprecated'.
 * @property {boolean} [thinking]   True when a '<id>-thinking' variant is also served.
 */

/**
 * @typedef {object} Provider
 * @property {string} id       Stable short slug used as the model namespace, e.g. 'kiro'.
 * @property {string} label    Human-facing name, e.g. 'Kiro (AWS CodeWhisperer)'.
 * @property {() => Promise<void>} ensureReady
 *   Resolve when the provider can serve traffic. Throw an Error whose message is
 *   safe and useful to show a user when it cannot (not signed in, no database,
 *   token refresh failed). Called before every dispatch.
 * @property {() => Promise<{ data: ModelDescriptor[] }>} listModels
 *   Catalog for this provider, in the shape `/v1/models` returns.
 * @property {(request: object) => Promise<object>} sendMessage
 *   Non-streaming completion. Returns an Anthropic Messages response.
 * @property {(request: object) => AsyncGenerator<object>} sendMessageStream
 *   Streaming completion. Yields Anthropic SSE event objects in order.
 * @property {(modelId: string) => boolean} ownsModel
 *   Whether this provider serves the given bare model id. Must be synchronous:
 *   it runs on every request, so it answers from a static or cached catalog
 *   rather than probing the upstream.
 * @property {(modelId: string) => number|null} costMultiplier
 *   Relative billing weight for a model id, or null when the model is unknown to
 *   this provider. Must be synchronous so telemetry can price without blocking.
 * @property {() => Promise<object>} [checkActiveModels]
 *   Optional live probe of which models actually answer for this account.
 */

/** Methods every provider must implement. */
const REQUIRED_METHODS = [
    'ensureReady',
    'listModels',
    'sendMessage',
    'sendMessageStream',
    'ownsModel',
    'costMultiplier'
];

/** Fields every provider must declare. */
const REQUIRED_FIELDS = ['id', 'label'];

/**
 * Assert that an object satisfies the provider contract.
 *
 * Called by the registry at load time so a malformed provider fails loudly at
 * startup rather than on the first request that happens to route to it.
 *
 * @param {unknown} candidate
 * @returns {Provider} the same object, when valid
 * @throws {Error} listing everything that is missing
 */
export function assertProvider(candidate) {
    const problems = [];

    if (!candidate || typeof candidate !== 'object') {
        throw new Error('Provider must be an object');
    }

    for (const field of REQUIRED_FIELDS) {
        const value = candidate[field];
        if (typeof value !== 'string' || value.trim() === '') {
            problems.push(`${field} must be a non-empty string`);
        }
    }

    // The namespace ends up in a model id, so keep it URL- and prefix-safe.
    if (typeof candidate.id === 'string' && !/^[a-z0-9-]+$/.test(candidate.id)) {
        problems.push('id must contain only lowercase letters, digits, and hyphens');
    }

    for (const method of REQUIRED_METHODS) {
        if (typeof candidate[method] !== 'function') {
            problems.push(`${method}() is missing`);
        }
    }

    if (candidate.checkActiveModels != null && typeof candidate.checkActiveModels !== 'function') {
        problems.push('checkActiveModels must be a function when present');
    }

    if (problems.length > 0) {
        const name = typeof candidate.id === 'string' ? candidate.id : '<unnamed>';
        throw new Error(`Invalid provider "${name}": ${problems.join('; ')}`);
    }

    return /** @type {Provider} */ (candidate);
}

export default { assertProvider };
