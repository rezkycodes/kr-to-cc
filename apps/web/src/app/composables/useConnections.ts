import { computed, ref } from 'vue';

export interface Connection {
  id: string;
  provider: string;
  authType: string;
  email: string | null;
  label: string;
  priority: number;
  enabled: boolean;
  credentials: { hasRefreshToken: boolean; expiresAt: number | null; projectId: string | null };
  lastError: string | null;
  lastErrorAt: string | null;
  lastTested: string | null;
  rateLimitedUntil: string | null;
}

export interface ProviderConnections {
  id: string;
  label: string;
  supportsOAuth: boolean;
  /** Which sign-in dialog this provider uses, or null when it has none. */
  signIn: 'google-oauth' | 'kiro-methods' | null;
  connectionCount: number;
  enabledCount: number;
  connections: Connection[];
}

/**
 * Provider accounts.
 *
 * The server owns every rule about credentials — this only reads state and issues
 * commands. Nothing here ever holds a token: the API strips them before they
 * reach the browser.
 */
export function useConnections() {
  const providers = ref<ProviderConnections[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** Ids currently being tested, so each row can show its own spinner. */
  const testing = ref<Set<string>>(new Set());
  const testResults = ref<Record<string, { ok: boolean; error?: string }>>({});

  const totalConnections = computed(() =>
    providers.value.reduce((sum, p) => sum + p.connectionCount, 0),
  );

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      const response = await fetch('/ui/connections');
      if (!response.ok) throw new Error(`Could not load connections (HTTP ${response.status})`);
      providers.value = (await response.json()).providers ?? [];
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  function getProvider(id: string) {
    return providers.value.find((p) => p.id === id) ?? null;
  }

  async function setEnabled(id: string, enabled: boolean) {
    error.value = null;
    try {
      const response = await fetch(`/ui/connections/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error(`Could not update the account (HTTP ${response.status})`);
      await load();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function remove(id: string) {
    error.value = null;
    try {
      const response = await fetch(`/ui/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Could not remove the account (HTTP ${response.status})`);
      await load();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** Move an account within its provider's rotation order. */
  async function move(provider: string, id: string, delta: number) {
    const target = getProvider(provider);
    if (!target) return;
    const ids = target.connections.map((c) => c.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];

    error.value = null;
    try {
      const response = await fetch('/ui/connections/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, ids }),
      });
      if (!response.ok) throw new Error(`Could not reorder (HTTP ${response.status})`);
      await load();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function test(id: string) {
    testing.value = new Set([...testing.value, id]);
    try {
      const response = await fetch(`/ui/connections/${encodeURIComponent(id)}/test`, { method: 'POST' });
      const data = await response.json().catch(() => null);
      testResults.value = {
        ...testResults.value,
        [id]: { ok: Boolean(data?.ok), error: data?.error },
      };
      await load();
    } catch (cause) {
      testResults.value = {
        ...testResults.value,
        [id]: { ok: false, error: cause instanceof Error ? cause.message : String(cause) },
      };
    } finally {
      const next = new Set(testing.value);
      next.delete(id);
      testing.value = next;
    }
  }

  /** Test a provider's accounts one at a time, so failures are attributable. */
  async function testAll(provider: string) {
    const target = getProvider(provider);
    if (!target) return;
    for (const connection of target.connections) {
      await test(connection.id);
    }
  }

  return {
    providers,
    loading,
    error,
    testing,
    testResults,
    totalConnections,
    load,
    getProvider,
    setEnabled,
    remove,
    move,
    test,
    testAll,
  };
}

/**
 * The browser sign-in flow.
 *
 * A popup is tried first. It can fail for reasons we cannot detect — blocked, or
 * opened in a profile that cannot reach back — so the manual paste path is always
 * offered rather than kept as a hidden fallback.
 */
export function useProviderSignIn() {
  const authUrl = ref<string | null>(null);
  const state = ref<string | null>(null);
  const waiting = ref(false);
  const error = ref<string | null>(null);
  const submitting = ref(false);

  /** Ask the server for an authorisation URL and open it. */
  async function begin(): Promise<boolean> {
    error.value = null;
    authUrl.value = null;
    try {
      const response = await fetch('/oauth/google/start');
      if (!response.ok) throw new Error(`Could not start sign-in (HTTP ${response.status})`);
      const data = await response.json();
      authUrl.value = data.authUrl;
      state.value = data.state;
      waiting.value = true;
      window.open(data.authUrl, 'kiro-proxy-oauth', 'width=520,height=680');
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return false;
    }
  }

  /** Finish from a pasted callback URL. */
  async function complete(callbackUrl: string): Promise<boolean> {
    submitting.value = true;
    error.value = null;
    try {
      const response = await fetch('/oauth/google/manual', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callbackUrl }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        error.value = data?.error?.message ?? `Sign-in failed (HTTP ${response.status})`;
        return false;
      }
      waiting.value = false;
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      submitting.value = false;
    }
  }

  function reset() {
    authUrl.value = null;
    state.value = null;
    waiting.value = false;
    error.value = null;
  }

  return { authUrl, state, waiting, error, submitting, begin, complete, reset };
}
