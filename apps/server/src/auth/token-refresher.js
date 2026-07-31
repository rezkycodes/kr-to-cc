/**
 * Token Refresher for Kiro
 *
 * Renews the Kiro access token using the stored refresh token so the proxy can
 * keep working without re-running `kiro auth`, as long as the user stays logged
 * in. Supports two mechanisms:
 *   - Social / Builder ID (Kiro Desktop Auth): POST { refreshToken } to
 *     https://prod.{region}.auth.desktop.kiro.dev/refreshToken
 *   - IAM Identity Center (AWS SSO OIDC): CreateToken against
 *     https://oidc.{region}.amazonaws.com/token using clientId/clientSecret
 *
 * Refresh tokens rotate, so callers must persist the returned refreshToken.
 */

import {
    KIRO_DESKTOP_REFRESH_URL_TEMPLATE,
    AWS_SSO_OIDC_URL_TEMPLATE,
    KIRO_REFRESH_USER_AGENT,
    KIRO_DEFAULT_REGION
} from '../constants.js';
import { logger } from '../utils/logger.js';

/**
 * Whether the given auth key belongs to a social / Builder ID login (uses the
 * Kiro Desktop Auth refresh endpoint) rather than SSO OIDC.
 * @param {string} authKey
 * @returns {boolean}
 */
export function isSocialAuthKey(authKey) {
    return typeof authKey === 'string' && authKey.includes('social');
}

/**
 * Refresh a social / Builder ID token via the Kiro Desktop Auth endpoint.
 * @param {Object} creds - Current credentials ({ refreshToken, region })
 * @returns {Promise<Object>} Updated fields { accessToken, refreshToken, expiresAt, profileArn }
 */
async function refreshDesktopToken(creds) {
    const region = creds.region || KIRO_DEFAULT_REGION;
    const url = KIRO_DESKTOP_REFRESH_URL_TEMPLATE.replace('{region}', region);

    if (!creds.refreshToken) {
        throw new Error('No refresh token available for Kiro Desktop refresh.');
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': KIRO_REFRESH_USER_AGENT
        },
        body: JSON.stringify({ refreshToken: creds.refreshToken })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Kiro Desktop refresh failed ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json();
    if (!data.accessToken) {
        throw new Error('Kiro Desktop refresh response missing accessToken.');
    }

    const expiresIn = data.expiresIn || 3600;
    return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || creds.refreshToken,
        expiresAt: new Date(Date.now() + (expiresIn - 60) * 1000),
        profileArn: data.profileArn || creds.profileArn || null
    };
}

/**
 * Refresh an SSO OIDC token via the AWS OIDC CreateToken API.
 * Requires clientId/clientSecret from the device registration.
 * @param {Object} creds - Current credentials ({ refreshToken, region, clientId, clientSecret })
 * @returns {Promise<Object>} Updated fields { accessToken, refreshToken, expiresAt }
 */
async function refreshSsoOidcToken(creds) {
    const region = creds.region || KIRO_DEFAULT_REGION;
    const url = AWS_SSO_OIDC_URL_TEMPLATE.replace('{region}', region);

    if (!creds.refreshToken) {
        throw new Error('No refresh token available for SSO OIDC refresh.');
    }
    if (!creds.clientId || !creds.clientSecret) {
        throw new Error('SSO OIDC refresh requires clientId/clientSecret (device registration).');
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grantType: 'refresh_token',
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            refreshToken: creds.refreshToken
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`AWS SSO OIDC refresh failed ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json();
    if (!data.accessToken) {
        throw new Error('AWS SSO OIDC refresh response missing accessToken.');
    }

    const expiresIn = data.expiresIn || 3600;
    return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || creds.refreshToken,
        expiresAt: new Date(Date.now() + (expiresIn - 60) * 1000),
        profileArn: creds.profileArn || null
    };
}

/**
 * Refresh the Kiro token, routing to the correct mechanism based on auth type.
 * @param {Object} creds - Current credential object
 * @returns {Promise<Object>} Updated credential fields
 */
export async function refreshKiroToken(creds) {
    if (isSocialAuthKey(creds.authKey)) {
        logger.info('[Kiro] Refreshing token via Kiro Desktop Auth (social)...');
        return refreshDesktopToken(creds);
    }
    logger.info('[Kiro] Refreshing token via AWS SSO OIDC...');
    return refreshSsoOidcToken(creds);
}

export default { refreshKiroToken, isSocialAuthKey };
