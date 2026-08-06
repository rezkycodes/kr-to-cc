/**
 * Kiro provider (AWS CodeWhisperer).
 *
 * Adapts the Kiro client module to the shared provider contract. The readiness
 * gate here is the old `ensureKiroReady()` from api.routes.js, moved next to the
 * upstream it guards so route handlers no longer need to know that Kiro keeps
 * its credentials in a local CLI database.
 */

import { assertProvider } from '../provider.js';
import { sendKiroMessage } from './message-handler.js';
import { sendKiroMessageStream } from './streaming-handler.js';
import { acquireConnection, isAuthenticated as hasConnection } from './credentials.js';
import { setActiveKiroCredentials } from '../../auth/kiro-token-extractor.js';
import { markConnectionFailed, markConnectionHealthy } from '../../connections/store.js';
import {
    listKiroModels,
    checkActiveModels,
    modelCostMultiplier,
    catalogHasModel
} from './model-api.js';
import {
    isKiroAuthenticated,
    isKiroDatabaseAccessible,
    ensureValidKiroToken
} from '../../auth/kiro-token-extractor.js';

/**
 * Confirm Kiro can serve traffic, refreshing the access token when needed.
 *
 * Refreshing here (rather than only at sign-in) is what lets a long-running
 * proxy keep working without re-running `kiro auth`.
 *
 * @throws {Error} with a message intended for the user
 */
async function ensureReady() {
    // Prefer a connected account. Accounts already on this machine are imported on
    // first look, so an existing CLI or IDE login needs no extra step.
    if (await hasConnection()) {
        const { connection, credentials } = await acquireConnection();
        // Hand the chosen account to the request handlers, which still read one
        // "active" credential.
        setActiveKiroCredentials(credentials);
        activeConnectionId = connection.id;
        return;
    }

    activeConnectionId = null;

    // Nothing connected: fall back to the original single-credential path so an
    // install that predates the connection store keeps working.
    if (!isKiroDatabaseAccessible()) {
        throw new Error(
            'No Kiro account connected, and the Kiro CLI database is not accessible. '
            + 'Add an account on the Providers page.'
        );
    }

    if (!isKiroAuthenticated()) {
        throw new Error(
            'No Kiro account connected. Add one on the Providers page, or run "kiro auth".'
        );
    }

    await ensureValidKiroToken();
}

/** Which account ensureReady() selected, so failures can be attributed to it. */
let activeConnectionId = null;

/** Wrap a dispatch so the account that served it is credited or blamed. */
function attributed(fn) {
    return async (...args) => {
        const id = activeConnectionId;
        try {
            const result = await fn(...args);
            if (id) markConnectionHealthy(id);
            return result;
        } catch (error) {
            if (id) markConnectionFailed(id, error);
            throw error;
        }
    };
}

/** Streaming counterpart: attribute after the generator finishes. */
function attributedStream(fn) {
    return async function* stream(...args) {
        const id = activeConnectionId;
        try {
            yield* fn(...args);
            if (id) markConnectionHealthy(id);
        } catch (error) {
            if (id) markConnectionFailed(id, error);
            throw error;
        }
    };
}

/** @type {import('../provider.js').Provider} */
export const kiroProvider = assertProvider({
    id: 'kiro',
    label: 'Kiro (AWS CodeWhisperer)',
    ensureReady,
    listModels: listKiroModels,
    sendMessage: attributed(sendKiroMessage),
    sendMessageStream: attributedStream(sendKiroMessageStream),
    ownsModel: catalogHasModel,
    costMultiplier: modelCostMultiplier,
    checkActiveModels
});

export default kiroProvider;
