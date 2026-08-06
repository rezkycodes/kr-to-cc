/**
 * Non-streaming message handler for Kiro/AWS CodeWhisperer.
 */

import crypto from 'crypto';
import {
    KIRO_API_PATHS,
    KIRO_DEFAULT_REGION,
    MAX_RETRIES,
    UPSTREAM_TIMEOUT_MS,
    getKiroEndpoint
} from '../../constants.js';
import { getKiroAuthData } from '../../auth/kiro-token-extractor.js';
import {
    buildKiroRequest,
    buildKiroHeaders,
    buildKiroToolNameMap,
    mapModelToKiro,
    restoreAnthropicToolName
} from './request-builder.js';
import { parseEventStream, extractContentFromEvents } from './aws-event-stream.js';
import { logger } from '../../utils/logger.js';
import { createAbortContext, sleep } from '../../utils/helpers.js';

export async function sendKiroMessage(anthropicRequest) {
    const model = anthropicRequest.model;
    const kiroModel = mapModelToKiro(model);
    logger.debug(`[Kiro] Sending request for model: ${model} -> ${kiroModel}`);

    const authData = await getKiroAuthData();
    const token = authData.accessToken;
    const region = authData.region || KIRO_DEFAULT_REGION;
    if (!token) {
        throw new Error('No Kiro authentication token available. Please log in to Kiro CLI first.');
    }

    const toolNameMap = buildKiroToolNameMap(anthropicRequest.tools);
    const payload = buildKiroRequest(anthropicRequest, { profileArn: authData.profileArn });
    const headers = {
        ...buildKiroHeaders(token, region, false),
        'x-amzn-access-model': kiroModel
    };
    const url = `${getKiroEndpoint(region)}${KIRO_API_PATHS.GENERATE_ASSISTANT}`;
    logger.debug(`[Kiro] Request URL: ${url}`);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const abortContext = createAbortContext(anthropicRequest.signal, UPSTREAM_TIMEOUT_MS);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: abortContext.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.warn(`[Kiro] Error ${response.status}: ${errorText}`);

                if (response.status === 401) {
                    throw new Error('Kiro authentication expired. Please log in again.');
                }
                if (response.status === 429) {
                    const retryAfter = Number.parseInt(response.headers.get('retry-after') || '', 10);
                    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 5000;
                    logger.warn(`[Kiro] Rate limited, waiting ${waitMs}ms...`);
                    await sleep(waitMs);
                    continue;
                }
                if (response.status >= 500) {
                    const waitMs = 2 ** attempt * 1000;
                    logger.warn(`[Kiro] Server error, retrying in ${waitMs}ms...`);
                    await sleep(waitMs);
                    continue;
                }
                const upstreamError = new Error(`Kiro API error ${response.status}: ${errorText}`);
                upstreamError.statusCode = response.status;
                throw upstreamError;
            }

            const buffer = await response.arrayBuffer();
            const extracted = extractContentFromEvents(parseEventStream(buffer));
            const contentBlocks = [];
            if (extracted.content) contentBlocks.push({ type: 'text', text: extracted.content });

            let stopReason = 'end_turn';
            for (const tool of extracted.toolUses) {
                contentBlocks.push({
                    type: 'tool_use',
                    id: tool.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    name: restoreAnthropicToolName(tool.name, toolNameMap),
                    input: tool.input || {}
                });
                stopReason = 'tool_use';
            }

            return {
                id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                type: 'message',
                role: 'assistant',
                model,
                content: contentBlocks.length ? contentBlocks : [{ type: 'text', text: '' }],
                stop_reason: stopReason,
                stop_sequence: null,
                usage: extracted.usage
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                if (anthropicRequest.signal?.aborted) throw error;
                throw new Error(`Kiro request timed out after ${UPSTREAM_TIMEOUT_MS}ms.`);
            }
            if (error.message.includes('authentication') || error.message.includes('expired')) throw error;
            if (Number.isInteger(error.statusCode) && error.statusCode < 500) throw error;
            if (attempt === MAX_RETRIES - 1) throw error;
            logger.warn(`[Kiro] Attempt ${attempt + 1} failed: ${error.message}`);
            await sleep(2 ** attempt * 1000);
        } finally {
            abortContext.cleanup();
        }
    }

    throw new Error('Max retries exceeded');
}

export default { sendKiroMessage };
