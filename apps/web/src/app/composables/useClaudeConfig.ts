import { computed, reactive, ref } from 'vue';
import type { ClaudeConfigState, ClaudeConfigValues } from '../types/api';
import type { ActionResult } from './useKiroSignIn';

const BLANK: ClaudeConfigValues = {
  baseUrl: '',
  authToken: 'dummy',
  opusModel: '',
  sonnetModel: '',
  haikuModel: '',
  subagentModel: '',
};

/**
 * Reads and writes the managed Claude Code keys in ~/.claude/settings.json via
 * /config/claude. The preview mirrors exactly the env block the server merges,
 * so what is on screen is what lands on disk.
 */
export function useClaudeConfig() {
  const form = reactive<ClaudeConfigValues>({ ...BLANK });
  const state = ref<ClaudeConfigState | null>(null);
  const loading = ref(true);
  const saving = ref(false);
  const result = ref<ActionResult | null>(null);

  /**
   * Whether settings.json on disk already reaches this gateway. The server
   * decides, because it is the only side that knows the base URL is accepted
   * with or without a trailing `/v1`.
   */
  const pointsHere = computed(() => state.value?.pointsHere === true);

  /** Server-authored explanation of a wrong base URL, for the endpoint field. */
  const baseUrlIssue = computed(() => (pointsHere.value ? null : state.value?.baseUrlIssue ?? null));

  const previewJson = computed(() =>
    JSON.stringify(
      {
        env: {
          ANTHROPIC_AUTH_TOKEN: form.authToken || 'dummy',
          ANTHROPIC_BASE_URL: form.baseUrl,
          ANTHROPIC_MODEL: form.opusModel,
          ANTHROPIC_DEFAULT_OPUS_MODEL: form.opusModel,
          ANTHROPIC_DEFAULT_SONNET_MODEL: form.sonnetModel,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: form.haikuModel,
          CLAUDE_CODE_SUBAGENT_MODEL: form.subagentModel,
        },
      },
      null,
      2,
    ),
  );

  function applyValues(values: ClaudeConfigValues) {
    Object.assign(form, values);
  }

  async function load() {
    loading.value = true;
    try {
      const response = await fetch('/config/claude/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not read Claude settings (${response.status})`);
      const payload = (await response.json()) as ClaudeConfigState;
      state.value = payload;
      const current = payload.current ?? {};
      applyValues({
        // The endpoint always follows the proxy that served this page, never a
        // stale value left in settings.json.
        baseUrl: payload.suggestedBaseUrl,
        authToken: current.authToken || payload.defaults.authToken,
        opusModel: current.opusModel || payload.defaults.opusModel,
        sonnetModel: current.sonnetModel || payload.defaults.sonnetModel,
        haikuModel: current.haikuModel || payload.defaults.haikuModel,
        subagentModel: current.subagentModel || payload.defaults.subagentModel,
      });
      if (payload.error) result.value = { kind: 'error', message: payload.error };
    } catch (cause) {
      result.value = {
        kind: 'error',
        message: cause instanceof Error ? cause.message : 'Claude settings unavailable',
      };
    } finally {
      loading.value = false;
    }
  }

  function restoreDefaults() {
    if (!state.value) return;
    applyValues({ ...state.value.defaults, baseUrl: state.value.suggestedBaseUrl });
    result.value = { kind: 'ok', message: 'Defaults restored. Not saved yet.' };
  }

  async function save() {
    saving.value = true;
    try {
      const response = await fetch('/config/claude/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form }),
      });
      const payload = (await response.json()) as {
        success?: boolean;
        error?: string;
        settingsPath?: string;
        backupPath?: string;
      };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || `Save failed (${response.status})`);
      }
      const backup = payload.backupPath?.split('/').pop();
      result.value = {
        kind: 'ok',
        message: `Saved to ${payload.settingsPath}${backup ? ` · backup ${backup}` : ''}. Restart Claude Code.`,
      };
      await load();
    } catch (cause) {
      result.value = {
        kind: 'error',
        message: cause instanceof Error ? cause.message : 'Save failed',
      };
    } finally {
      saving.value = false;
    }
  }

  async function copyPreview() {
    try {
      await navigator.clipboard.writeText(previewJson.value);
      result.value = { kind: 'ok', message: 'Copied the settings block.' };
    } catch {
      result.value = { kind: 'error', message: 'Clipboard is blocked. Select the JSON to copy it.' };
    }
  }

  return {
    form,
    state,
    loading,
    saving,
    result,
    pointsHere,
    baseUrlIssue,
    previewJson,
    load,
    restoreDefaults,
    save,
    copyPreview,
  };
}
