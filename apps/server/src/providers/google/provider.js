/**
 * Google provider (Antigravity / Gemini Code Assist).
 *
 * Serves Gemini models, plus the Claude and open-weight models Antigravity
 * exposes, through Google's private Cloud Code API.
 *
 * Note the overlap with Kiro: both offer `claude-sonnet-4-6`. Bare ids resolve to
 * Kiro because it is registered first, so use `google/claude-sonnet-4-6` to reach
 * this one.
 */

import { assertProvider } from '../provider.js';
import { acquireConnection, isAuthenticated } from './credentials.js';
import { sendGoogleMessage, sendGoogleMessageStream } from './message-handler.js';
import { listModels, ownsModel, costMultiplier, refreshCatalog } from './models.js';

/**
 * Confirm Google can serve traffic.
 *
 * Refreshing the token and resolving the project both happen here, so a request
 * never discovers mid-flight that it has no project. The catalog refresh is
 * deliberately not awaited: a stale model list is fine, a blocked request is not.
 *
 * @throws {Error} with a message intended for the user
 */
async function ensureReady() {
    if (!isAuthenticated()) {
        throw new Error(
            'No Google account connected. Add one on the Providers page, or authenticate the '
            + 'Antigravity CLI on this machine and it will be imported.'
        );
    }

    // Proves at least one account can actually serve, rather than only that a
    // credential exists on disk.
    const { accessToken, projectId } = await acquireConnection();
    refreshCatalog(accessToken, projectId).catch(() => {});
}

/** @type {import('../provider.js').Provider} */
export const googleProvider = assertProvider({
    id: 'google',
    label: 'Google (Antigravity)',
    ensureReady,
    listModels: async () => listModels(),
    sendMessage: sendGoogleMessage,
    sendMessageStream: sendGoogleMessageStream,
    ownsModel,
    costMultiplier
});

export default googleProvider;
