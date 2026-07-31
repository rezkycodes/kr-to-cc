/**
 * Streaming handler for Kiro/AWS CodeWhisperer.
 */

import {
    KIRO_API_PATHS,
    KIRO_DEFAULT_REGION,
    MAX_RETRIES,
    UPSTREAM_TIMEOUT_MS,
    getKiroEndpoint
} from '../constants.js';
import { getKiroAuthData } from '../auth/kiro-token-extractor.js';
import { buildKiroRequest, buildKiroHeaders, mapModelToKiro } from './request-builder.js';
import { parseEventStreamAsync } from './aws-event-stream.js';
import { AnthropicStreamState } from './stream-converter.js';
import { logger } from '../utils/logger.js';
import { createAbortContext, sleep } from '../utils/helpers.js';

/** Send a streaming request and yield Anthropic Messages SSE event objects. */
export async function* sendKiroMessageStream(anthropicRequest) {
    const model = anthropicRequest.model;
    const kiroModel = mapModelToKiro(model);
    logger.debug(`[Kiro] Starting stream for model: ${model} -> ${kiroModel}`);

    const authData = await getKiroAuthData();
    const token = authData.accessToken;
    const region = authData.region || KIRO_DEFAULT_REGION;
    if (!token) {
        throw new Error('No Kiro authentication token available. Please log in to Kiro CLI first.');
    }

    const payload = buildKiroRequest(anthropicRequest, { profileArn: authData.profileArn });
    const headers = {
        ...buildKiroHeaders(token, region, true),
        'x-amzn-access-model': kiroModel
    };
    const url = `${getKiroEndpoint(region)}${KIRO_API_PATHS.GENERATE_ASSISTANT}`;
    logger.debug(`[Kiro] Stream URL: ${url}`);

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
                logger.warn(`[Kiro] Stream error ${response.status}: ${errorText}`);

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
                throw new Error(`Kiro API error ${response.status}: ${errorText}`);
            }

            yield* streamKiroResponse(response, model);
            return;
        } catch (error) {
            if (error.name === 'AbortError') {
                if (anthropicRequest.signal?.aborted) throw error;
                throw new Error(`Kiro stream timed out after ${UPSTREAM_TIMEOUT_MS}ms.`);
            }
            if (error.message.includes('authentication') || error.message.includes('expired')) throw error;
            if (attempt === MAX_RETRIES - 1) throw error;
            logger.warn(`[Kiro] Stream attempt ${attempt + 1} failed: ${error.message}`);
            await sleep(2 ** attempt * 1000);
        } finally {
            abortContext.cleanup();
        }
    }

    throw new Error('Max retries exceeded');
}

/** Parse AWS event stream frames and convert each event incrementally. */
export async function* streamKiroResponse(response, requestModel) {
    if (!response.body) throw new Error('Kiro streaming response had no body.');
    const state = new AnthropicStreamState(requestModel);

    for await (const event of parseEventStreamAsync(response.body)) {
        for (const anthropicEvent of state.push(event)) yield anthropicEvent;
    }
    for (const anthropicEvent of state.finish()) yield anthropicEvent;
}

export default { sendKiroMessageStream };
