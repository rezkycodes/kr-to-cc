/**
 * MITM request handler for Anthropic API traffic.
 *
 * Receives intercepted HTTPS requests to api.anthropic.com, forwards them
 * through the existing provider system (kiro, google/antigravity), and
 * streams the Anthropic-format response back to the client.
 *
 * Unlike 9router's handlers which translate between Gemini/Kiro/OpenAI formats,
 * this handler is thin: kr-to-cc's providers already speak Anthropic natively.
 */

import { processRequest, processStream } from './process-request.js';
import { logger } from '../utils/logger.js';

/**
 * Handle an intercepted Anthropic Messages API request.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Buffer} bodyBuffer — raw request body
 */
export async function handleAnthropicRequest(req, res, bodyBuffer) {
    let body;
    try {
        body = JSON.parse(bodyBuffer.toString());
    } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Invalid JSON body' }
        }));
        return;
    }

    const wantsStream = body.stream === true;
    logger.info(`[MITM] ${req.method} ${req.url} model=${body.model || 'default'} stream=${wantsStream}`);

    if (wantsStream) {
        // Streaming: set SSE headers and yield events
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const clientAbort = new AbortController();
        req.once('close', () => clientAbort.abort());

        try {
            for await (const chunk of processStream(body, clientAbort.signal)) {
                if (res.destroyed) break;
                res.write(chunk);
                if (res.flush) res.flush();
            }
            if (!res.destroyed) res.end();
        } catch (error) {
            logger.error('[MITM] Stream error:', error);
            if (!res.destroyed) {
                res.write(`event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: { type: 'api_error', message: error.message }
                })}\n\n`);
                res.end();
            }
        }
    } else {
        // Non-streaming: wait for full response
        try {
            const { status, body: responseBody } = await processRequest(body);
            if (!res.destroyed) {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(responseBody));
            }
        } catch (error) {
            logger.error('[MITM] Request error:', error);
            if (!res.destroyed) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    type: 'error',
                    error: { type: 'api_error', message: error.message }
                }));
            }
        }
    }
}
