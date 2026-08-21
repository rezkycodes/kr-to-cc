/**
 * MITM certificate generation using node-forge.
 *
 * Generates a self-signed Root CA on first run, then dynamically creates
 * per-domain leaf certificates signed by that CA. Same approach as 9router.
 */

import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import { MITM_DIR } from './config.js';

const ROOT_CA_KEY_PATH = path.join(MITM_DIR, 'rootCA.key');
const ROOT_CA_CERT_PATH = path.join(MITM_DIR, 'rootCA.crt');

/**
 * Check if a certificate is expired or expiring within 30 days.
 */
function isCertExpired(certPath) {
    try {
        const cert = forge.pki.certificateFromPem(fs.readFileSync(certPath, 'utf8'));
        const threshold = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        return cert.validity.notAfter < threshold;
    } catch {
        return true;
    }
}

/**
 * Generate Root CA certificate (one-time, auto-regenerates if expired).
 */
export function generateRootCA() {
    const exists = fs.existsSync(ROOT_CA_KEY_PATH) && fs.existsSync(ROOT_CA_CERT_PATH);
    if (exists && !isCertExpired(ROOT_CA_CERT_PATH)) {
        return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
    }

    if (!fs.existsSync(MITM_DIR)) {
        fs.mkdirSync(MITM_DIR, { recursive: true });
    }

    if (exists) {
        try { fs.unlinkSync(ROOT_CA_KEY_PATH); } catch { /* ignore */ }
        try { fs.unlinkSync(ROOT_CA_CERT_PATH); } catch { /* ignore */ }
    }

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

    const attrs = [
        { name: 'commonName', value: 'kr-to-cc MITM Root CA' },
        { name: 'organizationName', value: 'kr-to-cc' },
        { name: 'countryName', value: 'US' }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' }
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    fs.writeFileSync(ROOT_CA_KEY_PATH, forge.pki.privateKeyToPem(keys.privateKey));
    fs.writeFileSync(ROOT_CA_CERT_PATH, forge.pki.certificateToPem(cert));

    return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
}

/**
 * Load Root CA from disk.
 */
export function loadRootCA() {
    if (!fs.existsSync(ROOT_CA_KEY_PATH) || !fs.existsSync(ROOT_CA_CERT_PATH)) {
        throw new Error('Root CA not found. Run generateRootCA() first.');
    }
    return {
        key: forge.pki.privateKeyFromPem(fs.readFileSync(ROOT_CA_KEY_PATH, 'utf8')),
        cert: forge.pki.certificateFromPem(fs.readFileSync(ROOT_CA_CERT_PATH, 'utf8'))
    };
}

/**
 * Generate a leaf certificate for a specific domain, signed by the Root CA.
 */
export function generateLeafCert(domain) {
    const rootCA = loadRootCA();
    const keys = forge.pki.rsa.generateKeyPair(2048);

    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString(16);
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    cert.setSubject([{ name: 'commonName', value: domain }]);
    cert.setIssuer(rootCA.cert.subject.attributes);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        {
            name: 'subjectAltName',
            altNames: [
                { type: 2, value: domain },
                { type: 2, value: `*.${domain}` }
            ]
        }
    ]);
    cert.sign(rootCA.key, forge.md.sha256.create());

    return {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert: forge.pki.certificateToPem(cert)
    };
}
