/**
 * Provider connections: storage, rotation, and sign-in parsing.
 *
 * Two things here are load-bearing and easy to get wrong:
 *   - a token must never cross the API boundary, and
 *   - one broken account must not take a provider down.
 * Both are asserted directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    listConnections,
    listUsableConnections,
    getConnection,
    redactConnection,
    saveConnection,
    updateConnection,
    markConnectionFailed,
    markConnectionHealthy,
    deleteConnection,
    reorderConnections,
    __setStorePathForTests
} from '../src/connections/store.js';
import { parseCallback, startAuthorization, resetPending, pendingCount } from '../src/connections/google-oauth.js';
import { parseCliProxyJson } from '../src/routes/kiro-connect.routes.js';

const tempStore = path.join(os.tmpdir(), `kr-connections-${process.pid}.json`);
__setStorePathForTests(tempStore);

test.beforeEach(() => {
    fs.rmSync(tempStore, { force: true });
    __setStorePathForTests(tempStore);
});

test.after(() => {
    fs.rmSync(tempStore, { force: true });
});

/** Add an account with a usable token. */
function addAccount(email, overrides = {}) {
    return saveConnection({
        provider: 'google',
        email,
        credentials: { refreshToken: `refresh-${email}`, accessToken: `access-${email}` },
        ...overrides
    });
}

test('a connection needs a provider and a token', () => {
    assert.throws(() => saveConnection({}), /needs a provider/);
    assert.throws(() => saveConnection({ provider: 'google' }), /needs a token/);
    assert.throws(
        () => saveConnection({ provider: 'google', credentials: {} }),
        /needs a token/
    );
});

test('accounts are appended in order and default to enabled', () => {
    addAccount('a@example.com');
    addAccount('b@example.com');
    addAccount('c@example.com');

    const all = listConnections('google');
    assert.deepEqual(all.map((c) => c.email), ['a@example.com', 'b@example.com', 'c@example.com']);
    assert.deepEqual(all.map((c) => c.priority), [1, 2, 3]);
    assert.ok(all.every((c) => c.enabled === true));
});

test('signing in again with the same account refreshes it rather than duplicating', () => {
    const first = addAccount('same@example.com');
    const second = saveConnection({
        provider: 'google',
        email: 'same@example.com',
        credentials: { refreshToken: 'rotated', accessToken: 'new' }
    });

    assert.equal(second.id, first.id, 'the same account keeps its id');
    assert.equal(listConnections('google').length, 1, 'no duplicate row');
    assert.equal(second.credentials.refreshToken, 'rotated');
    // Re-authenticating is how a user fixes a broken account, so prior failure
    // state must not survive it.
    assert.equal(second.lastError, null);
    assert.equal(second.rateLimitedUntil, null);
});

test('re-authenticating clears a recorded failure', () => {
    const account = addAccount('broken@example.com');
    markConnectionFailed(account.id, new Error('HTTP 429 quota exhausted'));
    assert.ok(getConnection(account.id).lastError);
    assert.ok(getConnection(account.id).rateLimitedUntil);

    addAccount('broken@example.com');
    assert.equal(getConnection(account.id).lastError, null);
});

test('credentials never cross the API boundary', () => {
    const account = saveConnection({
        provider: 'google',
        email: 'secret@example.com',
        credentials: {
            refreshToken: 'SECRET-REFRESH',
            accessToken: 'SECRET-ACCESS',
            idToken: 'SECRET-ID',
            projectId: 'proj-visible',
            expiresAt: 123
        }
    });

    const redacted = redactConnection(account);
    const serialised = JSON.stringify(redacted);
    for (const secret of ['SECRET-REFRESH', 'SECRET-ACCESS', 'SECRET-ID']) {
        assert.ok(!serialised.includes(secret), `${secret} must not be exposed`);
    }
    // Enough state to render the UI, and nothing usable.
    assert.equal(redacted.credentials.hasRefreshToken, true);
    assert.equal(redacted.credentials.projectId, 'proj-visible');
    assert.equal(redacted.credentials.expiresAt, 123);
    assert.equal(redacted.email, 'secret@example.com');
});

test('usable accounts exclude disabled and rate-limited ones', () => {
    const a = addAccount('a@example.com');
    const b = addAccount('b@example.com');
    const c = addAccount('c@example.com');

    updateConnection(b.id, { enabled: false });
    updateConnection(c.id, {
        rateLimitedUntil: new Date(Date.now() + 60_000).toISOString()
    });

    const usable = listUsableConnections('google');
    assert.deepEqual(usable.map((x) => x.id), [a.id]);

    // A lapsed rate limit brings the account back on its own.
    updateConnection(c.id, { rateLimitedUntil: new Date(Date.now() - 1000).toISOString() });
    assert.equal(listUsableConnections('google').length, 2);
});

test('a past error does not remove an account from rotation', () => {
    const account = addAccount('flaky@example.com');
    // Not a quota error, so nothing is parked: one transient failure must not
    // quietly cost capacity.
    markConnectionFailed(account.id, new Error('connection reset'));

    const stored = getConnection(account.id);
    assert.ok(stored.lastError, 'the failure is recorded');
    assert.equal(stored.rateLimitedUntil, null, 'but the account is not parked');
    assert.equal(listUsableConnections('google').length, 1, 'and it still serves');
});

test('a quota failure parks the account for a while', () => {
    const account = addAccount('busy@example.com');
    markConnectionFailed(account.id, new Error('Google quota exhausted (HTTP 429)'));

    const stored = getConnection(account.id);
    assert.ok(stored.rateLimitedUntil, 'quota errors park the account');
    assert.ok(Date.parse(stored.rateLimitedUntil) > Date.now());
    assert.equal(listUsableConnections('google').length, 0);
});

test('marking healthy clears failure state', () => {
    const account = addAccount('recovered@example.com');
    markConnectionFailed(account.id, new Error('HTTP 429 quota'));
    markConnectionHealthy(account.id);

    const stored = getConnection(account.id);
    assert.equal(stored.lastError, null);
    assert.equal(stored.rateLimitedUntil, null);
    assert.ok(stored.lastTested, 'a successful test is recorded');
    assert.equal(listUsableConnections('google').length, 1);
});

test('reordering sets the rotation order', () => {
    const a = addAccount('a@example.com');
    const b = addAccount('b@example.com');
    const c = addAccount('c@example.com');

    reorderConnections('google', [c.id, a.id, b.id]);
    assert.deepEqual(
        listConnections('google').map((x) => x.email),
        ['c@example.com', 'a@example.com', 'b@example.com']
    );
});

test('providers are isolated from each other', () => {
    addAccount('g@example.com');
    saveConnection({
        provider: 'kiro',
        email: 'k@example.com',
        credentials: { refreshToken: 'kiro-token' }
    });

    assert.equal(listConnections('google').length, 1);
    assert.equal(listConnections('kiro').length, 1);
    assert.equal(listConnections().length, 2, 'no filter returns everything');
});

test('deleting is idempotent', () => {
    const account = addAccount('gone@example.com');
    assert.equal(deleteConnection(account.id), true);
    assert.equal(deleteConnection(account.id), false, 'deleting twice is not an error');
    assert.equal(getConnection(account.id), null);
});

test('updating a missing connection reports rather than throws', () => {
    assert.equal(updateConnection('no-such-id', { enabled: false }), null);
    assert.equal(getConnection('no-such-id'), null);
});

test('a credential update merges rather than replaces', () => {
    const account = saveConnection({
        provider: 'google',
        email: 'merge@example.com',
        credentials: { refreshToken: 'keep-me', accessToken: 'old', projectId: 'proj' }
    });

    // Refreshing an access token must not drop the refresh token.
    updateConnection(account.id, { credentials: { accessToken: 'new', expiresAt: 999 } });

    const stored = getConnection(account.id);
    assert.equal(stored.credentials.refreshToken, 'keep-me');
    assert.equal(stored.credentials.accessToken, 'new');
    assert.equal(stored.credentials.projectId, 'proj');
    assert.equal(stored.credentials.expiresAt, 999);
});

test('the store is written owner-only', () => {
    addAccount('perm@example.com');
    const mode = fs.statSync(tempStore).mode & 0o777;
    // The file holds refresh tokens.
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('the authorization URL carries what Google needs for a refresh token', () => {
    resetPending();
    const { authUrl, state } = startAuthorization('http://127.0.0.1:4000/oauth/google/callback');
    const url = new URL(authUrl);

    assert.equal(url.host, 'accounts.google.com');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:4000/oauth/google/callback');
    // Both are required: without them a repeat authorisation returns no refresh
    // token, and the account dies an hour later.
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.ok(url.searchParams.get('scope').includes('cloud-platform'));
    assert.ok(state && state.length >= 16, 'state must be unguessable');
    assert.equal(pendingCount(), 1);
});

test('a pasted callback URL is parsed, and bad input is explained', () => {
    // A full URL is what a user copies from the address bar.
    const full = parseCallback('http://127.0.0.1:4000/oauth/google/callback?code=abc123&state=xyz');
    assert.equal(full.code, 'abc123');
    assert.equal(full.state, 'xyz');

    // A bare query string also works, since what gets copied varies.
    assert.equal(parseCallback('?code=only-code').code, 'only-code');

    assert.throws(() => parseCallback(''), /Paste the URL/);
    assert.throws(() => parseCallback('   '), /Paste the URL/);
    // Each failure names what is wrong rather than saying "invalid".
    assert.throws(() => parseCallback('http://x/cb?error=access_denied'), /access_denied/);
    assert.throws(() => parseCallback('http://x/cb?foo=bar'), /no authorization code/);
});

test('pending sign-ins are capped so abandoned flows cannot grow the map', () => {
    resetPending();
    for (let i = 0; i < 30; i += 1) {
        startAuthorization(`http://127.0.0.1:4000/oauth/google/callback?i=${i}`);
    }
    assert.ok(pendingCount() <= 16, `expected at most 16 pending, got ${pendingCount()}`);
});

test('an account with no email is identified by its refresh token', () => {
    // Imported credentials have no email until a token has been used, so without
    // this fallback every re-import would add a duplicate of the same account.
    const first = saveConnection({
        provider: 'kiro',
        label: 'Kiro CLI (database)',
        credentials: { refreshToken: 'same-token' }
    });
    const second = saveConnection({
        provider: 'kiro',
        label: 'Kiro CLI (database)',
        credentials: { refreshToken: 'same-token' }
    });

    assert.equal(second.id, first.id, 'the same credential is the same account');
    assert.equal(listConnections('kiro').length, 1, 'no duplicate row');

    // A different token is genuinely a different account.
    saveConnection({ provider: 'kiro', label: 'Kiro IDE', credentials: { refreshToken: 'other' } });
    assert.equal(listConnections('kiro').length, 2);
});

test('CLIProxyAPI JSON is read from any of its known shapes', () => {
    // Flat.
    assert.equal(parseCliProxyJson('{"refresh_token":"flat"}').refreshToken, 'flat');
    // Nested under external_idp, which is the documented shape.
    const nested = parseCliProxyJson('{"external_idp":{"refresh_token":"nested","region":"eu-central-1"}}');
    assert.equal(nested.refreshToken, 'nested');
    assert.equal(nested.region, 'eu-central-1');
    // camelCase variant.
    assert.equal(parseCliProxyJson('{"auth":{"refreshToken":"camel"}}').refreshToken, 'camel');

    // A CLIProxyAPI export is an SSO OIDC credential unless it says otherwise;
    // guessing "social" here would pick the wrong refresh protocol.
    assert.equal(parseCliProxyJson('{"refresh_token":"x"}').authKey, 'kirocli:odic:token');
    assert.equal(
        parseCliProxyJson('{"refresh_token":"x","authKey":"kirocli:social:token"}').authKey,
        'kirocli:social:token'
    );
});

test('bad CLIProxyAPI input says what is wrong', () => {
    assert.throws(() => parseCliProxyJson(''), /Paste the JSON/);
    assert.throws(() => parseCliProxyJson('   '), /Paste the JSON/);
    assert.throws(() => parseCliProxyJson('not json'), /not valid JSON/);
    // Valid JSON with nothing usable is a different mistake from malformed JSON.
    assert.throws(() => parseCliProxyJson('{"foo":1}'), /No refresh token/);
    assert.throws(() => parseCliProxyJson('{"external_idp":{}}'), /No refresh token/);
});

test('a spent allowance parks the account whatever the upstream calls it', () => {
    // Wording and status differ by upstream. Kiro's real message is a 402 saying
    // "You have reached the limit"; matching only 429/quota left such an account in
    // rotation, failing every request it was handed.
    for (const message of [
        'Google quota exhausted (HTTP 429): limit',
        'Kiro API error 402: {"message":"You have reached the limit."}',
        'rate limit exceeded',
        'insufficient credits'
    ]) {
        const account = saveConnection({
            provider: 'google',
            email: `${message.slice(0, 8)}@example.com`,
            credentials: { refreshToken: `t-${message.slice(0, 8)}` }
        });
        markConnectionFailed(account.id, new Error(message));
        const stored = getConnection(account.id);
        assert.ok(stored.rateLimitedUntil, `should park on: ${message}`);
    }
});

test('an ordinary failure still leaves the account in rotation', () => {
    // The widened pattern must not swallow unrelated errors, or one network blip
    // would sideline an account for ten minutes.
    const account = saveConnection({
        provider: 'google',
        email: 'plain@example.com',
        credentials: { refreshToken: 'plain' }
    });
    markConnectionFailed(account.id, new Error('socket hang up'));
    const stored = getConnection(account.id);
    assert.ok(stored.lastError);
    assert.equal(stored.rateLimitedUntil, null, 'must not park on a transient error');
});

test('Kiro quota is account-scoped, not per model', async () => {
    // Kiro meters credits for the whole account; every model draws from the same
    // allowance at its own multiplier. Presenting one number as per-model would be
    // wrong, so the shape says which it is.
    const { getKiroUsageLimits } = await import('../src/providers/kiro/usage.js');
    const usage = await getKiroUsageLimits();

    assert.equal(usage.scope, 'account');
    assert.ok(Array.isArray(usage.quotas));
    // Either it read real limits, or it says why not — never a fabricated
    // "unlimited", which the previous stub returned and which read as headroom
    // that did not exist.
    if (usage.error) {
        assert.match(usage.error, /Could not read Kiro usage|Not authenticated/);
    } else {
        for (const quota of usage.quotas) {
            assert.equal(typeof quota.used, 'number');
            assert.equal(typeof quota.total, 'number');
            // Null rather than 0 when there is no limit to divide by, so "spent"
            // is distinguishable from "no limit reported".
            if (quota.total === 0) assert.equal(quota.remainingFraction, null);
            else assert.ok(quota.remainingFraction >= 0 && quota.remainingFraction <= 1);
        }
    }
});
