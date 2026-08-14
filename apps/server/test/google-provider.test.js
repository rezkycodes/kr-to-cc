/**
 * Google (Antigravity) translation.
 *
 * These pin the quirks that cost real debugging: the response envelope, CRLF SSE
 * framing, thinking tokens counting as output, and the schema subset Gemini
 * accepts. Each assertion here corresponds to a request the upstream rejected, or
 * silently answered with nothing, before the code accounted for it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanSchemaForGemini, sanitizeFunctionName } from '../src/providers/google/schema.js';
import {
    GOOGLE_MODEL_SEED,
    normalizeCatalogPayload,
    replacementFor
} from '../src/providers/google/models.js';
import { buildGoogleRequest, deriveSessionId } from '../src/providers/google/request-builder.js';
import {
    convertResponse,
    extractUsage,
    unwrap,
    parseSSE,
    StreamConverter
} from '../src/providers/google/response-converter.js';
import { ownsModel, costMultiplier } from '../src/providers/google/models.js';
import { resolveModel, listProviders } from '../src/providers/index.js';

const ctx = { projectId: 'proj-123', stream: false };

/** Collect an async generator into an array. */
async function collect(gen) {
    const out = [];
    for await (const item of gen) out.push(item);
    return out;
}

/** Turn strings into a byte stream, to exercise the real decoding path. */
async function* byteStream(...chunks) {
    const encoder = new TextEncoder();
    for (const chunk of chunks) yield encoder.encode(chunk);
}

test('sanitizeFunctionName enforces Gemini grammar', () => {
    assert.equal(sanitizeFunctionName('get_weather'), 'get_weather');
    assert.equal(sanitizeFunctionName('mcp__server__do-thing'), 'mcp__server__do-thing');
    // Illegal characters become underscores.
    assert.equal(sanitizeFunctionName('has spaces!'), 'has_spaces_');
    // Must not begin with a digit.
    assert.equal(sanitizeFunctionName('9lives'), '_9lives');
    assert.equal(sanitizeFunctionName(''), '_unknown');
    assert.equal(sanitizeFunctionName(null), '_unknown');
    assert.ok(sanitizeFunctionName('a'.repeat(200)).length <= 64);
});

test('schema cleaner removes what Gemini rejects', () => {
    const cleaned = cleanSchemaForGemini({
        type: 'object',
        properties: {
            name: { type: 'string', minLength: 2, pattern: '^[a-z]+$' },
            count: { type: 'integer', minimum: 0, maximum: 10 }
        },
        required: ['name'],
        additionalProperties: false,
        $schema: 'https://json-schema.org/draft-07/schema#'
    });

    assert.equal(cleaned.additionalProperties, undefined);
    assert.equal(cleaned.$schema, undefined);
    assert.equal(cleaned.properties.name.minLength, undefined);
    assert.equal(cleaned.properties.name.pattern, undefined);
    assert.equal(cleaned.properties.count.minimum, undefined);
    // Structure and required survive.
    assert.equal(cleaned.type, 'object');
    assert.deepEqual(cleaned.required, ['name']);
    assert.equal(cleaned.properties.name.type, 'string');
});

test('schema cleaner normalises unions, const, and enums', () => {
    // "string or null" is the most common union in real tool schemas; it must
    // collapse to the concrete branch, not to null.
    const union = cleanSchemaForGemini({
        type: 'object',
        properties: { note: { anyOf: [{ type: 'null' }, { type: 'string' }] } }
    });
    assert.equal(union.properties.note.type, 'string');
    assert.equal(union.properties.note.anyOf, undefined);

    // type arrays collapse the same way.
    const arrayType = cleanSchemaForGemini({ type: ['string', 'null'] });
    assert.equal(arrayType.type, 'string');

    // const becomes a single-value enum, and enum values become strings.
    const constant = cleanSchemaForGemini({
        type: 'object',
        properties: { mode: { const: 'fast' }, level: { type: 'integer', enum: [1, 2] } }
    });
    assert.deepEqual(constant.properties.mode.enum, ['fast']);
    assert.equal(constant.properties.mode.const, undefined);
    assert.deepEqual(constant.properties.level.enum, ['1', '2'], 'enum values must be strings');

    // allOf merges into the parent.
    const merged = cleanSchemaForGemini({
        allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { required: ['a'] }]
    });
    assert.equal(merged.type, 'object');
    assert.ok(merged.properties.a);
    assert.deepEqual(merged.required, ['a']);
});

test('schema cleaner drops required fields that name no property', () => {
    // Gemini rejects this outright, and it is a common leftover after flattening.
    const cleaned = cleanSchemaForGemini({
        type: 'object',
        properties: { kept: { type: 'string' } },
        required: ['kept', 'vanished']
    });
    assert.deepEqual(cleaned.required, ['kept']);
});

test('schema cleaner does not mutate its input', () => {
    const original = { type: 'object', properties: { a: { type: 'string', minLength: 3 } } };
    const snapshot = structuredClone(original);
    cleanSchemaForGemini(original);
    assert.deepEqual(original, snapshot, 'caller schema must be untouched');
});

test('request envelope carries what the backend validates', () => {
    const { body } = buildGoogleRequest({
        model: 'gemini-3-flash',
        max_tokens: 100,
        system: 'Be terse.',
        messages: [{ role: 'user', content: 'hello' }]
    }, ctx);

    assert.equal(body.project, 'proj-123');
    assert.equal(body.model, 'gemini-3-flash');
    assert.equal(body.userAgent, 'antigravity');
    assert.equal(body.requestType, 'agent');
    // The backend validates this shape, so it is not cosmetic.
    assert.match(body.requestId, /^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/\d+$/);
    assert.ok(body.request.sessionId, 'a session id is required');
    assert.equal(body.request.systemInstruction.parts[0].text, 'Be terse.');
    assert.deepEqual(body.request.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
});

test('max_tokens is clamped to the upstream ceiling', () => {
    const { body } = buildGoogleRequest({
        model: 'gemini-3-flash',
        max_tokens: 999_999,
        messages: [{ role: 'user', content: 'hi' }]
    }, ctx);
    assert.equal(body.request.generationConfig.maxOutputTokens, 64000);
});

test('assistant maps to model, and tool results ride a user turn', () => {
    const { body } = buildGoogleRequest({
        model: 'gemini-3-flash',
        max_tokens: 100,
        messages: [
            { role: 'user', content: 'weather?' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'X' } }] },
            // Anthropic puts a tool result on a user turn already, but the role
            // must survive translation: Claude-backed models reject it otherwise.
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' }] }
        ],
        tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }]
    }, ctx);

    const roles = body.request.contents.map((c) => c.role);
    assert.deepEqual(roles, ['user', 'model', 'user']);

    const call = body.request.contents[1].parts[0];
    assert.ok(call.functionCall, 'tool_use becomes functionCall');
    // Gemini 3+ rejects a functionCall with no signature and clients never send
    // one, so it must always be backfilled.
    assert.ok(call.thoughtSignature, 'signature must be backfilled');

    const result = body.request.contents[2].parts[0];
    assert.ok(result.functionResponse, 'tool_result becomes functionResponse');
    // The name is recovered from the matching tool_use id.
    assert.match(result.functionResponse.name, /get_weather/);
});

test('tools become one declaration group with a usable schema', () => {
    const { body } = buildGoogleRequest({
        model: 'gemini-3-flash',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'go' }],
        tools: [
            { name: 'alpha', input_schema: { type: 'object', properties: { a: { type: 'string' } } } },
            { name: 'beta' }
        ]
    }, ctx);

    // Gemini expects a single group and misbehaves with several.
    assert.equal(body.request.tools.length, 1);
    const declarations = body.request.tools[0].functionDeclarations;
    assert.equal(declarations.length, 2);
    // A tool with no schema still needs a parameters object.
    const beta = declarations.find((d) => d.name.startsWith('beta'));
    assert.equal(beta.parameters.type, 'object');
    assert.ok(Object.keys(beta.parameters.properties).length > 0);
    assert.equal(body.request.toolConfig.functionCallingConfig.mode, 'VALIDATED');
});

test('thinking knobs are stripped from the request', () => {
    const { body } = buildGoogleRequest({
        model: 'gemini-3-flash',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 }
    }, ctx);
    // Google rejects the whole request when these survive.
    for (const field of ['thinking', 'thinkingConfig', 'reasoning', 'reasoning_effort']) {
        assert.equal(body.request[field], undefined, `${field} must be stripped`);
    }
});

test('session id is stable for the same conversation', () => {
    const messages = [{ role: 'user', content: 'same start' }];
    assert.equal(deriveSessionId(messages), deriveSessionId([...messages, { role: 'assistant', content: 'x' }]));
    assert.notEqual(deriveSessionId(messages), deriveSessionId([{ role: 'user', content: 'different' }]));
});

test('the Cloud Code response envelope is unwrapped', () => {
    // Generation replies nest the payload under `response`, unlike the public API.
    const wrapped = { response: { candidates: [{ content: {} }] }, traceId: 'abc' };
    assert.ok(unwrap(wrapped).candidates, 'must read through the wrapper');
    // A bare payload still works.
    assert.ok(unwrap({ candidates: [] }).candidates);
    assert.deepEqual(unwrap(null), {});
});

test('thinking tokens count as output', () => {
    // A request can spend everything on thought and emit no text. Ignoring
    // thoughtsTokenCount would report that as zero output.
    const usage = extractUsage({
        response: {
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 6, thoughtsTokenCount: 90 }
        }
    });
    assert.equal(usage.input_tokens, 7);
    assert.equal(usage.output_tokens, 96, 'visible + thinking');
    assert.equal(usage.thinking_tokens, 90);
    // Google reports cache hits, so absent means a real zero, not unknown.
    assert.equal(usage.cached_tokens, 0);

    assert.equal(extractUsage({ response: {} }), null);
});

test('a complete response becomes an Anthropic message', () => {
    const anthropic = convertResponse({
        response: {
            candidates: [{
                content: { role: 'model', parts: [{ text: 'HELLO' }] },
                finishReason: 'STOP'
            }],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 }
        }
    }, { model: 'gemini-3-flash' });

    assert.equal(anthropic.type, 'message');
    assert.equal(anthropic.role, 'assistant');
    assert.equal(anthropic.stop_reason, 'end_turn');
    assert.deepEqual(anthropic.content, [{ type: 'text', text: 'HELLO' }]);
    assert.equal(anthropic.usage.input_tokens, 3);
});

test('a tool call sets stop_reason tool_use and restores the client name', () => {
    const toolNames = new Map([['get_weather_ide', 'get_weather']]);
    const anthropic = convertResponse({
        response: {
            candidates: [{
                content: { parts: [{ functionCall: { name: 'get_weather_ide', args: { city: 'Jakarta' } } }] },
                finishReason: 'STOP'
            }]
        }
    }, { model: 'gemini-3-flash', toolNames });

    assert.equal(anthropic.stop_reason, 'tool_use');
    const block = anthropic.content[0];
    assert.equal(block.type, 'tool_use');
    // The client must never see the upstream-facing name.
    assert.equal(block.name, 'get_weather');
    assert.deepEqual(block.input, { city: 'Jakarta' });
});

test('MAX_TOKENS maps to the Anthropic stop reason', () => {
    const anthropic = convertResponse({
        response: { candidates: [{ content: {}, finishReason: 'MAX_TOKENS' }] }
    }, { model: 'gemini-3-flash' });
    assert.equal(anthropic.stop_reason, 'max_tokens');
    assert.deepEqual(anthropic.content, [], 'no parts means no content blocks');
});

test('SSE frames separated by CRLF are parsed', async () => {
    // This upstream uses \r\n\r\n. Splitting only on \n\n yields nothing, which
    // looks like an empty stream rather than a parsing bug.
    const frame = (text) =>
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text }] } }] } })}\r\n\r\n`;

    const chunks = await collect(parseSSE(byteStream(frame('one'), frame('two'))));
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].response.candidates[0].content.parts[0].text, 'one');

    // Bare \n\n must still work.
    const lf = await collect(parseSSE(byteStream('data: {"a":1}\n\n')));
    assert.deepEqual(lf, [{ a: 1 }]);
});

test('SSE parsing survives frames split across reads', async () => {
    const payload = JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'split' }] } }] } });
    const half = Math.floor(payload.length / 2);
    const chunks = await collect(parseSSE(byteStream(
        `data: ${payload.slice(0, half)}`,
        `${payload.slice(half)}\r\n\r\n`
    )));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].response.candidates[0].content.parts[0].text, 'split');
});

test('the stream converter emits a well-formed Anthropic sequence', async () => {
    const converter = new StreamConverter({ model: 'gemini-3-flash' });
    const events = [];
    for (const chunk of [
        { response: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] } },
        { response: { candidates: [{ content: { parts: [{ text: ' there' }] } }] } },
        { response: { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } } }
    ]) {
        for (const event of converter.convertChunk(chunk)) events.push(event);
    }
    for (const event of converter.finish()) events.push(event);

    const types = events.map((e) => e.type);
    assert.equal(types[0], 'message_start');
    assert.equal(types.at(-1), 'message_stop');
    assert.equal(types.at(-2), 'message_delta');

    // Exactly one text block opened and closed, however many deltas arrived.
    assert.equal(types.filter((t) => t === 'content_block_start').length, 1);
    assert.equal(types.filter((t) => t === 'content_block_stop').length, 1);

    const text = events
        .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
        .map((e) => e.delta.text).join('');
    assert.equal(text, 'Hi there');

    const final = events.at(-2);
    assert.equal(final.usage.input_tokens, 2);
});

test('a streamed tool call is opened, filled, and closed', async () => {
    const converter = new StreamConverter({ model: 'gemini-3-flash' });
    const events = [];
    for (const event of converter.convertChunk({
        response: { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }] } }] }
    })) events.push(event);

    const start = events.find((e) => e.type === 'content_block_start');
    assert.equal(start.content_block.type, 'tool_use');
    assert.equal(start.content_block.name, 'lookup');

    // Anthropic streams tool arguments as partial JSON.
    const delta = events.find((e) => e.delta?.type === 'input_json_delta');
    assert.deepEqual(JSON.parse(delta.partial_json ?? delta.delta.partial_json), { q: 'x' });
    assert.ok(events.some((e) => e.type === 'content_block_stop'), 'block must be closed');
});

test('finish() closes an open block even with no chunks', async () => {
    // A client disconnect must not leave a block unterminated.
    const converter = new StreamConverter({ model: 'gemini-3-flash' });
    const events = [...converter.finish()];
    assert.equal(events[0].type, 'message_start');
    assert.equal(events.at(-1).type, 'message_stop');
});

test('google owns its catalog and prices it', () => {
    assert.ok(ownsModel('gemini-3-flash'));
    assert.ok(ownsModel('gemini-3.6-flash-high'));
    assert.ok(ownsModel('gpt-oss-120b-medium'));
    assert.equal(ownsModel('claude-opus-4-8'), false, 'that is a Kiro model');
    assert.equal(ownsModel(''), false);
    assert.equal(typeof costMultiplier('gemini-3-flash'), 'number');
    assert.equal(costMultiplier('not-a-model'), null);
});

test('a model on both providers resolves by namespace, bare stays on Kiro', () => {
    assert.deepEqual(listProviders().map((p) => p.id), ['kiro', 'google']);

    // The compatibility contract: an existing settings.json holds the bare id and
    // must keep reaching the provider it always did.
    assert.equal(resolveModel('claude-sonnet-4-6').provider.id, 'kiro');
    assert.equal(resolveModel('kiro/claude-sonnet-4-6').provider.id, 'kiro');
    assert.equal(resolveModel('google/claude-sonnet-4-6').provider.id, 'google');

    // Google-only models need no namespace.
    assert.equal(resolveModel('gemini-3-flash').provider.id, 'google');
    assert.equal(resolveModel('google/gemini-3-flash').modelId, 'gemini-3-flash');
});

test('Google quota is reported per account, per model', async () => {
    // Google meters per model, but each account holds its own set of allowances.
    // Merging them would invent a total no single account has, so the shape keeps
    // them separate.
    const { getGoogleAccountQuotas } = await import('../src/providers/google/usage.js');
    const accounts = await getGoogleAccountQuotas();

    assert.ok(Array.isArray(accounts));
    for (const account of accounts) {
        assert.equal(typeof account.connectionId, 'string');
        assert.equal(typeof account.label, 'string');
        // An account that cannot report says why rather than showing zeros, which
        // would read as "quota exhausted" instead of "unknown".
        if (account.error) {
            assert.deepEqual(account.models, {});
        } else {
            for (const [modelId, quota] of Object.entries(account.models)) {
                assert.ok(modelId.length > 0);
                assert.ok(quota.remainingFraction >= 0 && quota.remainingFraction <= 1);
                if (quota.resetAt !== null) {
                    assert.ok(!Number.isNaN(new Date(quota.resetAt).getTime()));
                }
            }
        }
    }
});

test('tool call ids travel with Anthropic- and OpenAI-backed models, not Gemini', () => {
    // The Antigravity backend fronts three families that disagree about this, all
    // confirmed live: Gemini rejects an `id` field outright, while Anthropic and
    // the OpenAI-shaped backend both refuse the turn without one.
    const conversation = {
        max_tokens: 128,
        tools: [{ name: 'get_time', input_schema: { type: 'object', properties: {} } }],
        messages: [
            { role: 'user', content: 'time?' },
            {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_x1', name: 'get_time', input: {} }]
            },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_x1', content: '06:40' }]
            }
        ]
    };

    const partsFor = (model) => {
        const { body } = buildGoogleRequest({ ...conversation, model }, { projectId: 'p' });
        const contents = body.request.contents;
        return {
            call: contents.flatMap((c) => c.parts).find((p) => p.functionCall)?.functionCall,
            result: contents.flatMap((c) => c.parts).find((p) => p.functionResponse)?.functionResponse
        };
    };

    for (const model of ['claude-sonnet-4-6', 'gpt-oss-120b-medium']) {
        const { call, result } = partsFor(model);
        assert.equal(call.id, 'toolu_x1', `${model} must carry the tool_use id`);
        assert.equal(result.id, 'toolu_x1', `${model} must carry the tool_result id`);
    }

    for (const model of ['gemini-3-flash', 'gemini-pro-agent']) {
        const { call, result } = partsFor(model);
        assert.equal(call.id, undefined, `${model} must not carry an id`);
        assert.equal(result.id, undefined, `${model} must not carry an id`);
        // The name is what Gemini pairs on, so it still has to be there.
        assert.ok(call.name, 'the function name is required for Gemini');
        assert.ok(result.name, 'the response name is required for Gemini');
    }
});

test('a property given as a bare type name is coerced, not passed on', () => {
    // Some tool servers emit {"paths": "array"} instead of {"paths": {"type":"array"}}.
    // Gemini rejects the whole request with an index-based path that is hard to
    // trace, so the intent is honoured here instead.
    const cleaned = cleanSchemaForGemini({
        type: 'object',
        properties: { path: { type: 'string' }, globs: 'array' }
    });

    assert.deepEqual(cleaned.properties.globs, { type: 'array', items: { type: 'string' } });
    assert.deepEqual(cleaned.properties.path, { type: 'string' });
});

test('a property that is not a schema at all is dropped, and required follows', () => {
    // Nothing can be salvaged from these, and leaving one in fails the whole tool
    // set rather than the single property.
    const cleaned = cleanSchemaForGemini({
        type: 'object',
        properties: { junk: 'not-a-type', list: ['x'], nothing: null, keep: { type: 'string' } },
        required: ['junk', 'keep']
    });

    assert.deepEqual(Object.keys(cleaned.properties), ['keep']);
    // A required entry naming a dropped property would be rejected upstream.
    assert.deepEqual(cleaned.required, ['keep']);
});

test('an array always ends up with items', () => {
    // Gemini treats items as required on an array and rejects the declaration
    // without it.
    const cleaned = cleanSchemaForGemini({
        type: 'object',
        properties: {
            bare: { type: 'array' },
            typed: { type: 'array', items: { type: 'number' } }
        }
    });

    assert.deepEqual(cleaned.properties.bare.items, { type: 'string' });
    // An existing items is left alone rather than replaced.
    assert.deepEqual(cleaned.properties.typed.items, { type: 'number' });
});

test('the coercion reaches nested properties', () => {
    const cleaned = cleanSchemaForGemini({
        type: 'object',
        properties: {
            outer: { type: 'object', properties: { inner: 'array' } }
        }
    });

    assert.deepEqual(cleaned.properties.outer.properties.inner, {
        type: 'array',
        items: { type: 'string' }
    });
});

test('a property named after a JSON Schema keyword is not corrupted', () => {
    // This was the real failure. `properties` is keyed by names the tool author
    // chose, and a generic walk treated the map as a schema: it saw `.items` (the
    // property!), decided the map was an array, and injected `type: "array"` into
    // it. Gemini then rejected the entire tool set, naming only
    // `properties[1].value` — impossible to trace back from the message.
    const cleaned = cleanSchemaForGemini({
        type: 'object',
        properties: {
            items: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of items'
            }
        },
        required: ['items']
    });

    assert.deepEqual(Object.keys(cleaned.properties), ['items']);
    // No injected sibling.
    assert.equal(cleaned.properties.type, undefined);
    assert.equal(cleaned.properties.items.type, 'array');
    assert.deepEqual(cleaned.required, ['items']);
});

test('every schema keyword is safe to use as a property name', () => {
    // Each of these previously risked a pass mistaking the properties map for a
    // schema and rewriting it.
    const names = ['type', 'items', 'enum', 'required', 'const', 'anyOf', 'oneOf', 'allOf', 'properties'];
    const properties = {};
    for (const name of names) properties[name] = { type: 'string', description: name };

    const cleaned = cleanSchemaForGemini({ type: 'object', properties, required: [...names] });

    assert.deepEqual(Object.keys(cleaned.properties).sort(), [...names].sort());
    for (const name of names) {
        assert.equal(cleaned.properties[name].type, 'string', `${name} should survive intact`);
    }
    assert.deepEqual(cleaned.required.sort(), [...names].sort());
});

test('cleaning still reaches schemas nested under keyword-named properties', () => {
    // The walk must be keyword-aware without becoming shallow: a union inside a
    // property named `items` still has to be flattened.
    const cleaned = cleanSchemaForGemini({
        type: 'object',
        properties: {
            items: {
                type: 'array',
                items: { type: ['string', 'null'] }
            }
        }
    });

    assert.equal(cleaned.properties.items.items.type, 'string');
});

test('a retired model is dropped from the catalog and its successor recorded', () => {
    // The catalog lists retirements in `deprecatedModelIds` while still including
    // the old id under `models`. The backend then rejects it with a bare
    // "Request contains an invalid argument", so offering it is worse than useless.
    const payload = {
        models: {
            'gemini-3.1-pro-high': { displayName: 'Gemini 3.1 Pro (High)', maxTokens: 100 },
            'gemini-pro-agent': { displayName: 'Gemini Pro Agent', maxTokens: 100 }
        },
        deprecatedModelIds: {
            'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' }
        }
    };

    const { models } = normalizeCatalogPayload(payload);
    const ids = models.map((m) => m.id);

    assert.equal(ids.includes('gemini-3.1-pro-high'), false, 'retired id must not be offered');
    assert.equal(ids.includes('gemini-pro-agent'), true, 'its successor must still be listed');
    // Remembered so a request naming the old id can be told what to use instead.
    assert.equal(replacementFor('gemini-3.1-pro-high'), 'gemini-pro-agent');
});

test('the seed catalog does not offer the retired id either', () => {
    // The seed is used whenever the live catalog cannot load, so leaving it there
    // would reintroduce the failure exactly when the account is having trouble.
    assert.equal(GOOGLE_MODEL_SEED.some((m) => m.id === 'gemini-3.1-pro-high'), false);
});
