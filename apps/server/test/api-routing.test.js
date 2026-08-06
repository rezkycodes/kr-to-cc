/**
 * Routing contract for the versioned API.
 *
 * Anthropic clients supply the version segment themselves, so it arrives once
 * when ANTHROPIC_BASE_URL is a bare origin and twice when the setting already
 * ends in it. The registry accepts both by mounting the router under the version
 * segment as well as at the root of its mount. These tests pin both spellings,
 * the mount order they depend on, and `/health` staying unversioned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import app from '../src/server.js';

/** Start the app on an ephemeral port and return a request helper. */
async function withServer(t) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    t.after(() => new Promise((resolve) => server.close(resolve)));

    return async function request(method, path, body) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: response.status, text: await response.text() };
    };
}

const MESSAGE = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }]
};

test('the versioned paths are served under /v1', async (t) => {
    const request = await withServer(t);

    // Reached the handler rather than the catch-all. Upstream may still fail, but
    // a 404 would mean the route is not mounted.
    for (const [method, path, body] of [
        ['POST', '/v1/messages', MESSAGE],
        ['POST', '/v1/messages/count_tokens', MESSAGE],
        ['GET', '/v1/models', null]
    ]) {
        const { status } = await request(method, path, body);
        assert.notEqual(status, 404, `${method} ${path} should be mounted`);
    }
});

test('a repeated version segment is absorbed', async (t) => {
    // ANTHROPIC_BASE_URL ending in the version segment makes the client send it
    // twice, because the client appends its own versioned path regardless.
    //
    // This also guards the mount order: the root branch matches a path that still
    // carries the segment, so the version branch has to be tried first or the
    // request would fall through to the catch-all.
    const request = await withServer(t);

    for (const [method, path, body] of [
        ['POST', '/v1/v1/messages', MESSAGE],
        ['POST', '/v1/v1/messages/count_tokens', MESSAGE],
        ['GET', '/v1/v1/models', null]
    ]) {
        const { status } = await request(method, path, body);
        assert.notEqual(status, 404, `${method} ${path} should be mounted`);
    }
});

test('unknown paths under either prefix still 404', async (t) => {
    const request = await withServer(t);

    for (const path of ['/v1/nope', '/v1/v1/nope', '/v1/v1/v1/messages']) {
        const { status, text } = await request('POST', path, MESSAGE);
        assert.equal(status, 404, `${path} must not resolve`);
        assert.match(text, /not_found_error/);
    }
});

test('/health stays unversioned', async (t) => {
    const request = await withServer(t);

    const root = await request('GET', '/health', null);
    // 200 when Kiro is reachable, 503 when it is not; either proves it is mounted.
    assert.ok([200, 503].includes(root.status), `unexpected status ${root.status}`);

    const versioned = await request('GET', '/v1/health', null);
    assert.equal(versioned.status, 404);
});
