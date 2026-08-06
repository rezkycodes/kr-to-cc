import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
    listConnections,
    listUsableConnections,
    getConnection,
    saveConnection,
    updateConnection,
    markConnectionFailed,
    markConnectionHealthy,
    deleteConnection,
    reorderConnections,
    redactConnection,
    clearCache,
    __setStorePathForTests,
    QUOTA_EXHAUSTED_PATTERN,
} from '../src/connections/store.js';

// Point the store at a temp file for every test so real config is never touched.
function makeStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-test-'));
    const file = path.join(dir, 'connections.json');
    __setStorePathForTests(file);
    clearCache();
    return () => {
        __setStorePathForTests(null);
        clearCache();
        fs.rmSync(dir, { recursive: true, force: true });
    };
}

// --- listConnections ---

test('listConnections returns empty array when store does not exist', () => {
    const cleanup = makeStore();
    try {
        assert.deepEqual(listConnections(), []);
    } finally {
        cleanup();
    }
});

test('listConnections returns all saved connections', () => {
    const cleanup = makeStore();
    try {
        saveConnection({ provider: 'kiro', credentials: { refreshToken: 'rt1' } });
        saveConnection({ provider: 'google', credentials: { refreshToken: 'rt2' } });
        assert.equal(listConnections().length, 2);
    } finally {
        cleanup();
    }
});

test('listConnections filters by provider', () => {
    const cleanup = makeStore();
    try {
        saveConnection({ provider: 'kiro', credentials: { refreshToken: 'rt-kiro' } });
        saveConnection({ provider: 'google', credentials: { refreshToken: 'rt-google' } });
        const kiro = listConnections('kiro');
        assert.equal(kiro.length, 1);
        assert.equal(kiro[0].provider, 'kiro');
    } finally {
        cleanup();
    }
});

test('listConnections sorts by priority', () => {
    const cleanup = makeStore();
    try {
        const a = saveConnection({ provider: 'kiro', email: 'a@x.com', credentials: { refreshToken: 'rt-a' } });
        const b = saveConnection({ provider: 'kiro', email: 'b@x.com', credentials: { refreshToken: 'rt-b' } });
        reorderConnections('kiro', [b.id, a.id]);
        const ordered = listConnections('kiro');
        assert.equal(ordered[0].id, b.id);
        assert.equal(ordered[1].id, a.id);
    } finally {
        cleanup();
    }
});

// --- saveConnection ---

test('saveConnection throws when provider is missing', () => {
    const cleanup = makeStore();
    try {
        assert.throws(
            () => saveConnection({ credentials: { refreshToken: 'rt' } }),
            /provider/
        );
    } finally {
        cleanup();
    }
});

test('saveConnection throws when no token is present', () => {
    const cleanup = makeStore();
    try {
        assert.throws(
            () => saveConnection({ provider: 'kiro', credentials: {} }),
            /token/
        );
    } finally {
        cleanup();
    }
});

test('saveConnection deduplicates by email', () => {
    const cleanup = makeStore();
    try {
        saveConnection({ provider: 'kiro', email: 'u@x.com', credentials: { refreshToken: 'rt1' } });
        saveConnection({ provider: 'kiro', email: 'u@x.com', credentials: { refreshToken: 'rt2' } });
        assert.equal(listConnections('kiro').length, 1);
    } finally {
        cleanup();
    }
});

test('saveConnection deduplicates by refresh token when no email', () => {
    const cleanup = makeStore();
    try {
        saveConnection({ provider: 'kiro', credentials: { refreshToken: 'same-rt' } });
        saveConnection({ provider: 'kiro', credentials: { refreshToken: 'same-rt' } });
        assert.equal(listConnections('kiro').length, 1);
    } finally {
        cleanup();
    }
});

test('saveConnection returns the stored connection', () => {
    const cleanup = makeStore();
    try {
        const conn = saveConnection({ provider: 'kiro', email: 'x@x.com', credentials: { refreshToken: 'rt' } });
        assert.equal(conn.provider, 'kiro');
        assert.equal(conn.email, 'x@x.com');
        assert.ok(conn.id);
    } finally {
        cleanup();
    }
});

// --- getConnection ---

test('getConnection returns connection by id', () => {
    const cleanup = makeStore();
    try {
        const saved = saveConnection({ provider: 'kiro', credentials: { refreshToken: 'rt' } });
        const found = getConnection(saved.id);
        assert.equal(found.id, saved.id);
    } finally {
        cleanup();
    }
});

test('getConnection returns null for unknown id', () => {
    const cleanup = makeStore();
    try {
        assert.equal(getConnection('nonexistent-id'), null);
    } finally {
        cleanup();
    }
});

// --- redactConnection ---

test('redactConnection strips credential fields', () => {
    const conn = {
        id: '1',
        provider: 'kiro',
        credentials: {
            accessToken: 'secret-access',
            refreshToken: 'secret-refresh',
            idToken: 'secret-id',
            clientSecret: 'secret-client',
            expiresAt: '2099-01-01T00:00:00Z',
            projectId: 'proj-123'
        }
    };
    const redacted = redactConnection(conn);
    assert.ok(!('accessToken' in redacted.credentials));
    assert.ok(!('refreshToken' in redacted.credentials));
    assert.ok(!('idToken' in redacted.credentials));
    assert.ok(!('clientSecret' in redacted.credentials));
    assert.equal(redacted.credentials.hasRefreshToken, true);
    assert.equal(redacted.credentials.expiresAt, '2099-01-01T00:00:00Z');
    assert.equal(redacted.credentials.projectId, 'proj-123');
});

test('redactConnection returns null for null input', () => {
    assert.equal(redactConnection(null), null);
});

// --- updateConnection ---

test('updateConnection merges credentials rather than replacing', () => {
    const cleanup = makeStore();
    try {
        const saved = saveConnection({
            provider: 'kiro',
            credentials: { refreshToken: 'rt', accessToken: 'old-at' }
        });
        updateConnection(saved.id, { credentials: { accessToken: 'new-at' } });
        const updated = getConnection(saved.id);
        assert.equal(updated.credentials.refreshToken, 'rt');
        assert.equal(updated.credentials.accessToken, 'new-at');
    } finally {
        cleanup();
    }
});

test('updateConnection returns null for unknown id', () => {
    const cleanup = makeStore();
    try {
        assert.equal(updateConnection('no-such-id', { label: 'x' }), null);
    } finally {
        cleanup();
    }
});

// --- markConnectionFailed / markConnectionHealthy ---

test('markConnectionFailed records error and parks account on quota error', () => {
    const cleanup = makeStore();
    try {
        const saved = saveConnection({ provider: 'kiro', credentials: { refreshToken: 'rt' } });
        markConnectionFailed(saved.id, new Error('quota exhausted'));
        const conn = getConnection(saved.id);
        assert.ok(conn.lastError);
        assert.ok(conn.rateLimitedUntil, 'quota error should park the account');
    } finally {
        cleanup();
    }
});

test('markConnectionFailed records error without parking for transient errors', () => {
    const cleanup = makeStore();
    try {
        const saved = saveConnection({ provider: 'kiro', credentials: { refreshToken: 'rt' } });
        markConnectionFailed(saved.id, new Error('502 bad gateway'));
        const conn = getConnection(saved.id);
        assert.ok(conn.lastError);
        assert.equal(conn.rateLimitedUntil, null);
    } finally {
        cleanup();
    }
});

test('markConnectionHealthy clears error state', () => {
    const cleanup = makeStore();
    try {
        const saved = saveConnection({ provider: 'kiro', credentials: { refreshToken: 'rt' } });
        markConnectionFailed(saved.id, new Error('429 rate limit'));
        markConnectionHealthy(saved.id);
        const conn = getConnection(saved.id);
        assert.equal(conn.lastError, null);
        assert.equal(conn.rateLimitedUntil, null);
        assert.ok(conn.lastTested);
    } finally {
        cleanup();
    }
});

// --- deleteConnection ---

test('deleteConnection removes connection and returns true', () => {
    const cleanup = makeStore();
    try {
        const saved = saveConnection({ provider: 'kiro', credentials: { refreshToken: 'rt' } });
        const result = deleteConnection(saved.id);
        assert.equal(result, true);
        assert.equal(listConnections().length, 0);
    } finally {
        cleanup();
    }
});

test('deleteConnection returns false for unknown id', () => {
    const cleanup = makeStore();
    try {
        assert.equal(deleteConnection('ghost-id'), false);
    } finally {
        cleanup();
    }
});

// --- listUsableConnections ---

test('listUsableConnections excludes disabled connections', () => {
    const cleanup = makeStore();
    try {
        const saved = saveConnection({ provider: 'kiro', credentials: { refreshToken: 'rt' } });
        updateConnection(saved.id, { enabled: false });
        assert.equal(listUsableConnections('kiro').length, 0);
    } finally {
        cleanup();
    }
});

test('listUsableConnections excludes rate-limited connections', () => {
    const cleanup = makeStore();
    try {
        const saved = saveConnection({ provider: 'kiro', credentials: { refreshToken: 'rt' } });
        const future = new Date(Date.now() + 60_000).toISOString();
        updateConnection(saved.id, { rateLimitedUntil: future });
        assert.equal(listUsableConnections('kiro').length, 0);
    } finally {
        cleanup();
    }
});

test('listUsableConnections includes connections whose rate limit has expired', () => {
    const cleanup = makeStore();
    try {
        const saved = saveConnection({ provider: 'kiro', credentials: { refreshToken: 'rt' } });
        const past = new Date(Date.now() - 1000).toISOString();
        updateConnection(saved.id, { rateLimitedUntil: past });
        assert.equal(listUsableConnections('kiro').length, 1);
    } finally {
        cleanup();
    }
});

test('listUsableConnections excludes connections with no token at all', () => {
    const cleanup = makeStore();
    try {
        const saved = saveConnection({ provider: 'kiro', credentials: { accessToken: 'at' } });
        // Remove both tokens manually via updateConnection
        updateConnection(saved.id, { credentials: { accessToken: null, refreshToken: null } });
        assert.equal(listUsableConnections('kiro').length, 0);
    } finally {
        cleanup();
    }
});

// --- QUOTA_EXHAUSTED_PATTERN ---

test('QUOTA_EXHAUSTED_PATTERN matches expected error strings', () => {
    const matching = [
        'quota exceeded',
        'rate limit hit',
        '429 Too Many Requests',
        '402 Payment Required',
        'You have reached the limit',
        'limit reached',
        'exhausted',
        'insufficient credits'
    ];
    for (const msg of matching) {
        assert.ok(QUOTA_EXHAUSTED_PATTERN.test(msg), `expected match: "${msg}"`);
    }
});

test('QUOTA_EXHAUSTED_PATTERN does not match unrelated errors', () => {
    const nonMatching = ['500 internal server error', 'bad gateway', 'connection refused'];
    for (const msg of nonMatching) {
        assert.ok(!QUOTA_EXHAUSTED_PATTERN.test(msg), `unexpected match: "${msg}"`);
    }
});
