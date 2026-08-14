/**
 * Target resolution.
 *
 * One entry point the routes use to answer "what serves this model id?". The
 * answer is either a single provider/model pair or a combo with its members
 * already resolved.
 *
 * Combos are checked before single models, but a combo may not take a name a real
 * model already uses — the store rejects that — so the order cannot hijack an
 * existing model.
 */

import { listAllModels, resolveModel } from '../providers/index.js';
import { COMBO_NAMESPACE, getCombo, listCombos } from './store.js';

/**
 * @typedef {object} SingleTarget
 * @property {'single'} kind
 * @property {object} provider
 * @property {string} modelId
 * @property {string} requestedId
 *
 * @typedef {object} ComboTarget
 * @property {'combo'} kind
 * @property {object} combo
 * @property {{provider: object, modelId: string}[]} plan members in listed order
 * @property {string} requestedId
 */

/**
 * Strip the combo namespace, if present.
 * @param {string} modelId
 * @returns {{name: string, explicit: boolean}}
 */
function parseComboId(modelId) {
    const raw = typeof modelId === 'string' ? modelId.trim() : '';
    const prefix = `${COMBO_NAMESPACE}/`;
    if (raw.startsWith(prefix)) {
        return { name: raw.slice(prefix.length).toLowerCase(), explicit: true };
    }
    return { name: raw.toLowerCase(), explicit: false };
}

/**
 * Resolve a model id to whatever will serve it.
 *
 * @param {string} modelId bare model, `provider/model`, combo name, or `combo/name`
 * @returns {SingleTarget|ComboTarget}
 * @throws {Error} when nothing serves the id, or a combo has no usable member
 */
export function resolveTarget(modelId) {
    const requestedId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!requestedId) {
        throw new Error('A model id is required.');
    }

    const { name, explicit } = parseComboId(requestedId);
    const combo = getCombo(name);

    if (combo) {
        const plan = [];
        const broken = [];
        for (const member of combo.members) {
            try {
                const { provider, modelId: resolved } = resolveModel(member.model);
                plan.push({ provider, modelId: resolved });
            } catch (error) {
                // A member can stop resolving after the fact — a provider was
                // removed, or a catalog changed. Skip it and carry on rather than
                // failing a combo that still has working members.
                broken.push(`${member.model} (${error.message})`);
            }
        }

        if (plan.length === 0) {
            throw new Error(
                `Combo "${combo.name}" has no usable members. ${broken.join('; ')}`
            );
        }

        return { kind: 'combo', combo, plan, requestedId };
    }

    if (explicit) {
        // Named the combo namespace but no such combo exists; do not fall through
        // to model resolution, which would give a confusing error.
        throw new Error(`Unknown combo "${name}". Manage combos at /config/claude.`);
    }

    const { provider, modelId: resolved } = resolveModel(requestedId);
    return { kind: 'single', provider, modelId: resolved, requestedId };
}

/**
 * Combos in the shape `/v1/models` returns.
 *
 * A combo is presented as a model so clients can select it without knowing it is
 * a group. `members` is included so the listing is self-explanatory.
 *
 * @param {object[]} combos
 * @returns {object[]}
 */
export function comboModelEntries(combos) {
    const now = Date.now();
    return combos.map((combo) => {
        const resolvable = combo.members.filter((m) => {
            try {
                resolveModel(m.model);
                return true;
            } catch {
                return false;
            }
        });

        return {
            id: combo.name,
            created: now,
            object: 'model',
            owned_by: 'combo',
            description: `Combo (${combo.strategy}): ${combo.members.map((m) => m.model).join(', ')}`,
            context_window: null,
            // A combo's cost depends on which member answers, so no single figure
            // is honest here.
            cost_multiplier: null,
            status: resolvable.length === combo.members.length ? 'active' : 'degraded',
            thinking: false,
            provider: COMBO_NAMESPACE,
            provider_label: 'Combo',
            namespaced_id: `${COMBO_NAMESPACE}/${combo.name}`,
            combo: {
                strategy: combo.strategy,
                members: combo.members.map((m) => m.model),
                unresolved: combo.members.length - resolvable.length
            }
        };
    });
}

export default { resolveTarget, comboModelEntries };

/**
 * Everything a client may put in a `model` field: every provider's catalog plus
 * the combos, which are presented as models so a client can select one without
 * knowing it is a group.
 *
 * Both `/v1/models` and the Configure page read from here. They used to merge
 * combos separately and the Configure page was missed, so combos could be created
 * but not chosen — this exists so the two cannot drift apart again.
 */
export async function listSelectableModels() {
    const models = await listAllModels();
    const combos = comboModelEntries(listCombos());
    if (combos.length > 0) models.data = [...models.data, ...combos];
    return models;
}
