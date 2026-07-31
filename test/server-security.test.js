import test from 'node:test';
import assert from 'node:assert/strict';

import app from '../src/server.js';

async function withServer(run) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

test('protects /v1 with an optional proxy API key', async () => {
    const previous = process.env.PROXY_API_KEY;
    process.env.PROXY_API_KEY = 'test-secret';

    try {
        await withServer(async (baseUrl) => {
            const unauthorized = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })
            });
            assert.equal(unauthorized.status, 401);
            assert.equal((await unauthorized.json()).error.type, 'authentication_error');

            const authorized = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': 'test-secret'
                },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })
            });
            assert.equal(authorized.status, 200);
        });
    } finally {
        if (previous === undefined) delete process.env.PROXY_API_KEY;
        else process.env.PROXY_API_KEY = previous;
    }
});

test('allows local browser origins and same-origin dashboard frames only', async () => {
    await withServer(async (baseUrl) => {
        const local = await fetch(`${baseUrl}/`, {
            headers: { Origin: 'http://localhost:4000' }
        });
        assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:4000');
        assert.equal(local.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(local.headers.get('x-frame-options'), 'SAMEORIGIN');
        assert.equal(local.headers.get('referrer-policy'), 'no-referrer');

        const dashboardHtml = await local.text();
        assert.match(dashboardHtml, /data-src="\/ui\/models"/);
        assert.match(dashboardHtml, /data-src="\/ui\/models-check"/);
        assert.doesNotMatch(dashboardHtml, /(?:src|data-src)="https?:\/\/localhost/i);

        const embedded = await fetch(`${baseUrl}/ui/models`);
        assert.equal(embedded.status, 200);
        assert.equal(embedded.headers.get('x-frame-options'), 'SAMEORIGIN');

        const remote = await fetch(`${baseUrl}/`, {
            headers: { Origin: 'https://evil.example' }
        });
        assert.equal(remote.headers.get('access-control-allow-origin'), null);
    });
});
