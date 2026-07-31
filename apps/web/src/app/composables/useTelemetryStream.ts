import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type {
  LiveSample,
  StreamStatus,
  TelemetryInitFrame,
  TelemetrySnapshot,
} from '../types/api';

/** Seconds of per-second history kept in the trace. */
export const LIVE_CAPACITY = 90;
/** Used when neither SSE nor the server tell us the frame cadence. */
const FALLBACK_TICK_MS = 1_000;

export type TelemetryWindow = 15 | 60 | 360;

function emptySample(t: number): LiveSample {
  return { t, ok: 0, fail: 0, hold: 0, p95: null };
}

/**
 * Seed a full-width trace so the chart has a time axis before the first tick
 * arrives, and so a short backlog from the server lands flush against "now".
 */
function padLive(samples: LiveSample[], capacity: number): LiveSample[] {
  const tail = samples.slice(-capacity);
  if (tail.length === capacity) return tail;
  const oldest = tail[0]?.t ?? Date.now();
  const head: LiveSample[] = [];
  for (let index = capacity - tail.length; index > 0; index--) {
    head.push(emptySample(oldest - index * 1_000));
  }
  return [...head, ...tail];
}

/**
 * Live telemetry over server-sent events.
 *
 * The server splits frames by how fast the data actually moves: a 1 Hz `tick`
 * carries one second of outcome counts for the trace, while `snapshot` carries
 * the slower aggregates. Where EventSource is unavailable the composable degrades
 * to polling the same JSON snapshot endpoint, so the page still works.
 */
export function useTelemetryStream(capacity = LIVE_CAPACITY) {
  const windowMinutes = ref<TelemetryWindow>(60);
  const snapshot = ref<TelemetrySnapshot | null>(null);
  const live = shallowRef<LiveSample[]>(padLive([], capacity));
  const status = ref<StreamStatus>('connecting');
  const error = ref<string | null>(null);
  const tickIntervalMs = ref(FALLBACK_TICK_MS);
  /** Advanced on every tick so the trace can key its animation off it. */
  const lastTickAt = ref(Date.now());

  let source: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  function pushSample(sample: LiveSample) {
    const next = live.value.concat(sample);
    live.value = next.length > capacity ? next.slice(next.length - capacity) : next;
    lastTickAt.value = Date.now();
  }

  function parse<T>(payload: string): T | null {
    try {
      return JSON.parse(payload) as T;
    } catch {
      return null;
    }
  }

  async function pollOnce() {
    try {
      const response = await fetch(`/ui/telemetry/data?window=${windowMinutes.value}`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Telemetry request failed (${response.status})`);
      if (disposed) return;
      snapshot.value = (await response.json()) as TelemetrySnapshot;
      status.value = 'live';
      error.value = null;
    } catch (cause) {
      if (disposed) return;
      status.value = 'offline';
      error.value = cause instanceof Error ? cause.message : 'Telemetry unavailable';
    }
  }

  function startPolling() {
    void pollOnce();
    pollTimer = setInterval(() => void pollOnce(), 3_000);
  }

  function connect() {
    disconnect();
    status.value = 'connecting';

    if (typeof EventSource === 'undefined') {
      startPolling();
      return;
    }

    const stream = new EventSource(
      `/ui/telemetry/stream?window=${windowMinutes.value}&live=${capacity}`,
    );
    source = stream;

    stream.addEventListener('init', (event) => {
      const frame = parse<TelemetryInitFrame>((event as MessageEvent<string>).data);
      if (!frame) return;
      snapshot.value = frame.snapshot;
      live.value = padLive(frame.live ?? [], capacity);
      tickIntervalMs.value = frame.tick_interval_ms || FALLBACK_TICK_MS;
      lastTickAt.value = Date.now();
      status.value = 'live';
      error.value = null;
    });

    stream.addEventListener('tick', (event) => {
      const sample = parse<LiveSample>((event as MessageEvent<string>).data);
      if (sample) pushSample(sample);
    });

    stream.addEventListener('snapshot', (event) => {
      const frame = parse<TelemetrySnapshot>((event as MessageEvent<string>).data);
      if (frame) snapshot.value = frame;
    });

    // EventSource reconnects on its own; reflect the gap instead of tearing down.
    stream.addEventListener('open', () => {
      status.value = 'live';
      error.value = null;
    });
    stream.addEventListener('error', () => {
      if (disposed) return;
      status.value = 'offline';
      error.value = 'Stream interrupted. Reconnecting…';
    });
  }

  function disconnect() {
    source?.close();
    source = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  }

  watch(windowMinutes, () => connect());
  onMounted(connect);
  onBeforeUnmount(() => {
    disposed = true;
    disconnect();
  });

  return { windowMinutes, snapshot, live, status, error, tickIntervalMs, lastTickAt };
}
