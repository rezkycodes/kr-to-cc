/**
 * Request Builder for Kiro/AWS CodeWhisperer
 *
 * Converts Anthropic Messages requests to the native Kiro conversation schema.
 */

import crypto from 'crypto';
import {
    KIRO_MODEL_MAPPING,
    KIRO_HEADERS,
    KIRO_CODEWHISPERER_TARGET,
    KIRO_DEFAULT_PROFILE_ARNS,
    buildAmzSdkHeaders
} from '../../constants.js';

export const KIRO_TOOL_NAME_MAX_LENGTH = 64;
const KIRO_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOOL_NAME_HASH_LENGTH = 16;

/** Convert an Anthropic/MCP tool name to Kiro's <=64 character format. */
export function toKiroToolName(name) {
    const original = String(name || '');
    if (original.length <= KIRO_TOOL_NAME_MAX_LENGTH
        && KIRO_TOOL_NAME_PATTERN.test(original)) {
        return original;
    }

    const safeStem = original.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
    const digest = crypto.createHash('sha256')
        .update(original)
        .digest('hex')
        .slice(0, TOOL_NAME_HASH_LENGTH);
    const suffix = `_${digest}`;
    return `${safeStem.slice(0, KIRO_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

/** Map the Kiro-safe names in a response back to names understood by the client. */
export function buildKiroToolNameMap(tools) {
    const names = new Map();
    for (const tool of Array.isArray(tools) ? tools : []) {
        if (tool && typeof tool.name === 'string' && tool.name) {
            names.set(toKiroToolName(tool.name), tool.name);
        }
    }
    return names;
}

export function restoreAnthropicToolName(name, toolNameMap) {
    return toolNameMap?.get(name) || name;
}

/** Map an Anthropic model name to Kiro's internal model ID. */
export function mapModelToKiro(anthropicModel) {
    const lower = (anthropicModel || '').toLowerCase();

    if (KIRO_MODEL_MAPPING[lower]) return KIRO_MODEL_MAPPING[lower];

    if (lower.includes('opus') && lower.includes('4.8')) return 'claude-opus-4.8';
    if (lower.includes('opus') && lower.includes('4.7')) return 'claude-opus-4.7';
    if (lower.includes('opus') && lower.includes('4.6')) return 'claude-opus-4.6';
    if (lower.includes('opus') && lower.includes('4.5')) return 'claude-opus-4.5';
    if (lower.includes('opus')) return 'claude-opus-4.8';
    if (lower.includes('sonnet') && lower.includes('4.6')) return 'claude-sonnet-4.6';
    if (lower.includes('sonnet') && lower.includes('4.5')) return 'claude-sonnet-4.5';
    if (lower.includes('sonnet') && (lower.includes('4.0') || lower.includes('-4'))) return 'claude-sonnet-4';
    if (lower.includes('sonnet') && lower.includes('5')) return 'claude-sonnet-5';
    if (lower.includes('sonnet')) return 'claude-sonnet-4.5';
    if (lower.includes('haiku')) return 'claude-haiku-4.5';
    if (lower.includes('deepseek')) return 'deepseek-3.2';
    if (lower.includes('glm')) return 'glm-5';
    if (lower.includes('qwen')) return 'qwen3-coder-next';
    if (lower.includes('minimax') && lower.includes('2.1')) return 'minimax-m2.1';
    if (lower.includes('minimax')) return 'minimax-m2.5';

    return 'claude-opus-4.8';
}

/** Normalize an Anthropic system field to plain text. */
function normalizeSystemPrompt(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (!Array.isArray(system)) return '';
    return system
        .map((block) => typeof block === 'string' ? block : block?.text || '')
        .filter(Boolean)
        .join('\n');
}

/** Return a safe object for a native tool input. */
export function normalizeToolInput(input) {
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
    if (typeof input === 'string') {
        try {
            const parsed = JSON.parse(input);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
}

function stringifyContentValue(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/** Convert Anthropic tool_result content to Kiro's [{ text }] shape. */
function normalizeToolResultContent(content) {
    if (typeof content === 'string') {
        return [{ text: content || '(no output)' }];
    }
    if (!Array.isArray(content)) {
        return [{ text: stringifyContentValue(content) || '(no output)' }];
    }

    const items = content.map((block) => {
        if (typeof block === 'string') return { text: block };
        if (block?.type === 'text') return { text: block.text || '' };
        if (block?.type === 'image') return { text: '[Image result omitted]' };
        return { text: stringifyContentValue(block) };
    }).filter((item) => item.text !== '');

    return items.length ? items : [{ text: '(no output)' }];
}

/** Normalize one Anthropic message without flattening its tool semantics. */
function normalizeMessage(message) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    if (typeof message?.content === 'string') {
        return { role, content: message.content, toolUses: [], toolResults: [] };
    }

    const text = [];
    const toolUses = [];
    const toolResults = [];

    for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
            if (block.text) text.push(block.text);
        } else if (block.type === 'image') {
            text.push('[Image attached]');
        } else if (block.type === 'tool_use' && role === 'assistant') {
            toolUses.push({
                toolUseId: block.id,
                name: toKiroToolName(block.name),
                input: normalizeToolInput(block.input)
            });
        } else if (block.type === 'tool_result' && role === 'user') {
            toolResults.push({
                toolUseId: block.tool_use_id,
                status: block.is_error ? 'error' : 'success',
                content: normalizeToolResultContent(block.content)
            });
        }
    }

    return { role, content: text.join('\n'), toolUses, toolResults };
}

/** Convert Anthropic tools to native Kiro tool specifications. */
export function buildKiroTools(tools, toolChoice) {
    if (toolChoice?.type === 'none' || !Array.isArray(tools)) return [];

    return tools
        .filter((tool) => tool && typeof tool.name === 'string' && tool.name.length > 0)
        .map((tool) => ({
            toolSpecification: {
                name: toKiroToolName(tool.name),
                description: typeof tool.description === 'string' ? tool.description : '',
                inputSchema: {
                    json: tool.input_schema && typeof tool.input_schema === 'object'
                        ? tool.input_schema
                        : { type: 'object', properties: {} }
                }
            }
        }));
}

/** Convert an Anthropic request into normalized conversation data. */
export function convertAnthropicToKiro(anthropicRequest) {
    return {
        systemPrompt: normalizeSystemPrompt(anthropicRequest.system),
        conversationHistory: (anthropicRequest.messages || []).map(normalizeMessage),
        maxTokens: anthropicRequest.max_tokens || 8192,
        temperature: anthropicRequest.temperature,
        topP: anthropicRequest.top_p
    };
}

function prependSystemPrompt(conversation, systemPrompt) {
    if (!systemPrompt || !conversation.length) return;
    const target = conversation.find((message) => message.role === 'user')
        || conversation[conversation.length - 1];
    target.content = target.content
        ? `${systemPrompt}\n\n${target.content}`
        : systemPrompt;
}

function mergeAdjacentMessages(messages) {
    const merged = [];
    for (const message of messages) {
        const previous = merged[merged.length - 1];
        if (previous?.role === message.role) {
            previous.content = [previous.content, message.content].filter(Boolean).join('\n');
            previous.toolUses.push(...message.toolUses);
            previous.toolResults.push(...message.toolResults);
        } else {
            merged.push({
                ...message,
                toolUses: [...message.toolUses],
                toolResults: [...message.toolResults]
            });
        }
    }
    // Kiro history must begin with a user turn. Preserve a sole assistant turn
    // as the current synthetic user input for prefill-compatible clients.
    if (merged.length > 1 && merged[0].role === 'assistant') merged.shift();
    return merged;
}

function buildKiroHistory(messages, model) {
    return messages.map((message) => {
        if (message.role === 'assistant') {
            const assistantResponseMessage = { content: message.content || '' };
            if (message.toolUses.length) assistantResponseMessage.toolUses = message.toolUses;
            return { assistantResponseMessage };
        }

        const userInputMessage = {
            content: message.content || 'continue',
            modelId: model
        };
        if (message.toolResults.length) {
            userInputMessage.userInputMessageContext = {
                toolResults: message.toolResults
            };
        }
        return { userInputMessage };
    });
}

/** Resolve a shared default CodeWhisperer profileArn by auth method.
 *  Social (Google/GitHub) sign-ins map to a different shared profile than
 *  Builder ID, mirroring the real Kiro IDE behaviour. */
export function resolveDefaultProfileArn(authKey) {
    if (typeof authKey === 'string' && authKey.includes('social')) {
        return KIRO_DEFAULT_PROFILE_ARNS.social;
    }
    return KIRO_DEFAULT_PROFILE_ARNS['builder-id'];
}

/** Build the native CodeWhisperer chat request payload. */
export function buildKiroRequest(anthropicRequest, options = {}) {
    const model = mapModelToKiro(anthropicRequest.model);
    const converted = convertAnthropicToKiro(anthropicRequest);
    const conversation = mergeAdjacentMessages(converted.conversationHistory);
    prependSystemPrompt(conversation, converted.systemPrompt);

    const currentTurn = conversation[conversation.length - 1] || {
        role: 'user',
        content: converted.systemPrompt || '',
        toolUses: [],
        toolResults: []
    };
    const history = buildKiroHistory(conversation.slice(0, -1), model);
    const tools = buildKiroTools(anthropicRequest.tools, anthropicRequest.tool_choice);

    const userInputMessageContext = {
        editorState: { cursorState: null }
    };
    if (tools.length) userInputMessageContext.tools = tools;
    if (currentTurn.toolResults.length) {
        userInputMessageContext.toolResults = currentTurn.toolResults;
    }

    return {
        conversationState: {
            conversationId: options.conversationId || crypto.randomUUID(),
            chatTriggerType: 'MANUAL',
            customizationArn: null,
            currentMessage: {
                userInputMessage: {
                    content: currentTurn.content || 'continue',
                    modelId: model,
                    origin: 'AI_EDITOR',
                    userInputMessageContext
                }
            },
            history
        },
        profileArn: options.profileArn || resolveDefaultProfileArn(options.authKey),
        source: 'AI_EDITOR',
        modelId: model,
        origin: 'AI_EDITOR'
    };
}

/** Build headers for CodeWhisperer API requests.
 *  Regenerates the AWS SDK tracking headers per call so each request looks
 *  like a fresh SDK invocation rather than a static proxy fingerprint. */
export function buildKiroHeaders(token, region = 'us-east-1', streaming = false, attempt = 1) {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: streaming ? 'application/vnd.amazon.eventstream' : 'application/json',
        'X-Amz-Region': region,
        'X-Amz-Target': KIRO_CODEWHISPERER_TARGET,
        ...buildAmzSdkHeaders(attempt),
        ...KIRO_HEADERS
    };
}

/** Build a simple chat request for probes. */
export function buildSimpleKiroRequest(prompt, model = 'auto') {
    return {
        conversationState: {
            conversationId: crypto.randomUUID(),
            chatTriggerType: 'MANUAL',
            currentMessage: {
                userInputMessage: {
                    content: prompt,
                    modelId: model,
                    origin: 'AI_EDITOR'
                }
            }
        },
        source: 'AI_EDITOR',
        modelId: model,
        origin: 'AI_EDITOR'
    };
}

export default {
    mapModelToKiro,
    convertAnthropicToKiro,
    buildKiroTools,
    buildKiroRequest,
    buildKiroHeaders,
    buildSimpleKiroRequest
};
