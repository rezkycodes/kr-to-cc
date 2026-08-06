/**
 * Google generateContent -> Anthropic Messages.
 *
 * Two outputs: a complete response for the non-streaming path, and a sequence of
 * Anthropic SSE events for the streaming path.
 *
 * Unlike Kiro, this upstream *does* report token usage in `usageMetadata`. Those
 * counts are measured, not estimated, and are marked as such so the dashboard can
 * tell the two apart.
 *
 * Adapted from 9router (MIT, © 2024-2026 decolua and contributors).
 */

import crypto from 'crypto';

/**
 * Unwrap the Cloud Code envelope.
 *
 * Generation responses arrive as `{ response: {...}, traceId, metadata }` rather
 * than the bare Gemini payload the public API returns. Streaming frames use the
 * same wrapper. Accepts either shape so a plain payload still works.
 *
 * @param {object} payload
 * @returns {object}
 */
export function unwrap(payload) {
    if (payload && typeof payload === 'object' && payload.response) return payload.response;
    return payload || {};
}

/** Map a Gemini finishReason onto an Anthropic stop_reason. */
function toStopReason(finishReason, sawToolCall) {
    if (sawToolCall) return 'tool_use';
    switch (finishReason) {
        case 'MAX_TOKENS': return 'max_tokens';
        case 'STOP': return 'end_turn';
        case 'SAFETY':
        case 'RECITATION':
        case 'PROHIBITED_CONTENT':
            // Anthropic has no direct equivalent; the turn did end.
            return 'end_turn';
        default: return finishReason ? 'end_turn' : null;
    }
}

/** Anthropic-style message id. */
function messageId() {
    return `msg_${crypto.randomBytes(12).toString('hex')}`;
}

/** Tool-use block id. */
function toolUseId() {
    return `toolu_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Extract usage from a Gemini payload.
 *
 * @param {object} payload
 * @returns {{input_tokens: number, output_tokens: number, cached_tokens: number|null}|null}
 */
export function extractUsage(payload) {
    const meta = unwrap(payload)?.usageMetadata;
    if (!meta) return null;

    const input = Number(meta.promptTokenCount) || 0;
    const visible = Number(meta.candidatesTokenCount) || 0;
    // Thinking tokens are generated and billed even though the client never sees
    // them. Excluding them would under-report a thinking model by most of its
    // real output — a request can spend everything on thought and emit no text.
    const thoughts = Number(meta.thoughtsTokenCount) || 0;
    // Absent means the request used no cached context, which is a real zero
    // rather than "not reported".
    const cached = Number(meta.cachedContentTokenCount);

    return {
        input_tokens: input,
        output_tokens: visible + thoughts,
        thinking_tokens: thoughts,
        cached_tokens: Number.isFinite(cached) ? cached : 0
    };
}

/** Restore the client's tool name from the upstream one. */
function clientToolName(name, toolNames) {
    return toolNames?.get(name) || name;
}

/**
 * Convert a complete Gemini response to an Anthropic Messages response.
 *
 * @param {object} payload
 * @param {{model: string, toolNames?: Map<string, string>}} context
 * @returns {object}
 */
export function convertResponse(payload, context) {
    const candidate = unwrap(payload)?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const content = [];
    let sawToolCall = false;

    for (const part of parts) {
        if (part.functionCall) {
            sawToolCall = true;
            content.push({
                type: 'tool_use',
                id: toolUseId(),
                name: clientToolName(part.functionCall.name, context.toolNames),
                input: part.functionCall.args || {}
            });
        } else if (typeof part.text === 'string' && part.text) {
            // A part carrying only a signature is bookkeeping, not output.
            if (part.thought && !part.functionCall) continue;
            content.push({ type: 'text', text: part.text });
        }
    }

    const usage = extractUsage(payload);

    return {
        id: messageId(),
        type: 'message',
        role: 'assistant',
        model: context.model,
        content,
        stop_reason: toStopReason(candidate?.finishReason, sawToolCall),
        stop_sequence: null,
        usage: {
            input_tokens: usage?.input_tokens ?? 0,
            output_tokens: usage?.output_tokens ?? 0,
            ...(usage?.cached_tokens != null ? { cache_read_input_tokens: usage.cached_tokens } : {})
        }
    };
}

/**
 * Streaming converter.
 *
 * Gemini streams whole candidate chunks; Anthropic expects a block lifecycle
 * (`content_block_start` -> deltas -> `content_block_stop`). This tracks which
 * block is open so text and tool calls interleave correctly.
 */
export class StreamConverter {
    /**
     * @param {{model: string, toolNames?: Map<string, string>}} context
     */
    constructor(context) {
        this.model = context.model;
        this.toolNames = context.toolNames;
        this.messageId = messageId();
        this.started = false;
        this.blockIndex = -1;
        this.openBlock = null;
        this.sawToolCall = false;
        this.usage = null;
        this.finishReason = null;
    }

    /** Events that open the message. */
    *start() {
        if (this.started) return;
        this.started = true;
        yield {
            type: 'message_start',
            message: {
                id: this.messageId,
                type: 'message',
                role: 'assistant',
                model: this.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                // Real counts arrive with the final chunk; 0 here is a placeholder
                // that message_delta corrects, matching Anthropic's own behaviour.
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        };
    }

    *closeBlock() {
        if (this.openBlock === null) return;
        yield { type: 'content_block_stop', index: this.blockIndex };
        this.openBlock = null;
    }

    *openTextBlock() {
        if (this.openBlock === 'text') return;
        yield* this.closeBlock();
        this.blockIndex += 1;
        this.openBlock = 'text';
        yield {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'text', text: '' }
        };
    }

    /**
     * Translate one Gemini chunk into Anthropic events.
     * @param {object} chunk
     */
    *convertChunk(chunk) {
        yield* this.start();

        const candidate = unwrap(chunk)?.candidates?.[0];
        const usage = extractUsage(chunk);
        if (usage) this.usage = usage;
        if (candidate?.finishReason) this.finishReason = candidate.finishReason;

        for (const part of candidate?.content?.parts || []) {
            if (part.functionCall) {
                this.sawToolCall = true;
                yield* this.closeBlock();
                this.blockIndex += 1;
                this.openBlock = 'tool_use';
                const id = toolUseId();
                yield {
                    type: 'content_block_start',
                    index: this.blockIndex,
                    content_block: {
                        type: 'tool_use',
                        id,
                        name: clientToolName(part.functionCall.name, this.toolNames),
                        input: {}
                    }
                };
                // Anthropic streams tool arguments as partial JSON. Gemini gives
                // the whole object at once, so it is emitted as one delta.
                yield {
                    type: 'content_block_delta',
                    index: this.blockIndex,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: JSON.stringify(part.functionCall.args || {})
                    }
                };
                yield* this.closeBlock();
                continue;
            }

            if (typeof part.text === 'string' && part.text) {
                if (part.thought && !part.functionCall) continue;
                yield* this.openTextBlock();
                yield {
                    type: 'content_block_delta',
                    index: this.blockIndex,
                    delta: { type: 'text_delta', text: part.text }
                };
            }
        }
    }

    /** Events that close the message. */
    *finish() {
        yield* this.start();
        yield* this.closeBlock();
        yield {
            type: 'message_delta',
            delta: {
                stop_reason: toStopReason(this.finishReason, this.sawToolCall) || 'end_turn',
                stop_sequence: null
            },
            usage: {
                input_tokens: this.usage?.input_tokens ?? 0,
                output_tokens: this.usage?.output_tokens ?? 0,
                ...(this.usage?.cached_tokens != null
                    ? { cache_read_input_tokens: this.usage.cached_tokens }
                    : {})
            }
        };
        yield { type: 'message_stop' };
    }
}

/**
 * Parse an SSE byte stream into Cloud Code chunk objects.
 *
 * This upstream separates frames with CRLF (`\r\n\r\n`), not the bare `\n\n` many
 * SSE producers use. Line endings are normalised first so both work — splitting
 * only on `\n\n` silently yields nothing here, which looks like an empty stream
 * rather than a parsing bug.
 *
 * @param {ReadableStream|AsyncIterable} body
 * @returns {AsyncGenerator<object>}
 */
export async function* parseSSE(body) {
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const piece of body) {
        const text = typeof piece === 'string' ? piece : decoder.decode(piece, { stream: true });
        buffer += text.replace(/\r\n/g, '\n');

        // A frame may span reads, so only complete ones are consumed.
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                try {
                    yield JSON.parse(data);
                } catch {
                    // A truncated frame is not worth failing the stream over.
                }
            }
        }
    }

    // Flush a trailing frame that arrived without a final blank line.
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
        const data = tail.slice(5).trim();
        if (data && data !== '[DONE]') {
            try {
                yield JSON.parse(data);
            } catch {
                // Same as above.
            }
        }
    }
}

export default { convertResponse, StreamConverter, parseSSE, extractUsage, unwrap };
