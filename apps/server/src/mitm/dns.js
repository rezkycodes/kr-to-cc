/**
 * DNS (/etc/hosts) manipulation for MITM proxy.
 *
 * Adds entries pointing target hosts to 127.0.0.1 so the HTTPS server
 * intercepts traffic. Removes them on shutdown so other apps aren't broken.
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { TARGET_HOSTS } from './config.js';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOSTS_FILE = IS_WIN
    ? (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';

const MARKER = '# kr-to-cc-mitm';

/**
 * Check if all target hosts are already in /etc/hosts.
 */
export function checkDNSEntries() {
    try {
        const content = fs.readFileSync(HOSTS_FILE, 'utf8');
        return TARGET_HOSTS.every(h => content.includes(h));
    } catch {
        return false;
    }
}

/**
 * Add DNS entries for all target hosts.
 * Requires root/admin privileges.
 */
export function addDNSEntries() {
    if (checkDNSEntries()) return;

    const current = fs.readFileSync(HOSTS_FILE, 'utf8');
    const lines = TARGET_HOSTS.map(h => `127.0.0.1 ${h} ${MARKER}`);
    const newContent = current.replace(/[\r\n\s]*$/, '') + '\n' + lines.join('\n') + '\n';

    if (IS_WIN) {
        fs.writeFileSync(HOSTS_FILE, newContent, 'utf8');
        try { execSync('ipconfig /flushdns', { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
    } else {
        // Use tee via sudo for atomic write
        const escaped = newContent.replace(/'/g, "'\\''");
        execSync(`printf '%s' '${escaped}' | sudo tee ${HOSTS_FILE} > /dev/null`, { stdio: 'ignore' });
        if (IS_MAC) {
            try { execSync('dscacheutil -flushcache && killall -HUP mDNSResponder', { stdio: 'ignore' }); } catch { /* ignore */ }
        } else {
            try { execSync('resolvectl flush-caches 2>/dev/null || true', { stdio: 'ignore' }); } catch { /* ignore */ }
        }
    }
}

/**
 * Remove DNS entries for all target hosts.
 * Safe to call even if entries don't exist.
 */
export function removeDNSEntries() {
    try {
        if (!fs.existsSync(HOSTS_FILE)) return;
        const content = fs.readFileSync(HOSTS_FILE, 'utf8');
        const filtered = content.split(/\r?\n/)
            .filter(line => !line.includes(MARKER))
            .join('\n')
            .replace(/[\r\n\s]*$/, '') + '\n';

        if (filtered === content) return;

        if (IS_WIN) {
            fs.writeFileSync(HOSTS_FILE, filtered, 'utf8');
            try { execSync('ipconfig /flushdns', { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
        } else {
            const escaped = filtered.replace(/'/g, "'\\''");
            execSync(`printf '%s' '${escaped}' | sudo tee ${HOSTS_FILE} > /dev/null`, { stdio: 'ignore' });
            if (IS_MAC) {
                try { execSync('dscacheutil -flushcache && killall -HUP mDNSResponder', { stdio: 'ignore' }); } catch { /* ignore */ }
            } else {
                try { execSync('resolvectl flush-caches 2>/dev/null || true', { stdio: 'ignore' }); } catch { /* ignore */ }
            }
        }
    } catch { /* best effort during shutdown */ }
}
