/**
 * Combo storage and validation.
 *
 * A combo is a named group of models, possibly spanning providers, that clients
 * address as if it were one model. The strategy decides which member serves a
 * given request.
 *
 * Combos live in `~/.config/kiro-proxy/combos.json` next to the other local
 * config. They are user configuration, not state: nothing here is written during
 * a request.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { resolveModel, getProvider } from '../providers/index.js';
import { logger } from '../utils/logger.js';

/**
 * How a combo picks a member.
 *
 * The tradeoffs differ enough that the choice is per combo:
 *  - `failover`      first member that answers. Cheapest; the usual choice.
 *  - `load-balance`  spread requests to stretch several quotas.
 *  - `router`        pick by request shape. Heuristic, see combo-strategies.
 *  - `race`          ask several at once, keep the fastest. Fast, but spends
 *                    quota on every member for one answer.
 */
export const COMBO_STRATEGIES = ['failover', 'load-balance', 'router', 'race'];

/** Namespace combos live under, mirroring the provider namespace. */
export const COMBO_NAMESPACE = 'combo';

/** Names must be safe to embed in a model id. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]{1,2}$/;

/** Overridden by tests so they never touch the real config. */
let storeOverride = null;

function storePath() {
    return storeOverride || path.join(os.homedir(), '.config', 'kiro-proxy', 'combos.json');
}

/**
 * Point the store at a different file. Test-only.
 * @param {string|null} filePath
 */
export function __setStorePathForTests(filePath) {
    storeOverride = filePath;
    cache = null;
}

/** In-process cache; combos change only through this module. */
let cache = null;

/**
 * Read combos from disk.
 * @returns {object[]}
 */
export function listCombos() {
    if (cache) return cache;
    try {
        const file = storePath();
        if (!fs.existsSync(file)) {
            cache = [];
            return cache;
        }
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        cache = Array.isArray(parsed?.combos) ? parsed.combos : [];
    } catch (error) {
        logger.warn?.(`[Combo] Could not read combos, treating as empty: ${error.message}`);
        cache = [];
    }
    return cache;
}

/**
 * Find a combo by name.
 * @param {string} name
 * @returns {object|null}
 */
export function getCombo(name) {
    if (typeof name !== 'string') return null;
    const wanted = name.trim().toLowerCase();
    return listCombos().find((c) => c.name === wanted) || null;
}

/** Persist the current set. */
function persist(combos) {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ combos }, null, 2), { mode: 0o600 });
    cache = combos;
}

/**
 * Check a combo definition, returning every problem found.
 *
 * Collects all problems rather than throwing on the first, so the UI can show a
 * complete list instead of making the user fix them one at a time.
 *
 * @param {object} definition
 * @param {{existingName?: string}} [options] name being replaced, for edits
 * @returns {string[]} empty when valid
 */
export function validateCombo(definition, options = {}) {
    const problems = [];
    const name = typeof definition?.name === 'string' ? definition.name.trim().toLowerCase() : '';

    if (!name) {
        problems.push('A combo name is required.');
    } else if (!NAME_PATTERN.test(name)) {
        problems.push('Name may use lowercase letters, digits, and hyphens, and cannot start or end with a hyphen.');
    } else {
        // A combo that shadows a provider slug would make `provider/model` ambiguous.
        if (getProvider(name)) {
            problems.push(`"${name}" is a provider name; pick something else.`);
        }
        if (name === COMBO_NAMESPACE) {
            problems.push(`"${name}" is reserved.`);
        }
        // A combo that shadows a real model would silently hijack it.
        let shadows = null;
        try {
            shadows = resolveModel(name);
        } catch {
            // Good: nothing else answers to this name.
        }
        if (shadows) {
            problems.push(`"${name}" is already a model on ${shadows.provider.id}; pick another name.`);
        }
        if (name !== options.existingName && getCombo(name)) {
            problems.push(`A combo named "${name}" already exists.`);
        }
    }

    if (!COMBO_STRATEGIES.includes(definition?.strategy)) {
        problems.push(`Strategy must be one of: ${COMBO_STRATEGIES.join(', ')}.`);
    }

    const members = Array.isArray(definition?.members) ? definition.members : [];
    if (members.length === 0) {
        problems.push('A combo needs at least one member model.');
    }

    const seen = new Set();
    for (const member of members) {
        const model = typeof member?.model === 'string' ? member.model.trim() : '';
        if (!model) {
            problems.push('Every member needs a model id.');
            continue;
        }
        if (seen.has(model)) {
            problems.push(`Member "${model}" is listed twice.`);
            continue;
        }
        seen.add(model);

        // Nesting would let a combo reference itself, directly or in a cycle.
        // Forbidding it outright is simpler than detecting cycles, and a flat
        // member list is what makes strategies predictable.
        if (model.startsWith(`${COMBO_NAMESPACE}/`) || getCombo(model)) {
            problems.push(`Member "${model}" is a combo; combos cannot contain other combos.`);
            continue;
        }

        try {
            resolveModel(model);
        } catch (error) {
            problems.push(`Member "${model}" is not a model this proxy serves.`);
        }
    }

    // A single-member race or load-balance is pointless; say so rather than
    // silently behaving like failover.
    if (members.length === 1 && ['race', 'load-balance'].includes(definition?.strategy)) {
        problems.push(`Strategy "${definition.strategy}" needs at least two members.`);
    }

    return problems;
}

/**
 * Create or replace a combo.
 *
 * @param {object} definition {name, strategy, members:[{model}]}
 * @param {{existingName?: string}} [options]
 * @returns {object} the stored combo
 * @throws {Error} listing every validation problem
 */
export function saveCombo(definition, options = {}) {
    const problems = validateCombo(definition, options);
    if (problems.length > 0) {
        throw new Error(problems.join(' '));
    }

    const name = definition.name.trim().toLowerCase();
    const combo = {
        name,
        strategy: definition.strategy,
        members: definition.members.map((m) => ({ model: m.model.trim() })),
        created_at: getCombo(options.existingName || name)?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    const others = listCombos().filter(
        (c) => c.name !== name && c.name !== (options.existingName || '')
    );
    persist([...others, combo]);
    logger.info(`[Combo] Saved "${name}" (${combo.strategy}, ${combo.members.length} members)`);
    return combo;
}

/**
 * Remove a combo.
 * @param {string} name
 * @returns {boolean} whether it existed
 */
export function deleteCombo(name) {
    const wanted = typeof name === 'string' ? name.trim().toLowerCase() : '';
    const combos = listCombos();
    const remaining = combos.filter((c) => c.name !== wanted);
    if (remaining.length === combos.length) return false;
    persist(remaining);
    logger.info(`[Combo] Deleted "${wanted}"`);
    return true;
}

/** Drop the cache so the next read hits disk. Used by tests. */
export function clearCache() {
    cache = null;
}

export default {
    COMBO_STRATEGIES,
    COMBO_NAMESPACE,
    listCombos,
    getCombo,
    validateCombo,
    saveCombo,
    deleteCombo,
    clearCache
};
