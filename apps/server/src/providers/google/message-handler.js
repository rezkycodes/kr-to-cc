/**
 * Google (Antigravity) message dispatch.
 *
 * Turns an Anthropic Messages request into an upstream call and translates the
 * result back. Everything provider-specific — auth, project, envelope, dialect —
 * is resolved here so callers only see Anthropic shapes.
 */

import { ANTIGRAVITY_USER_AGENT, endpoints } from './constants.js';
// Shared with the Kiro provider so one env var governs both upstreams.
import { UPSTREAM_TIMEOUT_MS } from '../../constants.js';
import { acquireConnection } from './credentials.js';
import { ensureProject } from './project.js';
import { markConnectionFailed, markConnectionHealthy, updateConnection } from '../../connections/store.js';
import { buildGoogleRequest } from './request-builder.js';
import { convertResponse, StreamConverter, parseSSE } from './response-converter.js';
import { refreshCatalog } from './models.js';
import { logger } from '../../utils/logger.js';

/** Headers for a generation call. */
function generateHeaders(accessToken) {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': ANTIGRAVITY_USER_AGENT
    };
}

/**
 * Prepare credentials, project, and the translated request.
 * @param {object} request Anthropic Messages request
 * @param {boolean} stream
 */
async function prepare(request, stream) {
    const { connection, accessToken, projectId: known } = await acquireConnection();

    // Each account has its own Code Assist project. Resolved once and cached on
    // the connection, since it does not change.
    let projectId = known;
    if (!projectId) {
        projectId = await ensureProject(accessToken);
        updateConnection(connection.id, { credentials: { projectId } });
    }

    // Opportunistic and non-fatal: keeps the catalog and quota figures current.
    refreshCatalog(accessToken, projectId).catch(() => {});

    const { body, toolNames } = buildGoogleRequest(request, { projectId, stream });
    return { connection, accessToken, body, toolNames };
}

/**
 * Turn an upstream failure into an error whose message is worth reading.
 *
 * The upstream returns a JSON error envelope; surfacing its message is far more
 * useful than the status code alone.
 */
async function upstreamError(response) {
    const raw = await response.text().catch(() => '');
    let message = raw.slice(0, 300);
    try {
        const parsed = JSON.parse(raw);
        message = parsed?.error?.message || message;
    } catch {
        // Non-JSON body; the raw text is the best we have.
    }

    if (response.status === 401 || response.status === 403) {
        return new Error(`Google rejected the request (HTTP ${response.status}): ${message}`);
    }
    if (response.status === 429) {
        return new Error(`Google quota exhausted (HTTP 429): ${message}`);
    }
    return new Error(`Google API error ${response.status}: ${message}`);
}

/**
 * Non-streaming completion.
 *
 * @param {object} request Anthropic Messages request
 * @returns {Promise<object>} Anthropic Messages response
 */
export async function sendGoogleMessage(request) {
    const { connection, accessToken, body, toolNames } = await prepare(request, false);

    const response = await fetch(endpoints.generate(false), {
        method: 'POST',
        headers: generateHeaders(accessToken),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });

    if (!response.ok) {
        const error = await upstreamError(response);
        // Attribute the failure to the account that hit it, so a quota-exhausted
        // account steps out of rotation instead of failing every request.
        markConnectionFailed(connection.id, error);
        throw error;
    }

    markConnectionHealthy(connection.id);
    const payload = await response.json();
    return convertResponse(payload, { model: request.model, toolNames });
}

/**
 * Streaming completion.
 *
 * Yields Anthropic SSE event objects. `finish()` runs in a finally block so a
 * client disconnect still closes any open content block — an unterminated block
 * leaves clients waiting.
 *
 * @param {object} request Anthropic Messages request
 * @returns {AsyncGenerator<object>}
 */
export async function* sendGoogleMessageStream(request) {
    const { connection, accessToken, body, toolNames } = await prepare(request, true);

    const response = await fetch(endpoints.generate(true), {
        method: 'POST',
        headers: generateHeaders(accessToken),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });

    if (!response.ok) {
        const error = await upstreamError(response);
        markConnectionFailed(connection.id, error);
        throw error;
    }
    if (!response.body) throw new Error('Google returned an empty stream.');
    markConnectionHealthy(connection.id);

    const converter = new StreamConverter({ model: request.model, toolNames });
    let sawChunk = false;

    try {
        for await (const chunk of parseSSE(response.body)) {
            sawChunk = true;
            yield* converter.convertChunk(chunk);
        }
    } finally {
        yield* converter.finish();
    }

    if (!sawChunk) {
        logger.warn?.('[Google] Stream produced no chunks');
    }
}

export default { sendGoogleMessage, sendGoogleMessageStream };
