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
    sendKiroMessage,
    sendKiroMessageStream,
    listKiroModels,
    checkActiveModels
} from '../kiro/index.js';
import {
    isKiroAuthenticated,
    isKiroDatabaseAccessible,
    ensureValidKiroToken
} from '../auth/kiro-token-extractor.js';
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
 * Ensure Kiro is authenticated and accessible. Refreshes the access token (via
 * the stored refresh token) if it is expired or about to expire, which lets the
 * proxy keep working without re-running `kiro auth`.
 */
export async function ensureKiroReady() {
    if (!isKiroDatabaseAccessible()) {
        throw new Error('Kiro CLI database not accessible. Please install and authenticate with Kiro CLI.');
    }

    if (!isKiroAuthenticated()) {
        throw new Error('Kiro CLI not authenticated. Please run "kiro auth" to authenticate.');
    }

    await ensureValidKiroToken();
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
        await ensureKiroReady();
        res.json({
            status: 'ok',
            backend: 'kiro',
            port,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(503).json({
            status: 'error',
            backend: 'kiro',
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
        await ensureKiroReady();
        const models = await listKiroModels();
        res.json(models);
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
        await ensureKiroReady();

        logger.info(`[API] Checking active models${options.models ? ` (${options.models.join(', ')})` : ''}`);

        const result = await checkActiveModels(options);
        res.json(result);
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

/** Length of the text a streamed event contributes to the reply. */
function streamEventTextLength(event) {
    if (event?.type !== 'content_block_delta') return 0;
    const delta = event.delta || {};
    return String(delta.text || delta.partial_json || delta.thinking || '').length;
}

/**
 * Main messages endpoint - Anthropic Messages API compatible
 */
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

        await ensureKiroReady();

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
            model: model || 'claude-opus-4-6',
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

        logger.info(`[API] Request for model: ${request.model}, stream: ${!!stream}`);

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
                    for await (const event of sendKiroMessageStream(request)) {
                        if (res.destroyed) break;
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
                const response = await sendKiroMessage(request);
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
