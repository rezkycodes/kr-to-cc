import test from 'node:test';
import assert from 'node:assert/strict';

import { gatewayOrigin, gatewayPort } from '../src/utils/gateway-address.js';
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
