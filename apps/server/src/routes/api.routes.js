/**
 * Core API Routes — Anthropic Messages API compatible (proxied to CodeWhisperer).
 *
 * Two routers are exported. `healthRouter` is mounted at the root; the default
 * export is mounted at `/v1`, so its paths are written without that prefix.
 *
 *   GET  /health                  (root)  -> health / auth readiness
 *   GET  /models                  (/v1)   -> list available models
 *   GET|POST /models/check        (/v1)   -> probe which models are actually active
 *   POST /messages/count_tokens   (/v1)   -> heuristic token estimate
 *   POST /messages                (/v1)   -> send a message (streaming + non-streaming)
 */

import express from 'express';
import {
    listProviders
} from '../providers/index.js';
import { resolveTarget, listSelectableModels } from '../combos/resolver.js';
import {
    anthropicToOpenai,
    createOpenaiStreamTranslator,
    openaiToAnthropic
} from '../openai/translate.js';
import { runOnce, runStream } from '../combos/strategies.js';
import { DEFAULT_MODEL } from '../constants.js';
import { logger } from '../utils/logger.js';
import { requestTelemetry } from '../telemetry/request-telemetry.js';
import {
    estimateRequestTokens,
    estimateTokensForLength,
    responseTextLength
} from '../telemetry/token-estimate.js';
import { gatewayPort } from '../utils/gateway-address.js';

/**
 * Versioned API surface. Mounted at `/v1` by the route registry, so every path
 * below is written relative to that prefix — there is no `/v1` in the strings.
 */
const router = express.Router();

/** Unversioned endpoints, mounted at the root. */
export const healthRouter = express.Router();

/** Validate the subset of Anthropic Messages input required by this proxy. */
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

/** Bound the expensive live model probe endpoint. */
export function normalizeModelCheckOptions(src = {}) {
    let models;
    if (Array.isArray(src.models)) {
        models = src.models.map((model) => String(model).trim()).filter(Boolean);
    } else if (typeof src.models === 'string' && src.models.trim()) {
        models = src.models.split(',').map((model) => model.trim()).filter(Boolean);
    }
    if (models?.length > 50) {
        throw new Error('invalid_request_error: models may contain at most 50 entries');
    }

    const boundedInteger = (value, fallback, min, max) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
    };

    return {
        models,
        concurrency: boundedInteger(src.concurrency, 3, 1, 10),
        timeoutMs: boundedInteger(src.timeout, 20000, 1000, 120000)
    };
}

/**
 * Ensure at least one provider can serve traffic.
 *
 * Used by endpoints that are about the proxy as a whole rather than one model
 * (/health, the model catalog). Succeeds if any provider is ready and reports
 * every provider's state, so a second upstream being down never blocks the first.
 *
 * @returns {Promise<{ready: {id: string, label: string}[], unavailable: {id: string, reason: string}[]}>}
 * @throws {Error} when no provider is ready, carrying the first reason
 */
export async function ensureAnyProviderReady() {
    const ready = [];
    const unavailable = [];
    let firstError = null;

    for (const provider of listProviders()) {
        try {
            await provider.ensureReady();
            ready.push({ id: provider.id, label: provider.label });
        } catch (error) {
            if (!firstError) firstError = error;
            unavailable.push({ id: provider.id, reason: error.message });
        }
    }

    if (ready.length === 0 && firstError) throw firstError;
    return { ready, unavailable };
}

/**
 * Parse an error into an Anthropic-style error type, HTTP status, and message.
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
 * Health check endpoint
 */
healthRouter.get('/health', async (req, res) => {
    const port = gatewayPort(req);
    try {
        const { ready, unavailable } = await ensureAnyProviderReady();
        res.json({
            status: 'ok',
            // `backend` keeps the old single-value shape for existing callers;
            // `providers` is the multi-provider view.
            backend: ready[0].id,
            providers: { ready, unavailable },
            port,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(503).json({
            status: 'error',
            backend: listProviders()[0]?.id ?? null,
            port,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * List models endpoint (OpenAI-compatible format)
 */
router.get('/models', async (req, res) => {
    try {
        res.json(await listSelectableModels());
    } catch (error) {
        logger.error('[API] Error listing models:', error);
        res.status(500).json({
            type: 'error',
            error: {
                type: 'api_error',
                message: error.message
            }
        });
    }
});

/**
 * Check active models endpoint.
 *
 * Probes each candidate model with a minimal live request to CodeWhisperer and
 * reports which ones are actually active/available. Note: this consumes a small
 * amount of quota per model tested.
 *
 * Query params (GET) or JSON body (POST):
 *   - models: comma-separated list (GET) or array (POST) to limit which models are tested
 *   - concurrency: number of parallel probes (default 3)
 *   - timeout: per-request timeout in ms (default 20000)
 */
async function handleModelCheck(req, res) {
    try {
        const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
        const options = normalizeModelCheckOptions(src);
        await ensureAnyProviderReady();

        logger.info(`[API] Checking active models${options.models ? ` (${options.models.join(', ')})` : ''}`);

        // Only some providers can probe live availability; skip the rest rather
        // than failing, and label each result with the provider it came from.
        const results = {};
        for (const provider of listProviders()) {
            if (typeof provider.checkActiveModels !== 'function') continue;
            try {
                results[provider.id] = await provider.checkActiveModels(options);
            } catch (error) {
                results[provider.id] = { error: error.message };
            }
        }
        res.json(results);
    } catch (error) {
        logger.error('[API] Error checking models:', error);
        const { errorType, statusCode, errorMessage } = parseError(error);
        res.status(statusCode).json({
            type: 'error',
            error: {
                type: errorType,
                message: errorMessage
            }
        });
    }
}

router.get('/models/check', handleModelCheck);
router.post('/models/check', handleModelCheck);

/**
 * Count tokens endpoint - returns a heuristic estimate.
 *
 * CodeWhisperer does not expose a token-counting API, so we approximate using a
 * ~4-characters-per-token heuristic over the system prompt, messages, and tools.
 * This keeps Anthropic clients (e.g. Claude Code) working, which may call this
 * endpoint before sending a request.
 */
router.post('/messages/count_tokens', (req, res) => {
    try {
        // Same heuristic the dashboard uses, so the two never disagree.
        const inputTokens = estimateRequestTokens(req.body || {});

        res.json({ input_tokens: inputTokens });
    } catch (error) {
        logger.error('[API] Error estimating token count:', error);
        res.status(500).json({
            type: 'error',
            error: {
                type: 'api_error',
                message: error.message
            }
        });
    }
});

function finishRequestTelemetry(req, result) {
    if (!req.telemetryRequestId) return null;
    return requestTelemetry.finish(req.telemetryRequestId, result);
}

/**
 * Report upstream token counts for the in-flight request.
 *
 * The HTTP-boundary middleware cannot see the response body, so usage has to be
 * handed over from here. Safe to call repeatedly while a stream runs.
 */
function recordUsageTelemetry(req, usage) {
    if (!req.telemetryRequestId || !usage) return null;
    return requestTelemetry.recordUsage(req.telemetryRequestId, usage);
}

/**
 * Pull Anthropic-shaped token counts out of a streamed event.
 *
 * `message_start` carries the input count, `message_delta` the running output
 * count; everything else has no usage attached.
 */
function usageFromStreamEvent(event) {
    if (event?.type === 'message_start' && event.message?.usage) return event.message.usage;
    if (event?.usage) return event.usage;
    return null;
}

/**
 * Dispatch a non-streaming request to a single model or through a combo.
 *
 * @param {object} target from resolveTarget
 * @param {object} request Anthropic Messages request
 * @returns {Promise<{response: object, servedBy: {provider: string, model: string}}>}
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
            // Each member gets its own model id; the request object is shared, so
            // it is copied rather than mutated between attempts.
            return candidate.provider.sendMessage({ ...request, model: candidate.modelId });
        }
    );

    return { response: result, servedBy: { provider: member.provider.id, model: member.modelId } };
}

/**
 * Dispatch a streaming request to a single model or through a combo.
 *
 * @param {object} target from resolveTarget
 * @param {object} request
 * @returns {AsyncGenerator<{event: object, servedBy: {provider: string, model: string}}>}
 */
async function* streamFrom(target, request) {
    if (target.kind === 'single') {
        const servedBy = { provider: target.provider.id, model: target.modelId };
        for await (const event of target.provider.sendMessageStream(request)) {
            yield { event, servedBy };
        }
        return;
    }

    const stream = runStream(
        target.combo,
        target.plan,
        request,
        (candidate) => (async function* attempt() {
            await candidate.provider.ensureReady();
            yield* candidate.provider.sendMessageStream({ ...request, model: candidate.modelId });
        })()
    );

    for await (const { event, target: member } of stream) {
        yield { event, servedBy: { provider: member.provider.id, model: member.modelId } };
    }
}

/**
 * Record which member actually served a combo request.
 *
 * Called on every streamed event but only does work once: the answer cannot
 * change mid-stream, since a member is never replaced after its first event.
 */
function noteServingModel(req, servedBy) {
    if (!servedBy || req._servedBy) return;
    req._servedBy = servedBy;
    if (req.telemetryRequestId) {
        requestTelemetry.recordServingModel(req.telemetryRequestId, servedBy);
    }
}

/** Length of the text a streamed event contributes to the reply. */
function streamEventTextLength(event) {
    if (event?.type !== 'content_block_delta') return 0;
    const delta = event.delta || {};
    return String(delta.text || delta.partial_json || delta.thinking || '').length;
}

/**
 * Main messages endpoint - Anthropic Messages API compatible
 */
/**
 * POST /chat/completions — the OpenAI-shaped entry point.
 *
 * Translates into the same Anthropic request the rest of the gateway uses, so
 * combos, provider rotation, quota parking, and telemetry all apply unchanged.
 * Exists because some clients only speak OpenAI: Pi Agent declares a provider as
 * `"api": "openai-completions"` and would otherwise get a 404 here.
 */
router.post('/chat/completions', async (req, res) => {
    /** OpenAI reports errors under a different envelope than Anthropic. */
    const fail = (status, type, message) => {
        finishRequestTelemetry(req, { outcome: 'failure', status, errorType: type });
        return res.status(status).json({ error: { message, type, code: null, param: null } });
    };

    const { request, problems } = openaiToAnthropic(req.body);
    if (problems.length > 0) {
        return fail(400, 'invalid_request_error', problems.join(' '));
    }

    request.model = request.model || DEFAULT_MODEL;
    const requestedModel = request.model;
    const wantsStream = request.stream === true;

    try {
        const target = resolveTarget(request.model);
        if (target.kind === 'single') {
            await target.provider.ensureReady();
            request.model = target.modelId;
            logger.info(
                `[API] OpenAI request for ${target.provider.id}/${request.model}, stream: ${wantsStream}`
            );
        } else {
            logger.info(
                `[API] OpenAI request for combo ${target.combo.name} `
                + `(${target.combo.strategy}, ${target.plan.length} members), stream: ${wantsStream}`
            );
        }

        recordUsageTelemetry(req, {
            input_tokens: estimateRequestTokens(request),
            estimated: true
        });

        const clientAbort = new AbortController();
        const abortOnClose = () => {
            if (!res.writableEnded) clientAbort.abort();
        };
        res.once('close', abortOnClose);
        request.signal = clientAbort.signal;

        if (wantsStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            const translator = createOpenaiStreamTranslator(requestedModel);
            try {
                let outputChars = 0;
                for await (const { event, servedBy } of streamFrom(target, request)) {
                    if (res.destroyed) break;
                    noteServingModel(req, servedBy);
                    outputChars += streamEventTextLength(event);
                    recordUsageTelemetry(req, {
                        output_tokens: estimateTokensForLength(outputChars),
                        estimated: true
                    });
                    recordUsageTelemetry(req, usageFromStreamEvent(event));

                    // One Anthropic event can produce none or several OpenAI chunks.
                    for (const chunk of translator.translate(event)) {
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    }
                    if (res.flush) res.flush();
                }
                if (!res.destroyed) {
                    // OpenAI terminates a stream with this sentinel, not an event.
                    res.write('data: [DONE]\n\n');
                    finishRequestTelemetry(req, { outcome: 'success', status: 200 });
                    res.end();
                }
            } catch (streamError) {
                if (clientAbort.signal.aborted || res.destroyed) return;
                logger.error('[API] OpenAI stream error:', streamError);
                const { errorType, statusCode, errorMessage } = parseError(streamError);
                finishRequestTelemetry(req, {
                    outcome: 'failure',
                    status: statusCode,
                    errorType
                });
                res.write(`data: ${JSON.stringify({
                    error: { message: errorMessage, type: errorType }
                })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
            return undefined;
        }

        const { response, servedBy } = await sendFrom(target, request);
        noteServingModel(req, servedBy);
        if (res.destroyed) return undefined;

        recordUsageTelemetry(req, {
            output_tokens: estimateTokensForLength(responseTextLength(response)),
            estimated: true
        });
        recordUsageTelemetry(req, response?.usage);
        finishRequestTelemetry(req, { outcome: 'success', status: 200 });
        // The model echoed back is what the client asked for, so a combo name does
        // not silently become a member id in the client's own logs.
        return res.json(anthropicToOpenai(response, requestedModel));
    } catch (error) {
        logger.error('[API] OpenAI error:', error);
        const { errorType, statusCode, errorMessage } = parseError(error);
        return fail(statusCode, errorType, errorMessage);
    }
});

router.post('/messages', async (req, res) => {
    try {
        const validationError = validateMessagesRequest(req.body);
        if (validationError) {
            finishRequestTelemetry(req, {
                outcome: 'failure',
                status: 400,
                errorType: 'invalid_request_error'
            });
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: validationError
                }
            });
        }

        const {
            model,
            messages,
            max_tokens,
            stream,
            system,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        } = req.body;

        // Build the request object
        const request = {
            model: model || DEFAULT_MODEL,
            messages,
            max_tokens: max_tokens ?? 4096,
            stream,
            system,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        };

        // A model id may name a single model or a combo. Combos are gated per
        // member at dispatch time, since the point is to tolerate one being down.
        const target = resolveTarget(request.model);

        if (target.kind === 'single') {
            // Gate on this provider only: a second upstream being unauthenticated
            // must not block the first.
            await target.provider.ensureReady();
            // Hand the provider the bare id, namespace stripped.
            request.model = target.modelId;
            logger.info(`[API] Request for ${target.provider.id}/${request.model}, stream: ${!!stream}`);
        } else {
            logger.info(
                `[API] Request for combo ${target.combo.name} (${target.combo.strategy}, `
                + `${target.plan.length} members), stream: ${!!stream}`
            );
        }

        // Recorded before the upstream call so even a failed or aborted request
        // accounts for the prompt it sent.
        recordUsageTelemetry(req, {
            input_tokens: estimateRequestTokens(req.body),
            estimated: true
        });

        const clientAbort = new AbortController();
        const abortOnClose = () => {
            if (!res.writableEnded) clientAbort.abort();
        };
        res.once('close', abortOnClose);
        request.signal = clientAbort.signal;

        try {
            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                try {
                    let outputChars = 0;
                    for await (const { event, servedBy } of streamFrom(target, request)) {
                        if (res.destroyed) break;
                        // Attribute the response to whichever member answered.
                        noteServingModel(req, servedBy);
                        outputChars += streamEventTextLength(event);
                        // Recorded per event so a client that disconnects mid-stream
                        // still leaves the tokens it had already consumed behind.
                        recordUsageTelemetry(req, {
                            output_tokens: estimateTokensForLength(outputChars),
                            estimated: true
                        });
                        recordUsageTelemetry(req, usageFromStreamEvent(event));
                        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                        if (res.flush) res.flush();
                    }
                    if (!res.destroyed) {
                        finishRequestTelemetry(req, { outcome: 'success', status: 200 });
                        res.end();
                    }
                } catch (streamError) {
                    if (clientAbort.signal.aborted || res.destroyed) return;
                    logger.error('[API] Stream error:', streamError);
                    const { errorType, statusCode, errorMessage } = parseError(streamError);
                    finishRequestTelemetry(req, {
                        outcome: 'failure',
                        status: statusCode,
                        errorType
                    });
                    res.write(`event: error\ndata: ${JSON.stringify({
                        type: 'error',
                        error: { type: errorType, message: errorMessage }
                    })}\n\n`);
                    res.end();
                }
            } else {
                const { response, servedBy } = await sendFrom(target, request);
                noteServingModel(req, servedBy);
                if (!res.destroyed) {
                    recordUsageTelemetry(req, {
                        output_tokens: estimateTokensForLength(responseTextLength(response)),
                        estimated: true
                    });
                    recordUsageTelemetry(req, response?.usage);
                    finishRequestTelemetry(req, { outcome: 'success', status: 200 });
                    res.json(response);
                }
            }
        } finally {
            res.off('close', abortOnClose);
        }

    } catch (error) {
        if (res.destroyed) return;
        logger.error('[API] Error:', error);

        const { errorType, statusCode, errorMessage } = parseError(error);
        finishRequestTelemetry(req, {
            outcome: 'failure',
            status: statusCode,
            errorType
        });

        logger.warn(`[API] Returning error response: ${statusCode} ${errorType} - ${errorMessage}`);

        // Check if headers have already been sent (for streaming that failed mid-way)
        if (res.headersSent) {
            logger.warn('[API] Headers already sent, writing error as SSE event');
            res.write(`event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: { type: errorType, message: errorMessage }
            })}\n\n`);
            res.end();
        } else {
            res.status(statusCode).json({
                type: 'error',
                error: {
                    type: errorType,
                    message: errorMessage
                }
            });
        }
    }
});

export default router;
