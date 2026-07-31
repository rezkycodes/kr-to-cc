/**
 * Claude Code Settings Manager
 *
 * Reads and writes ~/.claude/settings.json for the Claude Code CLI. Only the
 * proxy-managed `env` keys are touched; every other key/setting in the file is
 * preserved. A timestamped backup is written before any overwrite.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

// Path to Claude Code's settings file.
export const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

// The env keys this proxy manages inside settings.json.
export const MANAGED_ENV_KEYS = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL'
];

/**
 * Read and parse the Claude settings file.
 * @param {string} [path]
 * @returns {{ exists: boolean, settings: Object, error: string|null }}
 */
export function readClaudeSettings(path = CLAUDE_SETTINGS_PATH) {
    if (!existsSync(path)) {
        return { exists: false, settings: {}, error: null };
    }
    try {
        const raw = readFileSync(path, 'utf-8');
        const settings = raw.trim() ? JSON.parse(raw) : {};
        return { exists: true, settings, error: null };
    } catch (error) {
        // File exists but is invalid JSON — surface it rather than clobbering.
        return { exists: true, settings: {}, error: `Invalid JSON in ${path}: ${error.message}` };
    }
}

/**
 * Extract the current proxy-relevant config from a settings object.
 * @param {Object} settings
 * @returns {Object} { baseUrl, authToken, opusModel, sonnetModel, haikuModel, subagentModel }
 */
export function extractConfig(settings) {
    const env = (settings && settings.env) || {};
    return {
        baseUrl: env.ANTHROPIC_BASE_URL || '',
        authToken: env.ANTHROPIC_AUTH_TOKEN || '',
        model: env.ANTHROPIC_MODEL || '',
        opusModel: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
        sonnetModel: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
        haikuModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
        subagentModel: env.CLAUDE_CODE_SUBAGENT_MODEL || ''
    };
}

/**
 * Build the env object to merge into settings.json from a config request.
 * Empty/undefined values are skipped so they don't clobber existing entries.
 * @param {Object} config
 * @returns {Object} env fragment
 */
function buildEnvFragment(config) {
    const env = {};
    const set = (key, value) => {
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            env[key] = String(value).trim();
        }
    };
    set('ANTHROPIC_BASE_URL', config.baseUrl);
    set('ANTHROPIC_AUTH_TOKEN', config.authToken);
    set('ANTHROPIC_MODEL', config.model || config.opusModel);
    set('ANTHROPIC_DEFAULT_OPUS_MODEL', config.opusModel);
    set('ANTHROPIC_DEFAULT_SONNET_MODEL', config.sonnetModel);
    set('ANTHROPIC_DEFAULT_HAIKU_MODEL', config.haikuModel);
    set('CLAUDE_CODE_SUBAGENT_MODEL', config.subagentModel);
    return env;
}

/**
 * Build the manual configuration snippet (what a user would paste by hand).
 * @param {Object} config
 * @returns {string} pretty-printed JSON
 */
export function buildManualSnippet(config) {
    const snippet = {
        hasCompletedOnboarding: true,
        env: buildEnvFragment(config)
    };
    return JSON.stringify(snippet, null, 2);
}

/**
 * Apply a config to the Claude settings file: merge the managed env keys into
 * the existing file (preserving everything else), backing up first.
 * @param {Object} config
 * @param {string} [path]
 * @returns {{ success: boolean, settingsPath: string, backupPath: string|null, settings: Object }}
 */
export function applyClaudeSettings(config, path = CLAUDE_SETTINGS_PATH) {
    const { settings: existing, error } = readClaudeSettings(path);
    if (error) {
        throw new Error(error);
    }

    // Start from existing settings, preserving unrelated keys.
    const next = { ...existing };

    // Ensure onboarding flag so Claude Code doesn't prompt again.
    if (next.hasCompletedOnboarding === undefined) {
        next.hasCompletedOnboarding = true;
    }

    // Merge env: keep existing env vars, override the managed ones.
    next.env = { ...(existing.env || {}), ...buildEnvFragment(config) };

    // Ensure directory exists.
    mkdirSync(dirname(path), { recursive: true });

    // Back up the existing file before overwriting.
    let backupPath = null;
    if (existsSync(path)) {
        backupPath = `${path}.bak-${Date.now()}`;
        try {
            copyFileSync(path, backupPath);
        } catch {
            backupPath = null; // Non-fatal; proceed with the write.
        }
    }

    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf-8');

    return { success: true, settingsPath: path, backupPath, settings: next };
}

export default {
    CLAUDE_SETTINGS_PATH,
    MANAGED_ENV_KEYS,
    readClaudeSettings,
    extractConfig,
    buildManualSnippet,
    applyClaudeSettings
};
