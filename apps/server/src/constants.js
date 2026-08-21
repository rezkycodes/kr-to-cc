/**
 * Constants for Kiro to Claude
 * Kiro-specific configuration and AWS CodeWhisperer integration
 */

import { homedir, platform, arch } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Build the list of candidate Kiro CLI database paths for the current platform.
 * Kiro CLI stores its SQLite database under the OS data directory, which is not
 * always the same as the config directory. We probe several known locations so
 * the proxy works regardless of how Kiro was installed / which login was used.
 *
 * @returns {string[]} Ordered list of candidate database paths
 */
function getKiroDbCandidates() {
    const home = homedir();
    const candidates = [];

    switch (platform()) {
        case 'darwin':
            candidates.push(join(home, 'Library/Application Support/kiro-cli/data.sqlite3'));
            candidates.push(join(home, '.local/share/kiro-cli/data.sqlite3'));
            candidates.push(join(home, '.config/kiro-cli/data.sqlite3'));
            break;
        case 'win32': {
            const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData/Local');
            const roaming = process.env.APPDATA || join(home, 'AppData/Roaming');
            candidates.push(join(localAppData, 'kiro-cli/data.sqlite3'));
            candidates.push(join(roaming, 'kiro-cli/data.sqlite3'));
            break;
        }
        default: {
            // linux, freebsd, etc. Prefer XDG_DATA_HOME (defaults to ~/.local/share).
            const xdgData = process.env.XDG_DATA_HOME || join(home, '.local/share');
            const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, '.config');
            candidates.push(join(xdgData, 'kiro-cli/data.sqlite3'));
            candidates.push(join(xdgConfig, 'kiro-cli/data.sqlite3'));
            break;
        }
    }

    return candidates;
}

/**
 * Resolve the Kiro CLI database path, preferring the first candidate that
 * actually exists on disk. Falls back to the first candidate if none exist yet
 * (so error messages point at the expected default location).
 */
function getKiroDbPath() {
    const candidates = getKiroDbCandidates();
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return candidates[0];
}

// Basic configuration
export const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '10mb';
export const DEFAULT_PORT = 4985;

/**
 * Version segment of the Anthropic-compatible API surface.
 *
 * Declared once and reused wherever a path or a base URL has to carry it, so the
 * segment is never spelled out twice in a row anywhere in the codebase.
 */
/**
 * Model used when a request omits `model`. Must stay a bare id that the provider
 * registry can resolve; it is not namespaced so existing clients keep working.
 */
export const DEFAULT_MODEL = 'claude-opus-4-6';

export const API_VERSION = '/v1';
export const TOKEN_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_RETRIES = 3; // Max retry attempts
export const UPSTREAM_TIMEOUT_MS = Math.max(
    1000,
    Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || '300000', 10) || 300000
);

// Refresh the access token this many ms before it actually expires.
export const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

// Token refresh endpoints.
// Social / Builder ID (Kiro Desktop Auth): POST JSON { refreshToken }
export const KIRO_DESKTOP_REFRESH_URL_TEMPLATE =
    'https://prod.{region}.auth.desktop.kiro.dev/refreshToken';
// IAM Identity Center (AWS SSO OIDC): POST JSON CreateToken with client creds
export const AWS_SSO_OIDC_URL_TEMPLATE = 'https://oidc.{region}.amazonaws.com/token';

// User-Agent used for refresh requests (mimics the Kiro IDE client).
export const KIRO_REFRESH_USER_AGENT = 'KiroIDE-0.7.45-kiro-to-claude';

// --- OAuth (social login + import) ---
// Kiro Desktop Auth service (Google/GitHub social login + social refresh).
export const KIRO_AUTH_SERVICE = 'https://prod.us-east-1.auth.desktop.kiro.dev';
// AWS Cognito only whitelists this custom-protocol redirect, not localhost.
export const KIRO_SOCIAL_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success';
// Kiro IDE refresh tokens (from AWS SSO cache) start with this prefix.
export const KIRO_REFRESH_TOKEN_PREFIX = 'aorAAAAAG';

// AWS region allowlist pattern — prevents SSRF via region injection into URLs.
export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

/**
 * Reject any region that is not a valid AWS region before interpolating it
 * into an upstream URL.
 * @param {string} region
 * @returns {string} the validated region
 */
export function assertValidAwsRegion(region) {
    if (typeof region !== 'string' || !AWS_REGION_PATTERN.test(region)) {
        throw new Error('Invalid region');
    }
    return region;
}

// Kiro CLI database path for token extraction
export const KIRO_DB_PATH = getKiroDbPath();

// Candidate auth_kv keys where Kiro CLI stores the OAuth token, in priority
// order. Which one is present depends on the login type:
//   - social  -> Builder ID / social sign-in
//   - odic     -> IAM Identity Center (SSO / OIDC)
export const KIRO_TOKEN_KEYS = [
    'kirocli:social:token',
    'kirocli:odic:token',
    'kirocli:oidc:token'
];

// Candidate keys for device registration (client credentials)
export const KIRO_DEVICE_REGISTRATION_KEYS = [
    'kirocli:social:device-registration',
    'kirocli:odic:device-registration',
    'kirocli:oidc:device-registration'
];

// AWS CodeWhisperer API endpoint pattern
export const KIRO_ENDPOINT_TEMPLATE = 'https://codewhisperer.{region}.amazonaws.com';

// AWS CodeWhisperer API endpoints by region
export const KIRO_ENDPOINTS = {
    'us-east-1': 'https://codewhisperer.us-east-1.amazonaws.com',
    'us-west-2': 'https://codewhisperer.us-west-2.amazonaws.com',
    'eu-west-1': 'https://codewhisperer.eu-west-1.amazonaws.com',
    'eu-central-1': 'https://codewhisperer.eu-central-1.amazonaws.com',
    'ap-northeast-1': 'https://codewhisperer.ap-northeast-1.amazonaws.com'
};

/** Resolve a validated regional CodeWhisperer endpoint without silent fallback. */
export function getKiroEndpoint(region = 'us-east-1') {
    const validRegion = assertValidAwsRegion(region);
    return KIRO_ENDPOINTS[validRegion]
        || KIRO_ENDPOINT_TEMPLATE.replace('{region}', validRegion);
}

// Kiro API paths
export const KIRO_API_PATHS = {
    GENERATE_ASSISTANT: '/generateAssistantResponse',  // Main chat endpoint
    SEND_MESSAGE: '/SendMessageStreaming',             // Alternative chat endpoint
    MCP: '/mcp',                                       // MCP invocation
    EXPORT_ARCHIVE: '/exportResultArchive',            // Export results
    TASK_PLAN: '/generateTaskAssistPlan'               // Task planning
};

// Default AWS region for Kiro
export const KIRO_DEFAULT_REGION = 'us-east-1';

// Kiro model mappings (Claude model names to Kiro's internal model IDs)
export const KIRO_MODEL_MAPPING = {
    // --- Anthropic Claude (map Anthropic-style aliases to Kiro internal IDs) ---
    'claude-opus-5': 'claude-opus-5',
    'claude-opus-5-thinking': 'claude-opus-5',
    'claude-opus-4-8': 'claude-opus-4.8',
    'claude-opus-4-8-thinking': 'claude-opus-4.8',
    'claude-opus-4-7': 'claude-opus-4.7',
    'claude-opus-4-7-thinking': 'claude-opus-4.7',
    'claude-opus-4-6': 'claude-opus-4.6',
    'claude-opus-4-6-thinking': 'claude-opus-4.6',
    'claude-opus-4-5': 'claude-opus-4.5',
    'claude-opus-4-5-thinking': 'claude-opus-4.5',
    'claude-sonnet-5': 'claude-sonnet-5',
    'claude-sonnet-5-thinking': 'claude-sonnet-5',
    'claude-sonnet-4-6': 'claude-sonnet-4.6',
    'claude-sonnet-4-6-thinking': 'claude-sonnet-4.6',
    'claude-sonnet-4-5': 'claude-sonnet-4.5',
    'claude-sonnet-4-5-thinking': 'claude-sonnet-4.5',
    'claude-sonnet-4': 'claude-sonnet-4',
    'claude-sonnet-4-thinking': 'claude-sonnet-4',
    'claude-haiku-4-5': 'claude-haiku-4.5',
    'claude-haiku-4-5-thinking': 'claude-haiku-4.5',

    // --- Open-weight models (id == kiro_id, kept as-is) ---
    'deepseek-3.2': 'deepseek-3.2',
    'minimax-m2.5': 'minimax-m2.5',
    'glm-5': 'glm-5',
    'minimax-m2.1': 'minimax-m2.1',
    'qwen3-coder-next': 'qwen3-coder-next',

    // Auto model
    'auto': 'auto'
};

// Kiro-specific headers for AWS CodeWhisperer Streaming Service
export const KIRO_HEADERS = {
    'User-Agent': 'kiro-proxy/1.0.0',
    'Content-Type': 'application/json'
};

// AWS service name for signing requests
export const KIRO_AWS_SERVICE = 'amazoncodewhispererstreamingservice';

// Kiro API service names (client types)
export const KIRO_SERVICE = {
    RUNTIME: 'CodeWhispererRuntimeClient',
    STREAMING: 'CodeWhispererStreamingClient'
};

// Kiro origin identifiers (for request source)
export const KIRO_ORIGIN = {
    KIRO_CLI: 'KIRO_CLI',
    IDE: 'IDE',
    AI_EDITOR: 'AI_EDITOR'
};

// Chat trigger types
export const KIRO_CHAT_TRIGGER = {
    MANUAL: 'MANUAL',
    DIAGNOSTIC: 'DIAGNOSTIC',
    INLINE_CHAT: 'INLINE_CHAT'
};

// Kiro configuration file path
export const KIRO_CONFIG_PATH = join(
    homedir(),
    '.config/kiro-proxy/config.json'
);

/**
 * Check if a model supports thinking/reasoning output.
 * @param {string} modelName - The model name from the request
 * @returns {boolean} True if the model supports thinking blocks
 */
export function isThinkingModel(modelName) {
    const lower = (modelName || '').toLowerCase();
    // Claude thinking models have "thinking" in the name
    if (lower.includes('claude') && lower.includes('thinking')) return true;
    return false;
}

export default {
    REQUEST_BODY_LIMIT,
    DEFAULT_PORT,
    KIRO_DB_PATH,
    KIRO_ENDPOINT_TEMPLATE,
    KIRO_ENDPOINTS,
    KIRO_API_PATHS,
    KIRO_DEFAULT_REGION,
    KIRO_MODEL_MAPPING,
    KIRO_HEADERS,
    KIRO_AWS_SERVICE,
    KIRO_SERVICE,
    KIRO_ORIGIN,
    KIRO_CHAT_TRIGGER,
    KIRO_CONFIG_PATH,
    isThinkingModel
};
