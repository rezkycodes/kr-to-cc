/**
 * JSON Schema cleaning for Gemini function declarations.
 *
 * Gemini accepts a narrow subset of JSON Schema. Anthropic clients send full
 * JSON Schema, and Gemini rejects the whole request — not just the offending
 * keyword — when it encounters something unsupported. The failure gives no hint
 * which tool or keyword was at fault, so each transformation below exists because
 * a real request failed without it.
 *
 * Adapted from 9router's `cleanJSONSchemaForAntigravity`
 * (MIT, © 2024-2026 decolua and contributors).
 */

/**
 * Keywords Gemini does not accept anywhere in a schema.
 *
 * Validation constraints (`minLength`, `pattern`, …) are the large group: Gemini
 * has no equivalent, so they are dropped rather than approximated. Losing them
 * means the model is not told about a constraint; the tool implementation still
 * has to validate its own input, which it should be doing regardless.
 */
const UNSUPPORTED_KEYWORDS = [
    '$schema', '$id', '$ref', '$defs', 'definitions', '$comment',
    'additionalProperties', 'unevaluatedProperties', 'patternProperties',
    'minLength', 'maxLength', 'pattern',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains',
    'minProperties', 'maxProperties', 'propertyNames', 'dependentRequired',
    'if', 'then', 'else', 'not', 'readOnly', 'writeOnly', 'deprecated',
    'examples', 'default', 'const', 'oneOf', 'anyOf', 'allOf',
    'format', 'title', 'optional'
];

/** Walk every nested object/array in a schema. */
function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const item of value) walk(item, visit);
        } else if (value && typeof value === 'object') {
            walk(value, visit);
        }
    }
}

/**
 * `const: x` becomes `enum: [x]`.
 * Gemini has no const; a single-value enum expresses the same thing.
 */
function constToEnum(schema) {
    walk(schema, (node) => {
        if ('const' in node && !('enum' in node)) {
            node.enum = [node.const];
        }
    });
}

/**
 * Gemini requires enum values to be strings, even for numbers or booleans.
 * A numeric enum is rejected outright.
 */
function enumValuesToStrings(schema) {
    walk(schema, (node) => {
        if (Array.isArray(node.enum)) {
            node.enum = node.enum.map((v) => (typeof v === 'string' ? v : String(v)));
            // An enum of strings must declare itself a string type.
            if (!node.type) node.type = 'string';
        }
    });
}

/**
 * Merge `allOf` branches into the parent.
 *
 * Shallow on purpose: a deep merge of conflicting branches would invent a schema
 * neither branch described. Later branches win on conflict, matching how most
 * validators resolve it in practice.
 */
function mergeAllOf(schema) {
    walk(schema, (node) => {
        if (!Array.isArray(node.allOf)) return;
        for (const branch of node.allOf) {
            if (!branch || typeof branch !== 'object') continue;
            for (const [key, value] of Object.entries(branch)) {
                if (key === 'properties' && node.properties) {
                    Object.assign(node.properties, value);
                } else if (key === 'required' && Array.isArray(node.required)) {
                    node.required = [...new Set([...node.required, ...value])];
                } else {
                    node[key] = value;
                }
            }
        }
        delete node.allOf;
    });
}

/**
 * Collapse `anyOf`/`oneOf` to their first usable branch.
 *
 * Lossy, and knowingly so: Gemini has no union type. The first branch is the
 * closest single approximation, and a union of "string or null" — by far the most
 * common shape in real tool schemas — collapses to exactly the right thing
 * because the null branch is skipped.
 */
function flattenUnions(schema) {
    walk(schema, (node) => {
        for (const key of ['anyOf', 'oneOf']) {
            if (!Array.isArray(node[key])) continue;
            const branches = node[key].filter(
                (b) => b && typeof b === 'object' && b.type !== 'null'
            );
            const chosen = branches[0];
            delete node[key];
            if (!chosen) continue;
            for (const [k, v] of Object.entries(chosen)) {
                if (!(k in node)) node[k] = v;
            }
        }
    });
}

/**
 * `type: ["string", "null"]` becomes `type: "string"`.
 * Gemini expects a single type; nullability is not expressible.
 */
function flattenTypeArrays(schema) {
    walk(schema, (node) => {
        if (!Array.isArray(node.type)) return;
        const concrete = node.type.find((t) => t !== 'null');
        node.type = concrete || 'string';
    });
}

/**
 * Infer `type: 'object'` where `properties` exists without a type.
 * Gemini requires the type to be explicit and rejects the schema otherwise.
 */
function ensureObjectType(schema) {
    walk(schema, (node) => {
        if (node.properties && typeof node.properties === 'object' && !node.type) {
            node.type = 'object';
        }
        if (node.items && !node.type) {
            node.type = 'array';
        }
    });
}

/** Strip every unsupported keyword, at all depths. */
function removeUnsupported(schema) {
    walk(schema, (node) => {
        for (const keyword of UNSUPPORTED_KEYWORDS) {
            // enum survives: it was already normalised and Gemini accepts it.
            if (keyword === 'const' && Array.isArray(node.enum)) {
                delete node.const;
                continue;
            }
            delete node[keyword];
        }
    });
}

/**
 * Drop `required` entries that name no declared property.
 *
 * Gemini rejects a required field with no matching property — a common leftover
 * after unions are flattened and branches disappear.
 */
function pruneRequired(schema) {
    walk(schema, (node) => {
        if (!Array.isArray(node.required)) return;
        if (!node.properties || typeof node.properties !== 'object') {
            delete node.required;
            return;
        }
        const valid = node.required.filter((field) =>
            Object.prototype.hasOwnProperty.call(node.properties, field)
        );
        if (valid.length === 0) delete node.required;
        else node.required = valid;
    });
}

/**
 * Make a JSON Schema acceptable to Gemini.
 *
 * Order matters: unions are flattened before `required` is pruned, because
 * flattening is what orphans required fields. Unsupported keywords are removed
 * after the structural passes, since those passes read keywords (`const`,
 * `allOf`) that are themselves unsupported.
 *
 * @param {object} schema JSON Schema; not mutated
 * @returns {object} a cleaned deep copy
 */
export function cleanSchemaForGemini(schema) {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
    }

    const cleaned = structuredClone(schema);

    constToEnum(cleaned);
    enumValuesToStrings(cleaned);
    mergeAllOf(cleaned);
    flattenUnions(cleaned);
    flattenTypeArrays(cleaned);
    ensureObjectType(cleaned);
    removeUnsupported(cleaned);
    pruneRequired(cleaned);

    // A function's parameters must be an object schema.
    if (!cleaned.type) cleaned.type = 'object';
    if (cleaned.type === 'object' && !cleaned.properties) cleaned.properties = {};

    return cleaned;
}

/**
 * Sanitize a tool name to Gemini's grammar: `[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}`.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFunctionName(name) {
    if (!name || typeof name !== 'string') return '_unknown';
    let safe = name.replace(/[^a-zA-Z0-9_.:-]/g, '_');
    if (!/^[a-zA-Z_]/.test(safe)) safe = `_${safe}`;
    return safe.slice(0, 64);
}

export default { cleanSchemaForGemini, sanitizeFunctionName };
