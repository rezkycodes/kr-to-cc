import { ref } from 'vue';

export interface UsageRow {
  provider: string;
  model: string;
  requests: number;
  ok: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  /** Null when no backend in the window reported cache figures. */
  cached_tokens: number | null;
  cost_credits: number;
  estimated_requests: number;
  measured_requests: number;
  duration_ms_total: number;
  last_used: string | null;
}

export interface UsageDay {
  date: string;
  requests: number;
  ok: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  cost_credits: number;
}

export interface RecentRequest {
  model?: string;
  served_model?: string;
  served_provider?: string;
  outcome?: string;
  status?: number;
  duration_ms?: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  timestamp?: string;
}

export interface UsageSnapshot {
  range: string;
  /** Always Kiro credits — there is no dollar rate to report. */
  cost_unit: string;
  days_covered: number;
  retention_days: number;
  earliest_day: string | null;
  totals: UsageRow;
  by_provider: UsageRow[];
  by_model: UsageRow[];
  series: UsageDay[];
  recent: RecentRequest[];
  note: string;
}

export const USAGE_RANGES = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All' },
] as const;

/**
 * Usage history.
 *
 * Read from the persistent daily rollups, which is a different source from the
 * dashboard's live trace: that one keeps six hours in memory and is lost on
 * restart, so it cannot answer questions about a week.
 */
export function useUsage() {
  const snapshot = ref<UsageSnapshot | null>(null);
  const range = ref<string>('7d');
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(next?: string) {
    if (next) range.value = next;
    loading.value = true;
    error.value = null;
    try {
      const response = await fetch(`/ui/usage?range=${encodeURIComponent(range.value)}`);
      if (!response.ok) throw new Error(`Could not load usage (HTTP ${response.status})`);
      snapshot.value = await response.json();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  /** Forget the stored history. Irreversible, so the caller confirms first. */
  async function clear() {
    await fetch('/ui/usage', { method: 'DELETE' });
    await load();
  }

  return { snapshot, range, loading, error, load, clear };
}
