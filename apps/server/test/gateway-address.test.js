import test from 'node:test';
import assert from 'node:assert/strict';

import { baseUrlIssue, gatewayOrigin, gatewayPort, pointsAtGateway } from '../src/utils/gateway-address.js';
import { DEFAULT_PORT } from '../src/constants.js';

/** Minimal Express-request stand-in. */
function fakeRequest({ host = 'localhost:3210', boundPort, protocol = 'http', headers = {} } = {}) {
    const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
    return {
        protocol,
        headers,
        hostname,
        get: (name) => (name.toLowerCase() === 'host' ? host : undefined),
        app: { get: (key) => (key === 'gatewayPort' ? boundPort : undefined) }
    };
}

test('uses the Express listen port, not the proxying dev server port', () => {
    // Vite serves the UI on 3210 and forwards /config to Express on 4000, so the
    // Host header must never decide what Claude Code dials.
    const req = fakeRequest({ host: 'localhost:3210', boundPort: 4000 });
    assert.equal(gatewayPort(req), 4000);
    assert.equal(gatewayOrigin(req), 'http://localhost:4000');
});

test('falls back to PORT then the default when no port was recorded', () => {
    const previous = process.env.PORT;
    try {
        process.env.PORT = '4123';
        assert.equal(gatewayOrigin(fakeRequest({ host: 'localhost:3210' })), 'http://localhost:4123');
        delete process.env.PORT;
        assert.equal(
            gatewayOrigin(fakeRequest({ host: 'localhost:3210' })),
            `http://localhost:${DEFAULT_PORT}`
        );
    } finally {
        if (previous === undefined) delete process.env.PORT;
        else process.env.PORT = previous;
    }
});

test('keeps the caller hostname and honours forwarded protocol', () => {
    assert.equal(
        gatewayOrigin(fakeRequest({
            host: 'gateway.internal',
            boundPort: 8080,
            headers: { 'x-forwarded-proto': 'https' }
        })),
        'https://gateway.internal:8080'
    );
});

test('brackets bare IPv6 hosts so the port stays parseable', () => {
    assert.equal(gatewayOrigin(fakeRequest({ host: '[::1]:3210', boundPort: 4000 })), 'http://[::1]:4000');
});

test('both the origin and the origin plus /v1 are valid base URLs', () => {
    // The API is mounted at /v1 and /v1/v1, so either spelling of the setting
    // reaches a handler once Claude Code appends its own /v1/messages.
    const req = fakeRequest({ host: 'localhost:4000', boundPort: 4000 });
    for (const value of [
        'http://localhost:4000',
        'http://localhost:4000/',
        'http://localhost:4000/v1',
        'http://localhost:4000/v1/'
    ]) {
        assert.equal(pointsAtGateway(req, value), true, `expected ${value} to be accepted`);
        assert.equal(baseUrlIssue(req, value), null);
    }
});

test('any other path is rejected with an actionable reason', () => {
    const req = fakeRequest({ host: 'localhost:4000', boundPort: 4000 });
    assert.equal(pointsAtGateway(req, 'http://localhost:4000/v2'), false);
    assert.match(baseUrlIssue(req, 'http://localhost:4000/v2'), /remove the "\/v2" path/i);
    assert.match(baseUrlIssue(req, 'http://localhost:4000/v1/messages'), /remove the/i);
});

test('loopback aliases are the same host', () => {
    const req = fakeRequest({ host: '127.0.0.1:4000', boundPort: 4000 });
    assert.equal(pointsAtGateway(req, 'http://localhost:4000/v1'), true);
    assert.equal(pointsAtGateway(req, 'http://[::1]:4000'), true);
});

test('a different port or host is reported as pointing elsewhere', () => {
    const req = fakeRequest({ host: 'localhost:4000', boundPort: 4000 });
    assert.equal(pointsAtGateway(req, 'http://localhost:9999/v1'), false);
    assert.match(baseUrlIssue(req, 'http://localhost:9999/v1'), /not this gateway/);
    assert.match(baseUrlIssue(req, 'https://api.anthropic.com'), /not this gateway/);
});

test('an unset or unparseable base URL is never a match', () => {
    const req = fakeRequest({ host: 'localhost:4000', boundPort: 4000 });
    for (const value of [undefined, null, '', '   ']) {
        assert.equal(pointsAtGateway(req, value), false);
        assert.match(baseUrlIssue(req, value), /not set/);
    }
    assert.match(baseUrlIssue(req, 'not a url'), /not a valid URL/);
});
