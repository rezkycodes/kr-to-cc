/**
 * Anthropic Messages -> Google generateContent.
 *
 * Shape differences that matter:
 *   - Anthropic has a top-level `system`; Gemini has `systemInstruction`.
 *   - Anthropic roles are user/assistant; Gemini uses user/model.
 *   - Anthropic tool_use/tool_result blocks become functionCall/functionResponse
 *     parts, and a tool result must be carried on a *user* turn.
 *   - The whole Gemini request is wrapped in an Antigravity envelope carrying the
 *     project, an IDE-shaped requestId, and a session id.
 *
 * Adapted from 9router (MIT, © 2024-2026 decolua and contributors).
 */

import crypto from 'crypto';

import {
    CLIENT_TOOL_SUFFIX,
    DEFAULT_THOUGHT_SIGNATURE,
    IDE_CONSISTENT_TOOLS,
    IDE_NATIVE_TOOLS,
    MAX_OUTPUT_TOKENS,
    REQUEST_BLACKLIST
} from './constants.js';
import { cleanSchemaForGemini, sanitizeFunctionName } from './schema.js';

/** Deterministic UUIDv5-shaped id from a seed, so retries reuse one identity. */
function uuidFromSeed(seed) {
    const bytes = crypto.createHash('sha256').update(String(seed)).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Build the IDE-shaped request id the backend expects.
 *
 * Format: `agent/{conversation}/{timestamp}/{trajectory}/{step}`. The backend
 * validates the shape, so this is not decorative. Ids are derived from the
 * session so a multi-turn conversation keeps one identity.
 */
function buildRequestId(sessionId, model, contentCount) {
    const conversationId = uuidFromSeed(`antigravity:conversation:${sessionId}`);
    const trajectoryId = uuidFromSeed(`antigravity:trajectory:${sessionId}:${model}`);
    const step = Math.max(1, contentCount * 2 - 1);
    return `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`;
}

/**
 * Stable session id for a conversation.
 *
 * Derived from the first user message so the same conversation maps to the same
 * session across turns without the client having to send anything.
 */
export function deriveSessionId(messages) {
    const first = Array.isArray(messages) ? messages.find((m) => m.role === 'user') : null;
    const seed = typeof first?.content === 'string'
        ? first.content
        : JSON.stringify(first?.content || 'session');
    return uuidFromSeed(`antigravity:session:${seed.slice(0, 512)}`);
}

/** Flatten an Anthropic system value into plain text. */
function systemText(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n\n');
    }
    return '';
}

/**
 * Apply the outbound tool name mapping.
 * @returns {{outbound: (name: string) => string, inbound: Map<string, string>}}
 */
export function buildToolNameMap(tools) {
    const inbound = new Map();
    if (!IDE_CONSISTENT_TOOLS) {
        return { outbound: (name) => sanitizeFunctionName(name), inbound };
    }

    // A client tool whose name the IDE also uses is left alone; anything else is
    // suffixed so the pair is distinguishable. Responses are mapped back.
    for (const tool of tools || []) {
        const name = tool?.name;
        if (!name || IDE_NATIVE_TOOLS.has(name)) continue;
        inbound.set(sanitizeFunctionName(`${name}${CLIENT_TOOL_SUFFIX}`), name);
    }

    return {
        outbound: (name) =>
            IDE_NATIVE_TOOLS.has(name)
                ? sanitizeFunctionName(name)
                : sanitizeFunctionName(`${name}${CLIENT_TOOL_SUFFIX}`),
        inbound
    };
}

/**
 * Convert Anthropic content blocks to Gemini parts.
 * @returns {{parts: object[], hasToolResult: boolean}}
 */
function convertContent(content, mapName, withToolIds) {
    const parts = [];
    let hasToolResult = false;

    if (typeof content === 'string') {
        if (content) parts.push({ text: content });
        return { parts, hasToolResult };
    }

    for (const block of Array.isArray(content) ? content : []) {
        if (!block || typeof block !== 'object') continue;

        switch (block.type) {
            case 'text':
                if (block.text) parts.push({ text: block.text });
                break;

            case 'image': {
                const src = block.source || {};
                if (src.type === 'base64' && src.data) {
                    parts.push({ inlineData: { mimeType: src.media_type || 'image/png', data: src.data } });
                }
                break;
            }

            case 'tool_use':
                parts.push({
                    functionCall: {
                        ...(withToolIds && block.id ? { id: block.id } : {}),
                        name: mapName(block.name),
                        args: block.input || {}
                    },
                    // Gemini 3+ rejects a functionCall with no signature, and the
                    // client never sends one back, so it is always backfilled.
                    thoughtSignature: DEFAULT_THOUGHT_SIGNATURE
                });
                break;

            case 'tool_result': {
                hasToolResult = true;
                const raw = block.content;
                const text = typeof raw === 'string'
                    ? raw
                    : Array.isArray(raw)
                        ? raw.map((c) => (typeof c === 'string' ? c : c?.text || '')).filter(Boolean).join('\n')
                        : JSON.stringify(raw ?? null);
                parts.push({
                    functionResponse: {
                        ...(withToolIds && block.tool_use_id ? { id: block.tool_use_id } : {}),
                        name: block._geminiName || 'tool',
                        response: { result: text }
                    }
                });
                break;
            }

            case 'thinking':
                // Thinking text is not replayable upstream; only the signature
                // matters, and that rides on functionCall parts.
                break;

            default:
                break;
        }
    }

    return { parts, hasToolResult };
}

/**
 * Resolve tool_result blocks back to the tool name they answer.
 *
 * Anthropic references a tool_use by id. Gemini's functionResponse needs the
 * function *name*, so earlier tool_use blocks are indexed first.
 */
function annotateToolResults(messages) {
    const nameById = new Map();
    for (const message of messages || []) {
        for (const block of Array.isArray(message?.content) ? message.content : []) {
            if (block?.type === 'tool_use' && block.id) nameById.set(block.id, block.name);
        }
    }
    for (const message of messages || []) {
        for (const block of Array.isArray(message?.content) ? message.content : []) {
            if (block?.type === 'tool_result' && block.tool_use_id) {
                block._geminiName = nameById.get(block.tool_use_id) || 'tool';
            }
        }
    }
}

/**
 * Build the Gemini `contents` array from Anthropic messages.
 * @returns {object[]}
 */
/**
 * Whether tool call ids should travel with the request.
 *
 * The Antigravity backend fronts three families, and they disagree — all three
 * behaviours were verified live against real accounts:
 *
 *   - `gemini-*` is served by Gemini, which pairs a result with its call by
 *     function *name* and rejects an `id` field outright:
 *     "Request contains an invalid argument".
 *   - `claude-*` is served by Anthropic, which requires `tool_use.id`:
 *     "messages.1.content.0.tool_use.id: Field required".
 *   - `gpt-oss-*` is served by an OpenAI-shaped backend, which requires it too:
 *     "Expected the 'id' of a(n) 'assistant' 'tool_calls' array element to be
 *     populated".
 *
 * So the id is sent by default and withheld only for Gemini. Two of the three
 * known backends need it, which makes sending it the safer default for a family
 * that has not been seen yet.
 */
function sendsToolIds(model) {
    return !(typeof model === 'string' && model.startsWith('gemini'));
}

function buildContents(messages, mapName, withToolIds) {
    annotateToolResults(messages);
    const contents = [];

    for (const message of messages || []) {
        const { parts, hasToolResult } = convertContent(message?.content, mapName, withToolIds);
        if (parts.length === 0) continue;

        // A turn carrying a tool result must be `user`, even when Anthropic
        // labelled it assistant — Claude-backed models reject it otherwise.
        const role = hasToolResult
            ? 'user'
            : message.role === 'assistant' ? 'model' : 'user';

        contents.push({ role, parts });
    }

    return contents;
}

/**
 * Build the Gemini tools declaration.
 *
 * All declarations go in a single `functionDeclarations` group; Gemini expects
 * one group and quietly misbehaves with several.
 */
function buildTools(tools, mapName) {
    if (!Array.isArray(tools) || tools.length === 0) return null;

    const declarations = [];
    const seen = new Set();

    for (const tool of tools) {
        if (!tool?.name) continue;
        const name = mapName(tool.name);
        if (seen.has(name)) continue;
        seen.add(name);

        const schema = tool.input_schema || tool.parameters;
        declarations.push({
            name,
            description: tool.description || '',
            // Gemini rejects a declaration with no parameters object, so an
            // argument-less tool gets a token property instead.
            parameters: schema
                ? cleanSchemaForGemini(schema)
                : {
                    type: 'object',
                    properties: { reason: { type: 'string', description: 'Brief explanation' } },
                    required: ['reason']
                }
        });
    }

    return declarations.length > 0 ? [{ functionDeclarations: declarations }] : null;
}

/**
 * Translate an Anthropic Messages request into the Antigravity request envelope.
 *
 * @param {object} request Anthropic Messages request
 * @param {{projectId: string, stream: boolean}} context
 * @returns {{body: object, toolNames: Map<string, string>}}
 *   `toolNames` maps upstream names back to client names for the response side.
 */
export function buildGoogleRequest(request, context) {
    const model = request.model;
    const { outbound, inbound } = buildToolNameMap(request.tools);

    const contents = buildContents(request.messages, outbound, sendsToolIds(model));
    const tools = buildTools(request.tools, outbound);
    const system = systemText(request.system);
    const sessionId = deriveSessionId(request.messages);

    const generationConfig = {
        // Clamped: the upstream rejects anything larger.
        maxOutputTokens: Math.min(request.max_tokens ?? 4096, MAX_OUTPUT_TOKENS)
    };
    if (Number.isFinite(request.temperature)) generationConfig.temperature = request.temperature;
    if (Number.isFinite(request.top_p)) generationConfig.topP = request.top_p;
    if (Number.isFinite(request.top_k)) generationConfig.topK = request.top_k;

    const inner = {
        contents,
        generationConfig,
        ...(system ? { systemInstruction: { role: 'user', parts: [{ text: system }] } } : {}),
        ...(tools ? { tools, toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } } : {}),
        sessionId
    };

    // Anthropic clients put thinking knobs at the root; Gemini rejects them.
    for (const field of REQUEST_BLACKLIST) delete inner[field];

    return {
        body: {
            project: context.projectId,
            model,
            userAgent: 'antigravity',
            requestType: 'agent',
            requestId: buildRequestId(sessionId, model, contents.length),
            request: inner
        },
        toolNames: inbound
    };
}

export default { buildGoogleRequest, buildToolNameMap, deriveSessionId };
