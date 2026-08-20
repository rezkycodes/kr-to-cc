/**
 * Google Cloud Code (Antigravity) constants.
 *
 * Values here were established by reading a working implementation, 9router
 * (MIT, © 2024-2026 decolua and contributors), and cross-checked against the
 * Antigravity install on this machine. Several are non-obvious enough that
 * getting them wrong fails in ways that look like something else entirely — those
 * carry a comment saying why.
 *
 * This talks to a private, undocumented Google API (`v1internal`). It can change
 * without notice.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Chat traffic host.
 *
 * The "daily" host is deliberate: the production host rate-limits (429) far more
 * aggressively for this client. Only generation goes here.
 */
export const GOOGLE_CHAT_HOST = 'https://daily-cloudcode-pa.googleapis.com';

/**
 * Discovery host — project provisioning and model listing.
 *
 * Must be the production host. The daily host rejects loadCodeAssist and
 * onboardUser outright, which surfaces as an auth failure rather than a wrong-host
 * error, so it is easy to misdiagnose.
 */
export const GOOGLE_DISCOVERY_HOST = 'https://cloudcode-pa.googleapis.com';

export const GOOGLE_API_VERSION = 'v1internal';

/** Antigravity IDE version we present as. */
export const ANTIGRAVITY_IDE_VERSION = '2.1.1';

/**
 * User-Agent identifying us as the Antigravity IDE.
 *
 * Not optional: the backend refuses requests that do not carry an IDE agent
 * string, so this is required for the API to function at all.
 */
export const ANTIGRAVITY_USER_AGENT = `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;

/**
 * Public OAuth client shipped inside the Antigravity desktop app.
 *
 * "Secret" only nominally — it is distributed in the binary, which is how desktop
 * OAuth clients work. It is needed to refresh tokens and to complete the browser
 * sign-in flow (connections/google-oauth.js).
 *
 * The clientId is the Antigravity CLI client (taken verbatim from 9router's
 * `open-sse/providers/shared.js`, `ANTIGRAVITY_OAUTH_CLIENT`) so a browser
 * sign-in here mints the same kind of token the Antigravity CLI already stores
 * in ~/.gemini/antigravity-cli/ — i.e. refreshable by these same credentials.
 *
 * The clientSecret is NOT committed: GitHub secret scanning blocks the push
 * because it matches the Google OAuth client secret pattern, even though the
 * value is public (shipped in the Antigravity binary). It is read from, in
 * order: the GOOGLE_OAUTH_CLIENT_SECRET env var, or a local gitignored file at
 * ~/.config/kiro-proxy/google-oauth-client.json ({clientId, clientSecret}).
 * Without either, browser sign-in and refresh are disabled. Forks that ship
 * their own client can set the env var or drop the local file.
 */
const LOCAL_CLIENT_CONFIG_PATH = path.join(os.homedir(), '.config', 'kiro-proxy', 'google-oauth-client.json');

function readLocalClientConfig() {
    try {
        const raw = fs.readFileSync(LOCAL_CLIENT_CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return { clientId: parsed.clientId || '', clientSecret: parsed.clientSecret || '' };
    } catch {
        return { clientId: '', clientSecret: '' };
    }
}

const LOCAL_CLIENT = readLocalClientConfig();

export const GOOGLE_OAUTH_CLIENT = {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || LOCAL_CLIENT.clientId || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || LOCAL_CLIENT.clientSecret || ''
};

export const GOOGLE_OAUTH = {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo',
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs'
    ]
};

/** Refresh this far ahead of expiry so a request never races the deadline. */
export const TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;

/**
 * Client identity sent in the loadCodeAssist/onboardUser body.
 * ideType 9 = Antigravity, pluginType 2 = Gemini.
 */
export const CLIENT_METADATA = {
    ideType: 9,
    pluginType: 2,
    platform: 'PLATFORM_UNSPECIFIED'
};

/**
 * Upper bound the upstream enforces on generationConfig.maxOutputTokens.
 * Exceeding it is rejected, so requests are clamped instead.
 */
export const MAX_OUTPUT_TOKENS = 64000;

/**
 * Fields Google's generateContent rejects outright.
 *
 * Mostly thinking-related knobs that Anthropic clients set at the body root.
 * Leaving any of them in fails the whole request before it is processed.
 */
export const REQUEST_BLACKLIST = [
    'output_config',
    'thinking',
    'reasoning_effort',
    'reasoning',
    'enable_thinking',
    'thinking_budget',
    'thinkingConfig'
];

/**
 * Gemini 3+ rejects a functionCall part with no thoughtSignature, and clients do
 * not persist signatures in their history, so one is backfilled onto any
 * functionCall that arrives without it.
 *
 * This is an opaque signed blob the upstream issued, taken verbatim from 9router.
 * It cannot be synthesised — an arbitrary string is rejected — so it is a fixed
 * constant rather than something we generate.
 */
export const DEFAULT_THOUGHT_SIGNATURE =
    'EuwGCukGAXLI2nxwZIq54WWSoL/YN0P3TsDZ7zRnLi8g0S4aVr2HUGxvaHKySuY6HAVzcE0GPGjXrytLIldxthSvfxgUlJh6Qa9Z+Oj5QZBlYdg6HaJ6yuY5R7waE6rdwBsRf7Ft2j3DJ9rMi9qhWFqApewYtPhls3VHtuvND3l8Rm09+lbAXQs6KKWEWrxNLKTBkfpMgXhRERc/TQRMZu1twAablm6/Zk1tsYRvfWKLsNbeKF+CCojJdXJKvnR/8Ouuoa+Y2Ti20hcW7aZIIjZDFYPU//k6Ybmhg69J/imbFai2ckhfLaisqdDkdoIiBJScTOUvYqP6AE9d4MsydSC+UlhIMk4hoP76R8vUSCZRMkjOaDXstf/QoVZKbt94wyRZgAJ1G0BqI8L5ow86kLpA4wJEtxsRGymOE4bKUvApveBakYDNM9APkf+LbtbzWSseGjoZcSlycF9iN8Q2XNYKRrHbv3Lr5Y8JjdH/5y/6SHkNehTEZugaeGnSPSyCTWto1kQgHpxdWmhkLfJGNUGLmue7Mesj4TSms4J33mRpYVhNB/J333FCqIP0hr/E7BkkjEn7yZ4X7SQlh+xKPurapsnHRwiKmtsilmEFrnTE9iQr+pMr6M29qqFNv1tr5yumbaJw8JW9sB15tNsRv+dW6BjNanbsKz7HCgKUBc8tGy+7YuhXzAfViyRefcjK7eZW0Fbyt7AbybJTKz78W8NH7ye6LAwzOebXpeZ4D43fNIt8bKh26qgduSQv/7o+pAflkuqHZ99YWgHQ8h8OkZFi3eOiSYjsjhdZ/czWOdoPI/OnqIldzMPF5YlrKBLFX8VhRKVmqgsmWf5PHGulHhMkVlS+XG2UIseGy69ARa93D78Gsa+1n1kJr7EEB7Rh+27vUMxVYLdz1yMSvE5nalTAlg/ZeG8+XQ0cHuAI3KbQpHW2Q++RdXfm5JzD5WdJZUU+Zn8t8UUn85BH4RxZLeE0qJikgSsKoYVBc6YhiMjhPgkR95ReimY4Z0xCJdRo1gjexOFeODZMpQF6Yxnoic7IrdgsFA3iePTbFnPp3IAM1fAThWhXJUn3QInUOTd5o1qmTmn6REbL15g/JQNl+dqUoPkhleeb2V3kjqp1okmO3wMZbPknR3S1LZNmlS72/iBQUm+n2b/RCn4PjmM2';

/**
 * Tool names the real Antigravity IDE ships with.
 *
 * Used two ways when IDE-consistent tooling is enabled (see IDE_CONSISTENT_TOOLS):
 * a client tool whose name is already in this set is passed through untouched, and
 * the set is offered alongside the client's own tools so the declaration list
 * resembles what the IDE sends.
 */
export const IDE_NATIVE_TOOLS = new Set([
    'browser_subagent',
    'command_status',
    'find_by_name',
    'generate_image',
    'grep_search',
    'list_dir',
    'list_resources',
    'multi_replace_file_content',
    'notify_user',
    'read_resource',
    'read_terminal',
    'read_url_content',
    'replace_file_content',
    'run_command',
    'search_web',
    'send_command_input',
    'task_boundary',
    'view_content_chunk',
    'view_file',
    'write_to_file'
]);

/** Suffix distinguishing a client tool from an IDE-native one of the same name. */
export const CLIENT_TOOL_SUFFIX = '_ide';

/**
 * Whether to shape tool declarations like the Antigravity IDE's.
 *
 * When on, client tool names are suffixed and the IDE's own tool names are
 * declared alongside them, so a request looks like IDE traffic rather than a
 * proxy's. This reduces the chance of the account being flagged for using the
 * subscription outside the IDE — which is the actual risk being managed.
 *
 * Set GOOGLE_IDE_CONSISTENT_TOOLS=false to send tools through unchanged. Doing so
 * is more honest about what the client is, and more likely to stand out.
 */
export const IDE_CONSISTENT_TOOLS = process.env.GOOGLE_IDE_CONSISTENT_TOOLS !== 'false';

/** Endpoint builders. */
export const endpoints = {
    generate: (stream) =>
        `${GOOGLE_CHAT_HOST}/${GOOGLE_API_VERSION}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    loadCodeAssist: () => `${GOOGLE_DISCOVERY_HOST}/${GOOGLE_API_VERSION}:loadCodeAssist`,
    onboardUser: () => `${GOOGLE_DISCOVERY_HOST}/${GOOGLE_API_VERSION}:onboardUser`,
    fetchAvailableModels: () => `${GOOGLE_DISCOVERY_HOST}/${GOOGLE_API_VERSION}:fetchAvailableModels`
};

export default {
    GOOGLE_CHAT_HOST,
    GOOGLE_DISCOVERY_HOST,
    GOOGLE_API_VERSION,
    ANTIGRAVITY_USER_AGENT,
    GOOGLE_OAUTH_CLIENT,
    GOOGLE_OAUTH,
    TOKEN_REFRESH_LEAD_MS,
    CLIENT_METADATA,
    MAX_OUTPUT_TOKENS,
    REQUEST_BLACKLIST,
    DEFAULT_THOUGHT_SIGNATURE,
    IDE_NATIVE_TOOLS,
    CLIENT_TOOL_SUFFIX,
    IDE_CONSISTENT_TOOLS,
    endpoints
};
