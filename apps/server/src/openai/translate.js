/**
 * OpenAI Chat Completions translation.
 *
 * The gateway speaks Anthropic Messages internally, because that is what its
 * providers are shaped around. Some clients only speak OpenAI — Pi Agent, for one,
 * where a provider is declared as `"api": "openai-completions"` — so this module
 * translates in both directions.
 *
 * Translation only. Dispatch, telemetry, and provider selection stay where they
 * already are, so this file can be tested without a network or an account.
 *
 * The mappings that are not one-to-one, and therefore worth stating:
 *
 *   - OpenAI carries system prompts as a `system` message inside `messages`;
 *     Anthropic takes a top-level `system` string. Several are joined.
 *   - OpenAI has a `tool` role for results; Anthropic puts a `tool_result` block on
 *     a **user** turn.
 *   - OpenAI tool arguments are a JSON **string**; Anthropic's `input` is an object.
 *   - `max_tokens` is optional in OpenAI and required by Anthropic, so a default is
 *     supplied rather than letting the upstream reject the request.
 */

/** Anthropic requires a limit; OpenAI does not. */
const DEFAULT_MAX_TOKENS = 4096;

/** Anthropic stop reasons mapped to OpenAI finish reasons. */
const FINISH_REASONS = {
    end_turn: 'stop',
    stop_sequence: 'stop',
    max_tokens: 'length',
    tool_use: 'tool_calls'
};

/** Flatten OpenAI content, which is a string or a list of typed parts. */
function toAnthropicContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    const blocks = [];
    for (const part of content) {
        if (typeof part === 'string') {
            blocks.push({ type: 'text', text: part });
            continue;
        }
        if (part?.type === 'text' && typeof part.text === 'string') {
            blocks.push({ type: 'text', text: part.text });
            continue;
        }
        if (part?.type === 'image_url') {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            // Only data URLs can be forwarded: Anthropic takes base64 bytes, not a
            // link it would have to fetch itself.
            const match = typeof url === 'string' ? url.match(/^data:([^;]+);base64,(.*)$/) : null;
            if (match) {
                blocks.push({
                    type: 'image',
                    source: { type: 'base64', media_type: match[1], data: match[2] }
                });
            }
        }
    }
    return blocks;
}

/** OpenAI tool declarations to Anthropic's shape. */
function toAnthropicTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return undefined;

    const converted = [];
    for (const tool of tools) {
        const fn = tool?.type === 'function' ? tool.function : tool;
        if (!fn?.name) continue;
        converted.push({
            name: fn.name,
            ...(fn.description ? { description: fn.description } : {}),
            // Anthropic calls it input_schema; an absent schema still needs a shape
            // or the upstream rejects the declaration.
            input_schema: fn.parameters || { type: 'object', properties: {} }
        });
    }
    return converted.length > 0 ? converted : undefined;
}

/** OpenAI tool_choice to Anthropic's. */
function toAnthropicToolChoice(choice) {
    if (!choice) return undefined;
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'required') return { type: 'any' };
    if (choice === 'none') return undefined;
    if (choice?.type === 'function' && choice.function?.name) {
        return { type: 'tool', name: choice.function.name };
    }
    return undefined;
}

/**
 * Translate an OpenAI Chat Completions request into an Anthropic Messages request.
 *
 * @param {object} body the OpenAI request
 * @returns {{request: object, problems: string[]}}
 */
export function openaiToAnthropic(body) {
    const problems = [];

    if (!body || typeof body !== 'object') {
        return { request: null, problems: ['A JSON body is required.'] };
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        problems.push('messages is required and must be a non-empty array.');
    }

    const systemParts = [];
    const messages = [];

    for (const message of body.messages || []) {
        const role = message?.role;

        // Both spellings appear in the wild; `developer` is the newer one.
        if (role === 'system' || role === 'developer') {
            const text = typeof message.content === 'string'
                ? message.content
                : toAnthropicContent(message.content)
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n');
            if (text) systemParts.push(text);
            continue;
        }

        if (role === 'tool') {
            // A result rides on a user turn in Anthropic, and pairs by id.
            messages.push({
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: message.tool_call_id || 'unknown',
                        content: typeof message.content === 'string'
                            ? message.content
                            : JSON.stringify(message.content ?? null)
                    }
                ]
            });
            continue;
        }

        if (role === 'assistant') {
            const blocks = [];
            const text = toAnthropicContent(message.content);
            if (typeof text === 'string' && text) blocks.push({ type: 'text', text });
            else if (Array.isArray(text)) blocks.push(...text);

            for (const call of message.tool_calls || []) {
                if (!call?.function?.name) continue;
                let input = {};
                try {
                    // OpenAI sends arguments as a JSON string; a malformed one is
                    // passed through as raw text rather than dropped, so the model
                    // can see what it produced.
                    input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
                } catch {
                    input = { _raw_arguments: String(call.function.arguments) };
                }
                blocks.push({
                    type: 'tool_use',
                    id: call.id || `call_${blocks.length}`,
                    name: call.function.name,
                    input
                });
            }

            // An assistant turn with neither text nor a call has nothing to send.
            if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
            continue;
        }

        if (role === 'user') {
            messages.push({ role: 'user', content: toAnthropicContent(message.content) });
            continue;
        }

        if (role) problems.push(`Unsupported message role "${role}".`);
    }

    if (messages.length === 0 && problems.length === 0) {
        problems.push('messages must contain at least one user or assistant turn.');
    }

    if (problems.length > 0) return { request: null, problems };

    const request = {
        model: body.model,
        messages,
        // `max_completion_tokens` is the newer name; both are accepted.
        max_tokens: body.max_completion_tokens ?? body.max_tokens ?? DEFAULT_MAX_TOKENS,
        stream: body.stream === true
    };

    if (systemParts.length > 0) request.system = systemParts.join('\n\n');
    if (Number.isFinite(body.temperature)) request.temperature = body.temperature;
    if (Number.isFinite(body.top_p)) request.top_p = body.top_p;

    const tools = toAnthropicTools(body.tools);
    if (tools) request.tools = tools;
    const toolChoice = toAnthropicToolChoice(body.tool_choice);
    if (toolChoice) request.tool_choice = toolChoice;

    if (typeof body.stop === 'string') request.stop_sequences = [body.stop];
    else if (Array.isArray(body.stop) && body.stop.length > 0) request.stop_sequences = body.stop;

    return { request, problems: [] };
}

/** A stable id for a completion, in the shape OpenAI clients expect. */
function completionId(seed) {
    const suffix = String(seed || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)
        || Math.random().toString(36).slice(2, 12);
    return `chatcmpl-${suffix}`;
}

/**
 * Translate an Anthropic Messages response into an OpenAI Chat Completion.
 *
 * @param {object} response the Anthropic response
 * @param {string} model the model id to echo back
 */
export function anthropicToOpenai(response, model) {
    const blocks = Array.isArray(response?.content) ? response.content : [];

    const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

    const toolCalls = blocks
        .filter((block) => block.type === 'tool_use')
        .map((block, index) => ({
            // OpenAI numbers calls so a streaming client can assemble them.
            index,
            id: block.id || `call_${index}`,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
        }));

    const usage = response?.usage || {};

    return {
        id: completionId(response?.id),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || response?.model || 'unknown',
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    // Null rather than an empty string when a turn is only tool
                    // calls: that is what OpenAI itself returns.
                    content: text || (toolCalls.length > 0 ? null : ''),
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                },
                finish_reason: FINISH_REASONS[response?.stop_reason] ?? 'stop'
            }
        ],
        usage: {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        }
    };
}

/**
 * Turn Anthropic stream events into OpenAI chunks.
 *
 * Stateful because the two formats disagree about where information lives:
 * Anthropic announces a tool call in `content_block_start` and streams its
 * arguments as deltas, while OpenAI expects the name on the first chunk of that
 * call and the arguments after it.
 *
 * @param {string} model the model id to echo back
 */
export function createOpenaiStreamTranslator(model) {
    const id = completionId(Math.random().toString(36).slice(2));
    const created = Math.floor(Date.now() / 1000);
    let roleSent = false;
    /** Anthropic block index -> OpenAI tool call index. */
    const toolIndexes = new Map();
    let nextToolIndex = 0;

    function chunk(delta, finishReason = null) {
        return {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }]
        };
    }

    return {
        /**
         * @param {object} event an Anthropic SSE event
         * @returns {object[]} zero or more OpenAI chunks
         */
        translate(event) {
            const out = [];

            if (event?.type === 'message_start') {
                roleSent = true;
                out.push(chunk({ role: 'assistant', content: '' }));
                return out;
            }

            if (event?.type === 'content_block_start') {
                const block = event.content_block;
                if (block?.type === 'tool_use') {
                    const index = nextToolIndex++;
                    toolIndexes.set(event.index, index);
                    // Name goes out first with empty arguments; the arguments follow
                    // as deltas.
                    out.push(
                        chunk({
                            tool_calls: [
                                {
                                    index,
                                    id: block.id || `call_${index}`,
                                    type: 'function',
                                    function: { name: block.name, arguments: '' }
                                }
                            ]
                        })
                    );
                }
                return out;
            }

            if (event?.type === 'content_block_delta') {
                const delta = event.delta;
                if (delta?.type === 'text_delta' && delta.text) {
                    if (!roleSent) {
                        roleSent = true;
                        out.push(chunk({ role: 'assistant', content: '' }));
                    }
                    out.push(chunk({ content: delta.text }));
                } else if (delta?.type === 'input_json_delta') {
                    const index = toolIndexes.get(event.index);
                    if (index != null) {
                        out.push(
                            chunk({
                                tool_calls: [
                                    {
                                        index,
                                        function: { arguments: delta.partial_json || '' }
                                    }
                                ]
                            })
                        );
                    }
                }
                // Thinking deltas are dropped: OpenAI has no field for them, and
                // inventing one would confuse a strict client.
                return out;
            }

            if (event?.type === 'message_delta') {
                const reason = FINISH_REASONS[event.delta?.stop_reason];
                if (reason) out.push(chunk({}, reason));
                return out;
            }

            // message_stop carries nothing OpenAI needs; the caller sends [DONE].
            return out;
        }
    };
}

export default { openaiToAnthropic, anthropicToOpenai, createOpenaiStreamTranslator };
