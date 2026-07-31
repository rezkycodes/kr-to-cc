import { onBeforeUnmount, onMounted, reactive } from 'vue';
import type { GatewayState } from '../types/api';

const POLL_INTERVAL_MS = 15_000;

export function useGatewayStatus() {
  const state = reactive<GatewayState>({
    authenticated: null,
    healthy: null,
    port: null,
    error: null,
    updatedAt: null,
  });

  let timer: ReturnType<typeof setInterval> | undefined;
  let active = true;

  async function refresh() {
    try {
      const [authResponse, healthResponse] = await Promise.all([
        fetch('/oauth/kiro/status', { cache: 'no-store' }),
        fetch('/health', { cache: 'no-store' }),
      ]);
      const [auth, health] = await Promise.all([
        authResponse.json() as Promise<{ authenticated?: boolean }>,
        healthResponse.json() as Promise<{ status?: string; port?: number }>,
      ]);
      if (!active) return;
      state.authenticated = authResponse.ok && auth.authenticated === true;
      state.healthy = healthResponse.ok && health.status === 'ok';
      // The gateway reports its own port; in dev this page is served by Vite on
      // a different one, so never infer it from window.location.
      state.port = typeof health.port === 'number' ? health.port : null;
      state.error = null;
      state.updatedAt = new Date();
    } catch (error) {
      if (!active) return;
      state.authenticated = false;
      state.healthy = false;
      state.error = error instanceof Error ? error.message : 'Gateway status unavailable';
      state.updatedAt = new Date();
    }
  }

  onMounted(() => {
    void refresh();
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  });

  onBeforeUnmount(() => {
    active = false;
    if (timer) clearInterval(timer);
  });

  return { state, refresh };
}
