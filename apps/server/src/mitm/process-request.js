/**
 * Core request processing — shared between Express routes and MITM handler.
 *
 * Extracted from api.routes.js so the MITM proxy can reuse the same
 * validation → resolution → dispatch → streaming pipeline without
 * duplicating code or making internal HTTP round-trips.
 */

import { resolveTarget } from '../combos/resolver.js';
import { runOnce, runStream } from '../combos/strategies.js';
import { logger } from '../utils/logger.js';

/** Default model when none is specified. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5';

/**
 * Validate an Anthropic Messages request body.
 * @returns {string|null} error message, or null if valid.
 */
export function validateMessagesRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return 'request body must be a JSON object';
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return 'messages is required and must be a non-empty array';
    }
    if (body.max_tokens !== undefined
        && (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0)) {
        return 'max_tokens must be a positive integer';
    }
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
        return 'stream must be a boolean';
    }
    if (body.tools !== undefined) {
        if (!Array.isArray(body.tools)) return 'tools must be an array';
        if (body.tools.length > 128) return 'tools may contain at most 128 entries';
        for (const tool of body.tools) {
            if (!tool || typeof tool.name !== 'string'
                || !tool.name.trim() || tool.name.length > 256) {
                return 'each tool must have a valid name';
            }
            if (!tool.input_schema || typeof tool.input_schema !== 'object'
                || Array.isArray(tool.input_schema)) {
                return `tool ${tool.name} must have an object input_schema`;
            }
        }
    }
    return null;
}

/**
 * Parse an upstream error into a user-facing Anthropic error envelope.
 */
export function parseError(error) {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message;

    if (error.message.includes('401') || error.message.includes('UNAUTHENTICATED')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage = 'Authentication failed. Make sure Kiro CLI is authenticated.';
    } else if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('QUOTA_EXHAUSTED')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const resetMatch = error.message.match(/quota will reset after (\d+h\d+m\d+s|\d+m\d+s|\d+s)/i);
        const modelMatch = error.message.match(/"model":\s*"([^"]+)"/);
        const model = modelMatch ? modelMatch[1] : 'the model';
        if (resetMatch) {
            errorMessage = `You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
        } else {
            errorMessage = `You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
        }
    } else if (error.statusCode === 400
        || error.message.includes('Kiro API error 400')
        || error.message.includes('REQUEST_BODY_INVALID')
        || error.message.includes('invalid_request_error')
        || error.message.includes('INVALID_ARGUMENT')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = error.message.match(/"message":"([^"]+)"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = 'Permission denied. Check your Kiro CLI authentication.';
    }

    return { errorType, statusCode, errorMessage };
}

/**
 * Dispatch a non-streaming request through a resolved target.
 */
async function sendFrom(target, request) {
    if (target.kind === 'single') {
        const response = await target.provider.sendMessage(request);
        return { response, servedBy: { provider: target.provider.id, model: target.modelId } };
    }

    const { result, target: member } = await runOnce(
        target.combo,
        target.plan,
        request,
        async (candidate) => {
            await candidate.provider.ensureReady();
            return candidate.provider.sendMessage({ ...request, model: candidate.modelId });
        }
    );
    return { response: result, servedBy: { provider: member.provider.id, model: member.modelId } };
}

/**
 * Dispatch a streaming request through a resolved target.
 */
async function* streamFrom(target, request) {
    if (target.kind === 'single') {
        for await (const event of target.provider.sendMessageStream(request)) {
            yield { event, servedBy: { provider: target.provider.id, model: target.modelId } };
        }
        return;
    }

    yield* runStream(
        target.combo,
        target.plan,
        request,
        async function* (candidate) {
            await candidate.provider.ensureReady();
            yield* candidate.provider.sendMessageStream({ ...request, model: candidate.modelId });
        }
    );
}

/**
 * Build a standard request object from the raw body.
 */
function buildRequest(body) {
    return {
        model: body.model || DEFAULT_MODEL,
        messages: body.messages,
        max_tokens: body.max_tokens ?? 4096,
        stream: body.stream,
        system: body.system,
        tools: body.tools,
        tool_choice: body.tool_choice,
        thinking: body.thinking,
        top_p: body.top_p,
        top_k: body.top_k,
        temperature: body.temperature
    };
}

/**
 * Process an Anthropic Messages request (non-streaming).
 *
 * @param {object} body — parsed request body
 * @returns {Promise<{status: number, body: object}>}
 */
export async function processRequest(body) {
    const validationError = validateMessagesRequest(body);
    if (validationError) {
        return {
            status: 400,
            body: { type: 'error', error: { type: 'invalid_request_error', message: validationError } }
        };
    }

    const request = buildRequest(body);
    const target = resolveTarget(request.model);

    if (target.kind === 'single') {
        await target.provider.ensureReady();
        request.model = target.modelId;
    }

    try {
        const { response } = await sendFrom(target, request);
        return { status: 200, body: response };
    } catch (error) {
        const { errorType, statusCode, errorMessage } = parseError(error);
        return { status: statusCode, body: { type: 'error', error: { type: errorType, message: errorMessage } } };
    }
}

/**
 * Process a streaming Anthropic Messages request.
 * Yields SSE event strings ready to write to the response.
 *
 * @param {object} body — parsed request body
 * @param {AbortSignal} [signal] — client abort signal
 * @yields {string} SSE event lines
 */
export async function* processStream(body, signal) {
    const validationError = validateMessagesRequest(body);
    if (validationError) {
        yield `event: error\ndata: ${JSON.stringify({
            type: 'error', error: { type: 'invalid_request_error', message: validationError }
        })}\n\n`;
        return;
    }

    const request = buildRequest(body);
    const target = resolveTarget(request.model);

    if (target.kind === 'single') {
        await target.provider.ensureReady();
        request.model = target.modelId;
    }

    if (signal) request.signal = signal;

    try {
        for await (const { event, servedBy } of streamFrom(target, request)) {
            if (signal?.aborted) break;
            yield `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        }
    } catch (error) {
        if (signal?.aborted) return;
        const { errorType, errorMessage } = parseError(error);
        yield `event: error\ndata: ${JSON.stringify({
            type: 'error', error: { type: errorType, message: errorMessage }
        })}\n\n`;
    }
}
