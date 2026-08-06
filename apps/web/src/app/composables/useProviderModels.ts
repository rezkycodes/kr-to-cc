import { ref } from 'vue';

export interface ProviderModel {
  id: string;
  namespacedId: string;
  description: string | null;
  contextWindow: number | null;
  costMultiplier: number | null;
  status: string;
  thinking: boolean;
}

export interface QuotaLine {
  resource: string;
  label: string;
  unit: string | null;
  used: number;
  total: number;
  remaining: number | null;
  remainingFraction: number | null;
  resetAt: string | null;
}

/**
 * One account's allowance. Accounts can be on different plans.
 *
 * `quotas` is filled where the account holds one shared allowance (Kiro);
 * `models` is filled where the account holds a figure per model (Google). An
 * account uses one or the other, never both.
 */
export interface AccountQuota {
  connectionId: string;
  label: string;
  plan: string | null;
  resetAt?: string | null;
  quotas?: QuotaLine[];
  models?: Record<string, { remainingFraction: number; resetAt: string | null }>;
  error: string | null;
}

export interface ProviderQuota {
  /** 'model' when metered per model, 'account' when each account has its own. */
  scope: 'model' | 'account' | 'unknown';
  note: string | null;
  accounts: AccountQuota[];
  error: string | null;
}

export interface ModelTestResult {
  ok: boolean;
  durationMs: number;
  reply?: string | null;
  stopReason?: string | null;
  error?: string;
}

/**
 * A provider's models, its quota, and per-model testing.
 *
 * Quota shape differs by provider and the difference is preserved rather than
 * normalised: Google meters per model, Kiro meters the account in shared credits.
 * Showing one account figure on every model row would read as per-model and be
 * wrong.
 */
export function useProviderModels() {
  const models = ref<ProviderModel[]>([]);
  const quota = ref<ProviderQuota | null>(null);
  const unavailable = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** Ids being tested, so each row shows its own spinner. */
  const testing = ref<Set<string>>(new Set());
  const results = ref<Record<string, ModelTestResult>>({});

  async function load(providerId: string) {
    loading.value = true;
    error.value = null;
    unavailable.value = null;
    try {
      const response = await fetch(`/ui/providers/${encodeURIComponent(providerId)}/models`);
      if (!response.ok) throw new Error(`Could not load models (HTTP ${response.status})`);
      const data = await response.json();
      models.value = data.models ?? [];
      quota.value = data.quota ?? null;
      unavailable.value = data.unavailable ?? null;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  /** Test one model. Costs a little quota, so it runs on demand only. */
  async function test(providerId: string, modelId: string) {
    testing.value = new Set([...testing.value, modelId]);
    try {
      const response = await fetch(
        `/ui/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/test`,
        { method: 'POST' },
      );
      const data = await response.json().catch(() => null);
      results.value = {
        ...results.value,
        [modelId]: data ?? { ok: false, durationMs: 0, error: `HTTP ${response.status}` },
      };
    } catch (cause) {
      results.value = {
        ...results.value,
        [modelId]: {
          ok: false,
          durationMs: 0,
          error: cause instanceof Error ? cause.message : String(cause),
        },
      };
    } finally {
      const next = new Set(testing.value);
      next.delete(modelId);
      testing.value = next;
    }
  }

  /**
   * Test every model, one at a time.
   *
   * Sequential on purpose: each call spends quota, and firing them together would
   * make a rate-limit response impossible to attribute to a model.
   */
  async function testAll(providerId: string) {
    for (const model of models.value) {
      await test(providerId, model.id);
    }
  }

  return { models, quota, unavailable, loading, error, testing, results, load, test, testAll };
}
