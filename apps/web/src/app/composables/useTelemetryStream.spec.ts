import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { LIVE_CAPACITY, useTelemetryStream } from './useTelemetryStream';
import type { LiveSample, TelemetrySnapshot } from '../types/api';

type Listener = (event: MessageEvent<string>) => void;

/** Minimal EventSource stand-in that lets a test dispatch named frames. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Listener[]>();

  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }

  fail() {
    for (const listener of this.listeners.get('error') ?? []) {
      listener({} as MessageEvent<string>);
    }
  }

  static latest() {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}

function snapshot(requests = 0): TelemetrySnapshot {
  return {
    generated_at: '2026-07-31T13:00:00.000Z',
    window_minutes: 60,
    retention_minutes: 360,
    totals: {
      requests,
      success: requests,
      failed: 0,
      canceled: 0,
      in_flight: 0,
      success_rate: requests ? 100 : null,
    },
    latency_ms: { p50: null, p95: null, p99: null, max: null },
    series: [],
    by_model: [],
    by_error: [],
    recent_failures: [],
  };
}

function sample(t: number, ok = 0): LiveSample {
  return { t, ok, fail: 0, hold: 0, p95: null };
}

/** Mounting is the only way to exercise onMounted/onBeforeUnmount hooks. */
function harness() {
  const api: { value?: ReturnType<typeof useTelemetryStream> } = {};
  const wrapper = mount(
    defineComponent({
      setup() {
        api.value = useTelemetryStream();
        return () => null;
      },
    }),
  );
  return { wrapper, stream: api.value! };
}

describe('useTelemetryStream', () => {
  afterEach(() => {
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('seeds a full-width trace before any tick arrives', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { wrapper, stream } = harness();

    expect(stream.live.value).toHaveLength(LIVE_CAPACITY);
    expect(stream.live.value.every((entry) => entry.ok === 0)).toBe(true);
    wrapper.unmount();
  });

  it('applies the init frame and requests the selected window', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { wrapper, stream } = harness();

    expect(FakeEventSource.latest().url).toContain('window=60');
    expect(FakeEventSource.latest().url).toContain(`live=${LIVE_CAPACITY}`);

    FakeEventSource.latest().emit('init', {
      snapshot: snapshot(4),
      live: [sample(1_000, 2), sample(2_000, 2)],
      tick_interval_ms: 1_000,
    });

    expect(stream.snapshot.value?.totals.requests).toBe(4);
    expect(stream.status.value).toBe('live');
    // Backlog is padded so the newest sample stays flush with "now".
    expect(stream.live.value).toHaveLength(LIVE_CAPACITY);
    expect(stream.live.value.at(-1)?.ok).toBe(2);
    wrapper.unmount();
  });

  it('appends ticks without growing past capacity', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { wrapper, stream } = harness();
    const source = FakeEventSource.latest();

    for (let index = 0; index < LIVE_CAPACITY + 20; index++) {
      source.emit('tick', sample(index * 1_000, 1));
    }

    expect(stream.live.value).toHaveLength(LIVE_CAPACITY);
    expect(stream.live.value.every((entry) => entry.ok === 1)).toBe(true);
    wrapper.unmount();
  });

  it('replaces aggregates on snapshot frames and reports stream loss', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { wrapper, stream } = harness();
    const source = FakeEventSource.latest();

    source.emit('snapshot', snapshot(9));
    expect(stream.snapshot.value?.totals.requests).toBe(9);

    source.fail();
    expect(stream.status.value).toBe('offline');
    expect(stream.error.value).toContain('Reconnecting');
    // Values already on screen must survive the gap.
    expect(stream.snapshot.value?.totals.requests).toBe(9);
    wrapper.unmount();
  });

  it('reconnects with the new window when the selection changes', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { wrapper, stream } = harness();
    const first = FakeEventSource.latest();

    stream.windowMinutes.value = 15;
    await nextTick();

    expect(first.closed).toBe(true);
    expect(FakeEventSource.latest().url).toContain('window=15');
    wrapper.unmount();
  });

  it('falls back to polling the snapshot endpoint without EventSource', async () => {
    vi.stubGlobal('EventSource', undefined);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(snapshot(3)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { wrapper, stream } = harness();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/ui/telemetry/data?window=60',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(stream.snapshot.value?.totals.requests).toBe(3);
    expect(stream.status.value).toBe('live');
    wrapper.unmount();
  });
});
