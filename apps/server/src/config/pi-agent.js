/**
 * Pi Agent model config.
 *
 * Pi Agent reads `~/.pi/agent/models.json` and declares each backend as a
 * provider. It talks OpenAI, so the entry points at `/v1/chat/completions` via
 * `"api": "openai-completions"` rather than the Anthropic route.
 *
 * Only this gateway's own provider block is written. Every other provider in the
 * file is preserved untouched, because that file is the user's and usually holds
 * other backends alongside this one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listSelectableModels } from '../combos/resolver.js';
import { logger } from '../utils/logger.js';

/** The provider key this gateway owns in that file. */
export const PI_PROVIDER_KEY = 'krcc';

/** Overridden by tests so they never touch the real config. */
let pathOverride = null;

export function piConfigPath() {
    return pathOverride || path.join(os.homedir(), '.pi', 'agent', 'models.json');
}

/** Point the writer at a different file. Test-only. */
export function __setPiConfigPathForTests(filePath) {
    pathOverride = filePath;
}

/** Read the existing config, tolerating absence and damage. */
export function readPiConfig() {
    const file = piConfigPath();
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            exists: true,
            config: parsed && typeof parsed === 'object' ? parsed : {},
            error: null
        };
    } catch (error) {
        if (error.code === 'ENOENT') return { exists: false, config: {}, error: null };
        // A damaged file is reported rather than silently replaced: overwriting it
        // would destroy the user's other providers.
        return { exists: true, config: null, error: error.message };
    }
}

/**
 * Which models to advertise to Pi Agent.
 *
 * Combos are included: from a client's side a combo is just a model id, and it is
 * a legitimate thing to select.
 */
async function modelEntries() {
    const catalog = await listSelectableModels();

    const models = (catalog.data || []).map((model) => ({
        // Pi Agent keys on `id` and shows `name`.
        id: model.id,
        name: model.id,
        // `text` always; `image` only where the provider actually reports it. Kiro
        // reports nothing here, and Google only in its live catalog, so a model is
        // declared text-only unless proven otherwise — a false claim would make Pi
        // Agent send an image the upstream then rejects.
        input: model.supports_images === true ? ['text', 'image'] : ['text'],
        reasoning: hasReasoning(model)
    }));

    return {
        models,
        // A provider that could not be reached contributes no models. Reported so
        // the caller can say the config is partial instead of the user quietly
        // finding half the catalog missing in Pi Agent.
        unavailable: catalog.unavailable || []
    };
}

/**
 * Whether a model does extended reasoning.
 *
 * The two providers express it differently: Google flags it on the model, while
 * Kiro publishes the reasoning variant as its own id with a `-thinking` suffix.
 * Both are honoured, because reading only one would mislabel the other's models.
 */
function hasReasoning(model) {
    if (model.thinking === true) return true;
    return typeof model.id === 'string' && model.id.endsWith('-thinking');
}

/**
 * Build the provider block for this gateway.
 *
 * @param {{baseUrl: string, apiKey: string}} options
 */
export async function buildPiProvider({ baseUrl, apiKey }) {
    const { models } = await modelEntries();
    return {
        // Pi Agent's OpenAI-compatible transport. The Anthropic route would not be
        // understood by it.
        api: 'openai-completions',
        // Pi Agent sends this as a bearer token. The gateway only checks it when
        // PROXY_API_KEY is set, so a placeholder is fine on loopback.
        apiKey: apiKey || 'dummy',
        baseUrl,
        models
    };
}

/** Which providers could not be listed, so a caller can flag a partial config. */
export async function unavailableProviders() {
    const { unavailable } = await modelEntries();
    return unavailable;
}

/**
 * Merge this gateway's provider into the file, leaving the rest alone.
 *
 * A timestamped backup is written first, mirroring how the Claude Code config is
 * handled, so a bad write is recoverable.
 *
 * @param {{baseUrl: string, apiKey: string}} options
 */
export async function applyPiConfig({ baseUrl, apiKey }) {
    const file = piConfigPath();
    const { exists, config, error } = readPiConfig();

    if (error) {
        return {
            ok: false,
            error: `Refusing to overwrite ${file}: it could not be parsed (${error}). `
                + 'Fix or move the file, then apply again.'
        };
    }

    const next = { ...config };
    next.providers = { ...(next.providers || {}) };
    next.providers[PI_PROVIDER_KEY] = await buildPiProvider({ baseUrl, apiKey });

    let backup = null;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (exists) {
            backup = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
            fs.copyFileSync(file, backup);
        }
        fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    } catch (writeError) {
        logger.error(`[Pi] Could not write ${file}:`, writeError);
        return { ok: false, error: writeError.message };
    }

    return {
        ok: true,
        path: file,
        backup,
        provider: PI_PROVIDER_KEY,
        models: next.providers[PI_PROVIDER_KEY].models.length,
        // Non-empty means the written catalog is missing that provider's models.
        unavailable: await unavailableProviders(),
        // Named so the caller can say what else was left in place.
        otherProviders: Object.keys(next.providers).filter((key) => key !== PI_PROVIDER_KEY)
    };
}

/** Remove this gateway's block, leaving other providers alone. */
export function removePiProvider() {
    const file = piConfigPath();
    const { exists, config, error } = readPiConfig();
    if (!exists || error || !config?.providers?.[PI_PROVIDER_KEY]) {
        return { ok: true, removed: false };
    }

    const next = { ...config, providers: { ...config.providers } };
    delete next.providers[PI_PROVIDER_KEY];
    try {
        fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    } catch (writeError) {
        return { ok: false, removed: false, error: writeError.message };
    }
    return { ok: true, removed: true };
}

export default { readPiConfig, applyPiConfig, buildPiProvider, removePiProvider, piConfigPath };
