import test from 'node:test';
import assert from 'node:assert/strict';

import { isSocialAuthKey, refreshKiroToken } from '../src/auth/token-refresher.js';

// --- isSocialAuthKey ---

test('isSocialAuthKey returns true when authKey contains "social"', () => {
    assert.equal(isSocialAuthKey('social-12345'), true);
    assert.equal(isSocialAuthKey('kiro-social-google'), true);
    assert.equal(isSocialAuthKey('SOCIAL_TOKEN'), false); // case-sensitive
    assert.equal(isSocialAuthKey('prefix-social-suffix'), true);
});

test('isSocialAuthKey returns false for non-social authKey strings', () => {
    assert.equal(isSocialAuthKey('sso-abc'), false);
    assert.equal(isSocialAuthKey('aws-oidc-key'), false);
    assert.equal(isSocialAuthKey(''), false);
});

test('isSocialAuthKey returns false for non-string inputs', () => {
    assert.equal(isSocialAuthKey(null), false);
    assert.equal(isSocialAuthKey(undefined), false);
    assert.equal(isSocialAuthKey(123), false);
    assert.equal(isSocialAuthKey({}), false);
});

// --- refreshKiroToken: routes to correct mechanism ---

// Helper: install a global fetch mock that returns a successful token response.
function mockFetchSuccess(body) {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body)
    });
    return () => { globalThis.fetch = orig; };
}

function mockFetchFailure(status, text) {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: false,
        status,
        text: async () => text
    });
    return () => { globalThis.fetch = orig; };
}

test('refreshKiroToken calls Desktop endpoint when authKey contains "social"', async () => {
    let calledUrl = '';
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, _opts) => {
        calledUrl = url;
        return {
            ok: true,
            json: async () => ({ accessToken: 'new-at', refreshToken: 'new-rt', expiresIn: 3600 })
        };
    };
    try {
        const result = await refreshKiroToken({
            authKey: 'social-token',
            refreshToken: 'old-rt',
            region: 'us-east-1'
        });
        assert.ok(calledUrl.includes('auth.desktop.kiro.dev'), `Expected desktop URL, got: ${calledUrl}`);
        assert.equal(result.accessToken, 'new-at');
        assert.equal(result.refreshToken, 'new-rt');
        assert.ok(result.expiresAt instanceof Date);
    } finally {
        globalThis.fetch = orig;
    }
});

test('refreshKiroToken calls SSO OIDC endpoint when authKey is not social', async () => {
    let calledUrl = '';
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, _opts) => {
        calledUrl = url;
        return {
            ok: true,
            json: async () => ({ accessToken: 'sso-at', refreshToken: 'sso-rt', expiresIn: 7200 })
        };
    };
    try {
        const result = await refreshKiroToken({
            authKey: 'oidc-registration-key',
            refreshToken: 'old-rt',
            clientId: 'cid',
            clientSecret: 'csec',
            region: 'us-east-1'
        });
        assert.ok(calledUrl.includes('oidc') && calledUrl.includes('amazonaws.com'), `Expected SSO URL, got: ${calledUrl}`);
        assert.equal(result.accessToken, 'sso-at');
    } finally {
        globalThis.fetch = orig;
    }
});

test('refreshKiroToken (social) uses default region when none provided', async () => {
    let calledUrl = '';
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
        calledUrl = url;
        return {
            ok: true,
            json: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 })
        };
    };
    try {
        await refreshKiroToken({ authKey: 'social-x', refreshToken: 'rt' });
        assert.ok(calledUrl.length > 0);
        // URL should contain some region (the default)
        assert.ok(calledUrl.includes('auth.desktop.kiro.dev'));
    } finally {
        globalThis.fetch = orig;
    }
});

test('refreshKiroToken (social) throws when refreshToken is absent', async () => {
    await assert.rejects(
        () => refreshKiroToken({ authKey: 'social-x' }),
        /No refresh token/
    );
});

test('refreshKiroToken (SSO) throws when refreshToken is absent', async () => {
    await assert.rejects(
        () => refreshKiroToken({ authKey: 'oidc-key', clientId: 'cid', clientSecret: 'cs' }),
        /No refresh token/
    );
});

test('refreshKiroToken (SSO) throws when clientId/clientSecret is absent', async () => {
    await assert.rejects(
        () => refreshKiroToken({ authKey: 'oidc-key', refreshToken: 'rt' }),
        /clientId\/clientSecret/
    );
});

test('refreshKiroToken (social) throws when HTTP response is not ok', async () => {
    const restore = mockFetchFailure(401, 'Unauthorized');
    try {
        await assert.rejects(
            () => refreshKiroToken({ authKey: 'social-x', refreshToken: 'rt' }),
            /Kiro Desktop refresh failed 401/
        );
    } finally {
        restore();
    }
});

test('refreshKiroToken (SSO) throws when HTTP response is not ok', async () => {
    const restore = mockFetchFailure(403, 'Forbidden');
    try {
        await assert.rejects(
            () => refreshKiroToken({ authKey: 'oidc-key', refreshToken: 'rt', clientId: 'cid', clientSecret: 'cs' }),
            /AWS SSO OIDC refresh failed 403/
        );
    } finally {
        restore();
    }
});

test('refreshKiroToken (social) throws when response is missing accessToken', async () => {
    const restore = mockFetchSuccess({ refreshToken: 'rt' }); // no accessToken
    try {
        await assert.rejects(
            () => refreshKiroToken({ authKey: 'social-x', refreshToken: 'rt' }),
            /missing accessToken/
        );
    } finally {
        restore();
    }
});

test('refreshKiroToken (SSO) throws when response is missing accessToken', async () => {
    const restore = mockFetchSuccess({ refreshToken: 'rt' }); // no accessToken
    try {
        await assert.rejects(
            () => refreshKiroToken({ authKey: 'oidc-key', refreshToken: 'rt', clientId: 'cid', clientSecret: 'cs' }),
            /missing accessToken/
        );
    } finally {
        restore();
    }
});

test('refreshKiroToken (social) uses default expiresIn when not provided', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ accessToken: 'at' }) // no expiresIn
    });
    try {
        const result = await refreshKiroToken({ authKey: 'social-x', refreshToken: 'rt' });
        // expiresAt should be ~1 hour from now (3600 - 60 seconds)
        const diff = result.expiresAt.getTime() - Date.now();
        assert.ok(diff > 3500_000 && diff < 3600_000, `Unexpected expiresAt diff: ${diff}ms`);
    } finally {
        globalThis.fetch = orig;
    }
});
