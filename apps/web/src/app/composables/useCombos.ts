import { computed, ref } from 'vue';

/** A combo as stored by the server. */
export interface Combo {
  name: string;
  strategy: string;
  members: { model: string }[];
  created_at?: string;
  updated_at?: string;
}

export interface StrategyInfo {
  id: string;
  label: string;
  summary: string;
  detail: string;
}

export interface SelectableModel {
  id: string;
  namespaced_id: string;
  provider: string;
  description?: string;
}

/**
 * Combo management.
 *
 * The server is the only validator: it owns the rules about name collisions and
 * member resolution, and duplicating them here would let the two disagree. So the
 * form submits and surfaces whatever problems come back.
 */
export function useCombos() {
  const combos = ref<Combo[]>([]);
  const strategies = ref<StrategyInfo[]>([]);
  const models = ref<SelectableModel[]>([]);

  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  /** Per-field problems from the last save attempt. */
  const problems = ref<string[]>([]);

  /** Models grouped by provider, for the picker. */
  const modelsByProvider = computed(() => {
    const groups = new Map<string, SelectableModel[]>();
    for (const model of models.value) {
      // A combo cannot contain another combo, so they are not offered.
      if (model.provider === 'combo') continue;
      const bucket = groups.get(model.provider);
      if (bucket) bucket.push(model);
      else groups.set(model.provider, [model]);
    }
    return [...groups.entries()].map(([provider, items]) => ({ provider, items }));
  });

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      const response = await fetch('/ui/combos');
      if (!response.ok) throw new Error(`Could not load combos (HTTP ${response.status})`);
      const data = await response.json();
      combos.value = data.combos ?? [];
      strategies.value = data.strategies ?? [];
      models.value = data.models ?? [];
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  /**
   * Create or replace a combo.
   * @returns true when saved
   */
  async function save(
    definition: { name: string; strategy: string; members: string[] },
    replaces?: string,
  ): Promise<boolean> {
    saving.value = true;
    error.value = null;
    problems.value = [];
    try {
      const response = await fetch('/ui/combos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: definition.name,
          strategy: definition.strategy,
          members: definition.members.map((model) => ({ model })),
          ...(replaces ? { replaces } : {}),
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        // The server returns every problem at once so the whole form can be
        // corrected in one pass.
        problems.value = data?.error?.problems ?? [];
        error.value = data?.error?.message ?? `Save failed (HTTP ${response.status})`;
        return false;
      }

      await load();
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      saving.value = false;
    }
  }

  async function remove(name: string): Promise<boolean> {
    error.value = null;
    try {
      const response = await fetch(`/ui/combos/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Could not delete "${name}" (HTTP ${response.status})`);
      await load();
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return false;
    }
  }

  return {
    combos,
    strategies,
    models,
    modelsByProvider,
    loading,
    saving,
    error,
    problems,
    load,
    save,
    remove,
  };
}
