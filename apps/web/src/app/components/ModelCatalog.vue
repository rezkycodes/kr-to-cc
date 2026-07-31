<script setup lang="ts">
/**
 * Model catalog and availability probe.
 *
 * Lives next to the alias fields because that is the only place the answer
 * matters. Metadata is free to read; a probe spends Kiro quota, so it never runs
 * without an explicit click.
 */
import { computed, ref } from 'vue';
import { ChevronDownIcon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface ModelInfo {
  id: string;
  kiro_id?: string;
  context_window?: number | null;
  cost_multiplier?: number;
}

interface CheckResult {
  id: string;
  active: boolean;
  status: string | number;
  latency_ms: number;
}

const open = ref(false);
const models = ref<ModelInfo[]>([]);
const checks = ref(new Map<string, CheckResult>());
const loading = ref(false);
const checking = ref<string | null>(null);
const error = ref<string | null>(null);

const activeCount = computed(() => [...checks.value.values()].filter((r) => r.active).length);

async function loadModels() {
  if (models.value.length || loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    const response = await fetch('/v1/models', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
    const payload = (await response.json()) as { data?: ModelInfo[] };
    models.value = payload.data ?? [];
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Catalog unavailable';
  } finally {
    loading.value = false;
  }
}

async function toggle() {
  open.value = !open.value;
  if (open.value) await loadModels();
}

async function probe(ids: string[], token: string) {
  if (!ids.length) return;
  checking.value = token;
  error.value = null;
  try {
    const response = await fetch(`/v1/models/check?models=${encodeURIComponent(ids.join(','))}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Probe failed (${response.status})`);
    const payload = (await response.json()) as { results?: CheckResult[] };
    const next = new Map(checks.value);
    for (const item of payload.results ?? []) next.set(item.id, item);
    checks.value = next;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Probe unavailable';
  } finally {
    checking.value = null;
  }
}

function context(value: number | null | undefined) {
  if (!value) return 'auto';
  return value >= 1_000_000 ? `${value / 1_000_000}M` : `${Math.round(value / 1_000)}K`;
}
</script>

<template>
  <section class="overflow-hidden rounded-lg border border-border bg-card">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      :aria-expanded="open"
      aria-controls="model-catalog"
      data-testid="catalog-toggle"
      @click="toggle"
    >
      <span class="label-micro">Catalog</span>
      <span class="flex items-center gap-2">
        <span v-if="checks.size" class="font-mono text-[10px] text-signal-ok" data-numeric>
          {{ activeCount }}/{{ checks.size }} active
        </span>
        <ChevronDownIcon
          :class="['size-4 text-muted-foreground transition-transform', open ? 'rotate-180' : '']"
        />
      </span>
    </button>

    <div v-if="open" id="model-catalog" class="border-t border-border">
      <div class="flex items-center justify-between gap-3 px-3 py-2">
        <p class="font-mono text-[10px] leading-relaxed text-muted-foreground">
          A probe sends one minimal request per model and spends quota.
        </p>
        <Button
          variant="outline"
          size="xs"
          :disabled="!!checking || loading"
          data-testid="probe-all"
          @click="probe(models.map((m) => m.id), 'all')"
        >
          <Spinner v-if="checking === 'all'" data-icon="inline-start" />
          Probe all
        </Button>
      </div>

      <p v-if="error" class="px-3 pb-2 font-mono text-[11px] text-signal-fail">{{ error }}</p>
      <p v-if="loading" class="px-3 pb-3 font-mono text-[11px] text-muted-foreground">Loading…</p>

      <ul v-else class="max-h-80 divide-y divide-border overflow-y-auto">
        <li v-for="model in models" :key="model.id" class="flex items-center gap-3 px-3 py-2">
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-xs">{{ model.id }}</p>
            <p class="font-mono text-[10px] text-muted-foreground" data-numeric>
              {{ context(model.context_window) }} ·
              {{ model.cost_multiplier == null ? '—' : `${model.cost_multiplier}×` }}
            </p>
          </div>
          <span
            v-if="checks.get(model.id)"
            :class="[
              'font-mono text-[10px]',
              checks.get(model.id)!.active ? 'text-signal-ok' : 'text-signal-fail',
            ]"
            data-numeric
          >
            {{ checks.get(model.id)!.active ? `${checks.get(model.id)!.latency_ms}ms` : checks.get(model.id)!.status }}
          </span>
          <Button
            variant="ghost"
            size="xs"
            :disabled="!!checking"
            :aria-label="`Probe ${model.id}`"
            @click="probe([model.id], model.id)"
          >
            <Spinner v-if="checking === model.id" />
            <span v-else>Probe</span>
          </Button>
        </li>
      </ul>
    </div>
  </section>
</template>
