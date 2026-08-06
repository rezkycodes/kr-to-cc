/**
 * Heuristic token estimation.
 *
 * Kiro's CodeWhisperer backend does not return token usage — the streams carry no
 * `tokenUsage` metadata, so a completed request reports 0 in / 0 out even when it
 * produced text. To make token monitoring useful at all, counts are estimated
 * locally from the text that crossed the boundary, and every surface that shows
 * them marks them as estimates.
 *
 * The same ~4-characters-per-token approximation backs `/v1/messages/count_tokens`,
 * so the number the dashboard shows and the number that endpoint returns agree.
 * It is rough: fine for spotting a runaway context, wrong for billing.
 */

/** Characters per token in the approximation. */
const CHARS_PER_TOKEN = 4;

/**
 * Flatten an Anthropic content value — string, block array, or object — into the
 * text it represents, for length-based estimation only.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function flattenContent(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (typeof item === 'string') return item;
                if (item && typeof item === 'object') {
                    // Text/content blocks, tool blocks, etc.
                    return item.text || item.content
                        ? (typeof item.content === 'string'
                            ? item.content
                            : JSON.stringify(item.content || item.text))
                        : JSON.stringify(item);
                }
                return '';
            })
            .join('\n');
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/**
 * Estimate tokens for a character count.
 * @param {number} characters
 * @returns {number} at least 1 when there is any text, else 0
 */
export function estimateTokensForLength(characters) {
    const length = Number(characters);
    if (!Number.isFinite(length) || length <= 0) return 0;
    return Math.max(1, Math.ceil(length / CHARS_PER_TOKEN));
}

/**
 * Estimate tokens for a piece of text or content value.
 * @param {unknown} value
 * @returns {number}
 */
export function estimateTokens(value) {
    return estimateTokensForLength(flattenContent(value).length);
}

/**
 * Estimate the prompt size of an Anthropic Messages request.
 *
 * Counts system prompt, every message, and tool definitions — the whole payload
 * the model has to read.
 *
 * @param {{ system?: unknown, messages?: unknown, tools?: unknown }} body
 * @returns {number}
 */
export function estimateRequestTokens(body = {}) {
    const parts = [flattenContent(body.system)];
    if (Array.isArray(body.messages)) {
        for (const message of body.messages) parts.push(flattenContent(message?.content));
    }
    if (body.tools) parts.push(flattenContent(body.tools));
    return estimateTokensForLength(parts.join('\n').length);
}

/**
 * Total text length across an Anthropic response's content blocks.
 * @param {{ content?: unknown }} response
 * @returns {number}
 */
export function responseTextLength(response) {
    return flattenContent(response?.content).length;
}

export default {
    flattenContent,
    estimateTokens,
    estimateTokensForLength,
    estimateRequestTokens,
    responseTextLength
};
