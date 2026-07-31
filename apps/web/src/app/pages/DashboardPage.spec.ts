import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DashboardPage from './DashboardPage.vue';
import type { TelemetrySnapshot } from '../types/api';

const busySnapshot: TelemetrySnapshot = {
  generated_at: '2026-07-31T13:00:00.000Z',
  window_minutes: 60,
  retention_minutes: 360,
  totals: { requests: 12, success: 11, failed: 1, canceled: 0, in_flight: 2, success_rate: 91.7 },
  latency_ms: { p50: 420, p95: 3_400, p99: 3_400, max: 4_100 },
  series: [],
  by_model: [
    {
      model: 'claude-opus-4-8',
      requests: 12,
      success: 11,
      failed: 1,
      canceled: 0,
      success_rate: 91.7,
      p95_latency_ms: 3_400,
    },
  ],
  by_error: [{ type: 'invalid_request_error', count: 1 }],
  recent_failures: [
    {
      request_id: '12345678-1234-1234-1234-123456789abc',
      model: 'claude-opus-4-8',
      stream: false,
      outcome: 'failure',
      status: 400,
      error_type: 'invalid_request_error',
      duration_ms: 120,
      timestamp: '2026-07-31T13:00:00.000Z',
    },
  ],
};

const idleSnapshot: TelemetrySnapshot = {
  ...busySnapshot,
  totals: { requests: 0, success: 0, failed: 0, canceled: 0, in_flight: 0, success_rate: null },
  latency_ms: { p50: null, p95: null, p99: null, max: null },
  by_model: [],
  by_error: [],
  recent_failures: [],
};

function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }),
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    // Force the polling path so a test does not depend on EventSource support.
    vi.stubGlobal('EventSource', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders live aggregates, the trace, and failure detail', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(busySnapshot)));
    const wrapper = mount(DashboardPage);
    await flushPromises();

    const cells = wrapper.findAll('[aria-label="Aggregate metrics"] > div');
    expect(cells).toHaveLength(5);
    expect(cells[0].text()).toContain('12');
    expect(cells[1].text()).toContain('91.7%');
    expect(cells[2].text()).toContain('3.40s');
    expect(cells[3].text()).toContain('2');

    expect(wrapper.find('svg[role="img"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('claude-opus-4-8');
    expect(wrapper.text()).toContain('invalid_request_error');
    expect(wrapper.text()).toContain('Memory-only telemetry');

    wrapper.unmount();
  });

  it('shows empty states instead of inventing metrics', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(idleSnapshot)));
    const wrapper = mount(DashboardPage);
    await flushPromises();

    expect(wrapper.text()).toContain('No traffic yet');
    expect(wrapper.text()).toContain('Nothing failed');
    // No measured requests means no success rate to report.
    expect(wrapper.findAll('[aria-label="Aggregate metrics"] > div')[1].text()).toContain('—');
    expect(wrapper.text()).toContain('idle · awaiting traffic');

    wrapper.unmount();
  });

  it('surfaces stream failures while keeping the panel usable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ error: 'offline' }, 503)));
    const wrapper = mount(DashboardPage);
    await flushPromises();

    expect(wrapper.text()).toContain('Telemetry stream interrupted');
    expect(wrapper.findAll('[data-slot="toggle-group-item"]')).toHaveLength(3);

    wrapper.unmount();
  });
});
