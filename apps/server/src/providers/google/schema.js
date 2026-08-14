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
/**
 * Keywords whose value is a map of *caller-chosen names* to schemas. The map
 * itself is not a schema and must never be visited as one.
 */
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];

/** Keywords whose value is a single schema. */
const SCHEMA_VALUES = ['items', 'additionalItems', 'additionalProperties', 'contains', 'not'];

/** Keywords whose value is a list of schemas. */
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];

/**
 * Visit every schema node, and only schema nodes.
 *
 * This has to be keyword-aware rather than walking every object it finds. A
 * `properties` map is keyed by names the tool author chose, and those names
 * collide with JSON Schema keywords: a tool with a property called `items` used to
 * make the generic walk treat the map as a schema, so `ensureObjectType` saw
 * `node.items` and injected `type: "array"` *into the map* — producing a bogus
 * property named `type` whose value was the string `"array"`. Gemini then rejected
 * the entire tool set, naming only `properties[1].value`.
 *
 * Properties named `type`, `enum`, `required`, `const` and so on were corrupted the
 * same way.
 */
function walk(node, visit) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    visit(node);

    for (const keyword of SCHEMA_MAPS) {
        const map = node[keyword];
        if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
        // Values only: the map's keys are names, not keywords.
        for (const child of Object.values(map)) walk(child, visit);
    }

    for (const keyword of SCHEMA_VALUES) {
        const child = node[keyword];
        if (child && typeof child === 'object' && !Array.isArray(child)) walk(child, visit);
        // `items` may also be a tuple of schemas in older drafts.
        else if (Array.isArray(child)) for (const item of child) walk(item, visit);
    }

    for (const keyword of SCHEMA_LISTS) {
        const list = node[keyword];
        if (Array.isArray(list)) for (const item of list) walk(item, visit);
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
/** The scalar types Gemini's Schema accepts. */
const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

/**
 * Coerce a property whose schema is a bare type name.
 *
 * Some tool servers emit `{"properties": {"paths": "array"}}` instead of
 * `{"properties": {"paths": {"type": "array"}}}`. JSON Schema does not allow it,
 * and Gemini rejects the whole request with
 * `Invalid value at ...properties[1].value (...Schema), "array"` — which names an
 * index, not the property, so it is unusually hard to trace back. Coerced here
 * rather than passed on, since the intent is unambiguous.
 *
 * A value that is not a known type name is dropped: there is nothing to salvage,
 * and leaving it in fails the entire tool set rather than one property.
 */
function coercePropertySchemas(schema) {
    walk(schema, (node) => {
        if (!node.properties || typeof node.properties !== 'object') return;
        for (const [key, value] of Object.entries(node.properties)) {
            if (typeof value === 'string') {
                if (SCHEMA_TYPES.has(value)) node.properties[key] = { type: value };
                else delete node.properties[key];
            } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
                // Arrays and primitives are not schemas either.
                delete node.properties[key];
            }
        }
    });
}

/**
 * Give every array an `items`.
 *
 * Gemini's Schema treats `items` as required on an array; without it the
 * declaration is rejected. A permissive string item is the least assuming filler
 * — the alternative is dropping the property, which would silently remove a
 * parameter the tool expects.
 */
function ensureArrayItems(schema) {
    walk(schema, (node) => {
        if (node.type === 'array' && (!node.items || typeof node.items !== 'object')) {
            node.items = { type: 'string' };
        }
    });
}


export function cleanSchemaForGemini(schema) {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
    }

    const cleaned = structuredClone(schema);

    // First: a property that is a bare type name is not a schema at all, and the
    // passes below assume they are walking schemas.
    coercePropertySchemas(cleaned);
    constToEnum(cleaned);
    enumValuesToStrings(cleaned);
    mergeAllOf(cleaned);
    flattenUnions(cleaned);
    flattenTypeArrays(cleaned);
    ensureObjectType(cleaned);
    removeUnsupported(cleaned);
    // After type inference, so an array discovered from `items` is not given a
    // second one.
    ensureArrayItems(cleaned);
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
