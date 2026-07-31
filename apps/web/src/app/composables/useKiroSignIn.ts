import { ref } from 'vue';
import type { KiroSource } from '../types/api';

type Provider = 'google' | 'github';

export interface ActionResult {
  kind: 'ok' | 'error';
  message: string;
}

interface AuthorizeResponse {
  authUrl: string;
  state: string;
  codeVerifier: string;
  error?: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string; success?: boolean };
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

/**
 * Drives the three Kiro credential paths exposed by /oauth/kiro: browser sign-in,
 * importing a credential already on this machine, and pasting a refresh token.
 */
export function useKiroSignIn() {
  const authenticated = ref<boolean | null>(null);
  const sources = ref<KiroSource[]>([]);
  const scanning = ref(false);
  const busy = ref<string | null>(null);
  const result = ref<ActionResult | null>(null);
  const pendingProvider = ref<Provider | null>(null);
  const callbackValue = ref('');
  const refreshToken = ref('');

  let pkce: { codeVerifier: string; state: string; provider: Provider } | null = null;

  function report(kind: ActionResult['kind'], message: string) {
    result.value = { kind, message };
  }

  async function refreshStatus() {
    try {
      const response = await fetch('/oauth/kiro/status', { cache: 'no-store' });
      const payload = (await response.json()) as { authenticated?: boolean };
      authenticated.value = response.ok && payload.authenticated === true;
    } catch {
      authenticated.value = false;
    }
  }

  async function scanSources() {
    scanning.value = true;
    try {
      const response = await fetch('/oauth/kiro/sources', { cache: 'no-store' });
      const payload = (await response.json()) as { sources?: KiroSource[]; error?: string };
      sources.value = payload.sources ?? [];
      if (payload.error) report('error', payload.error);
    } catch (cause) {
      sources.value = [];
      report('error', cause instanceof Error ? cause.message : 'Could not scan this machine');
    } finally {
      scanning.value = false;
    }
  }

  async function startBrowserSignIn(provider: Provider) {
    busy.value = provider;
    try {
      const response = await fetch(`/oauth/kiro/authorize?provider=${provider}`);
      const payload = (await response.json()) as AuthorizeResponse;
      if (!response.ok) throw new Error(payload.error || 'Could not build the login URL');
      pkce = { codeVerifier: payload.codeVerifier, state: payload.state, provider };
      pendingProvider.value = provider;
      window.open(payload.authUrl, '_blank', 'noopener');
      report('ok', 'Login tab opened. Paste the callback URL to finish.');
    } catch (cause) {
      report('error', cause instanceof Error ? cause.message : 'Sign-in could not start');
    } finally {
      busy.value = null;
    }
  }

  async function completeBrowserSignIn() {
    if (!pkce) return report('error', 'Start a browser sign-in first.');
    if (!callbackValue.value.trim()) return report('error', 'Paste the callback URL or code.');
    busy.value = 'callback';
    try {
      const payload = await postJson<{ email?: string }>('/oauth/kiro/exchange', {
        callback: callbackValue.value.trim(),
        codeVerifier: pkce.codeVerifier,
        state: pkce.state,
        provider: pkce.provider,
      });
      report('ok', payload.email ? `Signed in as ${payload.email}.` : 'Signed in.');
      callbackValue.value = '';
      pendingProvider.value = null;
      pkce = null;
      await refreshStatus();
    } catch (cause) {
      report('error', cause instanceof Error ? cause.message : 'Could not complete sign-in');
    } finally {
      busy.value = null;
    }
    return undefined;
  }

  async function importSource(source: KiroSource) {
    busy.value = source.id;
    try {
      const payload = await postJson<{ label?: string; email?: string }>(
        '/oauth/kiro/auto-import',
        { source: source.id },
      );
      const who = payload.email ? ` as ${payload.email}` : '';
      report('ok', `Imported from ${payload.label || source.label}${who}.`);
      await refreshStatus();
    } catch (cause) {
      report('error', cause instanceof Error ? cause.message : 'Import failed');
    } finally {
      busy.value = null;
    }
  }

  async function importRefreshToken() {
    if (!refreshToken.value.trim()) return report('error', 'Enter a refresh token.');
    busy.value = 'token';
    try {
      const payload = await postJson<{ email?: string }>('/oauth/kiro/import', {
        refreshToken: refreshToken.value.trim(),
      });
      report('ok', payload.email ? `Token accepted for ${payload.email}.` : 'Token accepted.');
      refreshToken.value = '';
      await refreshStatus();
    } catch (cause) {
      report('error', cause instanceof Error ? cause.message : 'Token was rejected');
    } finally {
      busy.value = null;
    }
    return undefined;
  }

  return {
    authenticated,
    sources,
    scanning,
    busy,
    result,
    pendingProvider,
    callbackValue,
    refreshToken,
    refreshStatus,
    scanSources,
    startBrowserSignIn,
    completeBrowserSignIn,
    importSource,
    importRefreshToken,
  };
}
