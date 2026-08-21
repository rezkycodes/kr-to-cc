/**
 * MITM proxy configuration.
 *
 * Defines target hosts, URL patterns, and data directories.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_NAME = 'kiro-proxy';

/** Data directory for MITM artifacts (certs, dumps). */
export const MITM_DIR = path.join(
    process.env.DATA_DIR || path.join(os.homedir(), '.config', APP_NAME),
    'mitm'
);

/** Hosts that the MITM proxy intercepts. */
export const TARGET_HOSTS = [
    'api.anthropic.com',
];

/** URL substrings that identify API chat requests (vs telemetry, health, etc). */
export const URL_PATTERNS = [
    '/v1/messages',
];

/** Ensure the MITM data directory exists. */
export function ensureMitmDir() {
    if (!fs.existsSync(MITM_DIR)) {
        fs.mkdirSync(MITM_DIR, { recursive: true });
    }
}
