import test from 'node:test';
import assert from 'node:assert/strict';

import app from '../src/server.js';
import { requestTelemetry } from '../src/telemetry/request-telemetry.js';

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
        assert.match(dashboardHtml, /<div id="app"><\/div>/);
        assert.match(dashboardHtml, /<title>Monitor · Kiro → Claude<\/title>/);
        assert.doesNotMatch(dashboardHtml, /fonts\.googleapis\.com|"Inter"|NxWelcome/);
        assert.doesNotMatch(dashboardHtml, /(?:src|href)="https?:\/\//i);

        const scriptPath = dashboardHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
        const stylesheetPath = dashboardHtml.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];
        assert.match(scriptPath || '', /^\/assets\/index-[\w-]+\.js$/);
        assert.match(stylesheetPath || '', /^\/assets\/index-[\w-]+\.css$/);

        const [script, stylesheet, geistFont, dashboardAlias] = await Promise.all([
            fetch(`${baseUrl}${scriptPath}`),
            fetch(`${baseUrl}${stylesheetPath}`),
            fetch(`${baseUrl}/geist/Geist-Variable.woff2`),
            fetch(`${baseUrl}/dashboard`)
        ]);
        assert.equal(script.status, 200);
        assert.match(script.headers.get('content-type') || '', /javascript/);
        assert.equal(stylesheet.status, 200);
        assert.match(stylesheet.headers.get('content-type') || '', /text\/css/);
        assert.equal(geistFont.status, 200);
        assert.match(geistFont.headers.get('content-type') || '', /font\/woff2/);
        assert.equal(dashboardAlias.status, 200);
        assert.match(await dashboardAlias.text(), /<div id="app"><\/div>/);
        assert.match(local.headers.get('content-security-policy') || '', /default-src 'self'/);

        // Legacy local font and embedded viewers remain available during migration.
        const legacyGeistFont = await fetch(`${baseUrl}/ui/assets/geist/Geist-Variable.woff2`);
        assert.equal(legacyGeistFont.status, 200);

        const embedded = await fetch(`${baseUrl}/ui/models`);
        assert.equal(embedded.status, 200);
        assert.equal(embedded.headers.get('x-frame-options'), 'SAMEORIGIN');

        const telemetryPage = await fetch(`${baseUrl}/ui/telemetry`);
        assert.equal(telemetryPage.status, 200);
        assert.equal(telemetryPage.headers.get('x-frame-options'), 'SAMEORIGIN');
        const telemetryHtml = await telemetryPage.text();
        assert.match(telemetryHtml, /id="requestChart"/);
        assert.match(telemetryHtml, /id="metricSuccessRate"/);
        assert.match(telemetryHtml, /\/ui\/telemetry\/data\?window=/);

        const [authPage, configPage, modelCheckPage] = await Promise.all([
            fetch(`${baseUrl}/oauth/kiro`),
            fetch(`${baseUrl}/config/claude`),
            fetch(`${baseUrl}/ui/models-check`)
        ]);
        assert.equal(authPage.status, 200);
        assert.equal(configPage.status, 200);
        assert.equal(modelCheckPage.status, 200);

        const [authHtml, configHtml, modelCheckHtml] = await Promise.all([
            authPage.text(),
            configPage.text(),
            modelCheckPage.text()
        ]);

        // Sign-in and configuration are pages of the built SPA. Their JSON
        // siblings must keep belonging to their own routers.
        for (const html of [authHtml, configHtml]) {
            assert.match(html, /<div id="app"><\/div>/);
            assert.doesNotMatch(html, /(?:src|href)="https?:\/\//i);
        }
        assert.match(authPage.headers.get('content-security-policy') || '', /default-src 'self'/);
        assert.match(configPage.headers.get('content-security-policy') || '', /default-src 'self'/);

        const [authStatus, configState] = await Promise.all([
            fetch(`${baseUrl}/oauth/kiro/status`),
            fetch(`${baseUrl}/config/claude/state`)
        ]);
        assert.equal(authStatus.status, 200);
        assert.equal(typeof (await authStatus.json()).authenticated, 'boolean');
        assert.equal(configState.status, 200);
        assert.equal(typeof (await configState.json()).settingsPath, 'string');

        const forbiddenUiSource = /#(?:000000|22c55e|ef4444|34d399|fb7185|fbbf24|38bdf8|16804b|c5362e|a7650a)|fonts\.googleapis\.com|font-family:\s*["']?Inter/i;
        for (const html of [telemetryHtml, modelCheckHtml]) {
            assert.doesNotMatch(html, forbiddenUiSource);
        }

        const remote = await fetch(`${baseUrl}/`, {
            headers: { Origin: 'https://evil.example' }
        });
        assert.equal(remote.headers.get('access-control-allow-origin'), null);
    });
});


test('records failed message requests without retaining request payloads', async () => {
    requestTelemetry.reset();
    const sensitiveMarker = 'private-prompt-must-not-appear';

    await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-opus-4-8',
                max_tokens: -1,
                messages: [{ role: 'user', content: sensitiveMarker }]
            })
        });
        assert.equal(response.status, 400);
        const requestId = response.headers.get('x-request-id');
        assert.match(requestId, /^[0-9a-f-]{36}$/);

        const telemetryResponse = await fetch(`${baseUrl}/ui/telemetry/data?window=60`);
        assert.equal(telemetryResponse.status, 200);
        const snapshot = await telemetryResponse.json();

        assert.equal(snapshot.totals.failed, 1);
        assert.equal(snapshot.recent_failures[0].request_id, requestId);
        assert.equal(snapshot.recent_failures[0].error_type, 'invalid_request_error');
        assert.equal(JSON.stringify(snapshot).includes(sensitiveMarker), false);
    });
});
