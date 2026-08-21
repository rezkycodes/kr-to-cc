/**
 * MITM HTTPS server for transparent Anthropic API interception.
 *
 * Architecture (same as 9router):
 *   1. Root CA certificate generated once, stored in ~/.config/kiro-proxy/mitm/
 *   2. Per-domain leaf certs generated on-the-fly via SNI callback
 *   3. /etc/hosts entries point api.anthropic.com → 127.0.0.1
 *   4. HTTPS server on port 443 intercepts traffic
 *   5. Anthropic API requests routed through kr-to-cc's provider system
 *   6. Non-matching traffic passed through to real upstream
 *
 * Usage:
 *   node --import jiti/register apps/server/src/mitm/server.js
 *   # or: node apps/server/src/index.js --mitm
 */

import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import { generateRootCA, generateLeafCert } from './cert.js';
import { TARGET_HOSTS, URL_PATTERNS, ensureMitmDir } from './config.js';
import { addDNSEntries, removeDNSEntries } from './dns.js';
import { handleAnthropicRequest } from './handler.js';
import { logger } from '../utils/logger.js';
import { getProvider } from '../providers/index.js';

const MITM_PORT = Number(process.env.MITM_PORT) || 443;

// ── SSL / SNI ─────────────────────────────────────────────────

const certCache = new Map();
let rootCAPem;

function sniCallback(servername, cb) {
    try {
        if (certCache.has(servername)) return cb(null, certCache.get(servername));
        const leaf = generateLeafCert(servername);
        const ctx = tls.createSecureContext({
            key: leaf.key,
            cert: `${leaf.cert}\n${rootCAPem}`
        });
        certCache.set(servername, ctx);
        cb(null, ctx);
    } catch (error) {
        logger.error(`[MITM] SNI error for ${servername}: ${error.message}`);
        cb(error);
    }
}

// ── Bootstrap ─────────────────────────────────────────────────

ensureMitmDir();
const rootCA = generateRootCA();
rootCAPem = fs.readFileSync(rootCA.cert, 'utf8');

const sslOptions = {
    key: fs.readFileSync(rootCA.key),
    cert: rootCAPem,
    SNICallback: sniCallback
};

// ── Helpers ───────────────────────────────────────────────────

/**
 * Collect the full request body as a Buffer.
 */
function collectBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/**
 * Forward a request to the real upstream (passthrough for non-intercepted traffic).
 */
function passthrough(req, res, bodyBuffer) {
    const targetHost = (req.headers.host || '').split(':')[0];

    const options = {
        hostname: targetHost,
        port: 443,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: targetHost },
        rejectUnauthorized: false
    };

    const upstreamReq = https.request(options, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (error) => {
        logger.error(`[MITM] Passthrough error: ${error.message}`);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: { message: error.message, type: 'mitm_error' } }));
    });

    if (bodyBuffer.length > 0) upstreamReq.write(bodyBuffer);
    upstreamReq.end();
}

/**
 * Determine if a request is an Anthropic API chat request (vs telemetry, health, etc).
 */
function isAnthropicChatRequest(url) {
    return URL_PATTERNS.some(pattern => url.includes(pattern));
}

// ── Server ────────────────────────────────────────────────────

const server = https.createServer(sslOptions, async (req, res) => {
    try {
        const host = (req.headers.host || '').split(':')[0];

        // Health check for the MITM server itself
        if (req.url === '/_mitm_health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, pid: process.pid, mode: 'mitm' }));
            return;
        }

        const bodyBuffer = await collectBody(req);

        // Only intercept known Anthropic API traffic
        if (!TARGET_HOSTS.includes(host) || !isAnthropicChatRequest(req.url)) {
            return passthrough(req, res, bodyBuffer);
        }

        // Intercept: route through kr-to-cc's provider system
        await handleAnthropicRequest(req, res, bodyBuffer);
    } catch (error) {
        logger.error(`[MITM] Unhandled error: ${error.message}`);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: { message: error.message, type: 'mitm_error' } }));
    }
});

// ── DNS + Start ───────────────────────────────────────────────

let dnsAdded = false;
try {
    addDNSEntries();
    dnsAdded = true;
    logger.info('[MITM] DNS entries added for: ' + TARGET_HOSTS.join(', '));
} catch (error) {
    logger.warn(`[MITM] Could not add DNS entries automatically: ${error.message}`);
    logger.warn('[MITM] Add manually, or run with sudo:');
    logger.warn(`  sudo bash -c '${TARGET_HOSTS.map(h => `echo \"127.0.0.1 ${h}\" >> /etc/hosts`).join(' && ')}'`);
    logger.warn('[MITM] Continuing without DNS — use curl --resolve or /etc/hosts manually.');
}

server.listen(MITM_PORT, '0.0.0.0', async () => {
    // Pre-initialize all providers so ownsModel() has a populated catalog.
    // Without this, the first request after startup fails with "does not serve model"
    // because the model set is fetched lazily from upstream.
    for (const id of ['kiro', 'google']) {
        try {
            const provider = getProvider(id);
            if (provider?.ensureReady) await provider.ensureReady();
        } catch { /* non-fatal — provider may have no connections yet */ }
    }
    const rootCAPath = rootCA.cert;
    logger.log('');
    logger.log('╔══════════════════════════════════════════════════════════════╗');
    logger.log('║              kr-to-cc MITM Proxy Server                     ║');
    logger.log('╠══════════════════════════════════════════════════════════════╣');
    logger.log(`║  Listening on: https://0.0.0.0:${MITM_PORT}                          ║`);
    logger.log('║  Mode: Transparent MITM (intercepts api.anthropic.com)     ║');
    logger.log('║                                                            ║');
    logger.log('║  Intercepted hosts:                                        ║');
    for (const h of TARGET_HOSTS) logger.log(`║    ${h.padEnd(56)}║`);
    logger.log('║                                                            ║');
    logger.log('║  Setup:                                                    ║');
    logger.log(`║    1. Install Root CA: ${rootCAPath.slice(-38).padEnd(38)}║`);
    logger.log('║    2. Claude Code CLI works without ANTHROPIC_BASE_URL     ║');
    logger.log('║                                                            ║');
    logger.log('║  Ctrl+C to stop (cleans up DNS entries)                    ║');
    logger.log('╚══════════════════════════════════════════════════════════════╝');
    logger.log('');
    logger.success(`[MITM] Server started on port ${MITM_PORT}`);
    logger.info(`[MITM] Root CA certificate: ${rootCAPath}`);
    logger.info('[MITM] Install the Root CA in your browser/OS trust store, then use Claude Code normally.');
});

// ── Shutdown ──────────────────────────────────────────────────

let isShuttingDown = false;
const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    if (dnsAdded) {
        logger.info('[MITM] Shutting down, removing DNS entries...');
        removeDNSEntries();
    } else {
        logger.info('[MITM] Shutting down...');
    }
    const forceExit = setTimeout(() => process.exit(0), 2000);
    server.close(() => { clearTimeout(forceExit); process.exit(0); });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (process.platform === 'win32') process.on('SIGBREAK', shutdown);
