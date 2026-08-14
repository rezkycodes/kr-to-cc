<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import MetricCell from '../components/MetricCell.vue';
import { USAGE_RANGES, useUsage } from '../composables/useUsage';

const { snapshot, range, loading, error, load, clear } = useUsage();

/** Compact counts: 138235349 reads as 138.2M. */
function compact(value: number | null | undefined) {
  if (value == null) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

const totals = computed(() => snapshot.value?.totals ?? null);

/**
 * How much of the window was measured rather than estimated.
 *
 * Worth stating because Google reports real token counts and Kiro reports none,
 * so a mixed window is part measurement and part heuristic.
 */
const basis = computed(() => {
  const t = totals.value;
  if (!t || t.requests === 0) return null;
  if (t.estimated_requests === 0) return 'measured';
  if (t.measured_requests === 0) return 'estimated';
  return 'part estimated';
});

/** Bar height for the daily series, relative to the busiest day. */
const peak = computed(() =>
  Math.max(1, ...(snapshot.value?.series ?? []).map((d) => d.requests)),
);

function share(row: { requests: number }) {
  const total = totals.value?.requests ?? 0;
  return total > 0 ? Math.round((row.requests / total) * 100) : 0;
}

function shortDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function meanLatency(row: { duration_ms_total: number; requests: number }) {
  if (!row.requests) return '—';
  return `${Math.round(row.duration_ms_total / row.requests)}ms`;
}

onMounted(() => load());
</script>

<template>
  <div class="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="label-micro">Usage</p>
        <h1 class="text-xl font-medium tracking-tight">Where the traffic went</h1>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <button
          v-for="option in USAGE_RANGES"
          :key="option.id"
          type="button"
          class="rounded-md border px-2 py-1 text-[11px] transition-colors"
          :class="
            option.id === range
              ? 'border-foreground/30 bg-accent text-foreground'
              : 'border-border text-muted-foreground hover:text-foreground'
          "
          :aria-pressed="option.id === range"
          @click="load(option.id)"
        >
          {{ option.label }}
        </button>
      </div>
    </header>

    <Alert v-if="error" variant="destructive">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <div v-if="loading && !snapshot" class="flex flex-col gap-3">
      <Skeleton class="h-20 w-full" />
      <Skeleton class="h-40 w-full" />
    </div>

    <template v-else-if="snapshot && totals">
      <!-- Totals. Cost is in Kiro credits; there is no dollar rate to show. -->
      <section class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
        <MetricCell label="Requests" :value="compact(totals.requests)" />
        <MetricCell label="Input" :value="compact(totals.input_tokens)" />
        <MetricCell
          label="Cached"
          :value="totals.cached_tokens == null ? '—' : compact(totals.cached_tokens)"
        />
        <MetricCell label="Output" :value="compact(totals.output_tokens)" />
        <MetricCell
          label="Est. credits"
          :value="totals.cost_credits.toFixed(1)"
          :detail="basis ?? ''"
        />
      </section>

      <p class="text-[10px] leading-relaxed text-muted-foreground">
        {{ snapshot.note }}
        Counts are in Kiro credits, not dollars.
        <template v-if="snapshot.earliest_day">
          History starts {{ snapshot.earliest_day }} and is kept
          {{ snapshot.retention_days }} days.
        </template>
      </p>

      <Empty v-if="totals.requests === 0" class="py-10">
        <EmptyHeader>
          <EmptyTitle>Nothing recorded yet</EmptyTitle>
          <EmptyDescription>
            Send a request through the gateway and it will be attributed here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>

      <template v-else>
        <!-- By provider: the question this page exists to answer. -->
        <section class="rounded-lg border border-border bg-card" aria-labelledby="by-provider">
          <header class="border-b border-border px-4 py-2.5">
            <h2 id="by-provider" class="text-[13px] font-medium">By provider</h2>
          </header>
          <ul class="divide-y divide-border">
            <li
              v-for="row in snapshot.by_provider"
              :key="row.provider"
              class="flex flex-col gap-1.5 px-4 py-2.5"
            >
              <div class="flex items-baseline justify-between gap-2">
                <span class="font-mono text-xs">{{ row.provider }}</span>
                <span class="font-mono text-xs" data-numeric>
                  {{ row.requests }} req · {{ share(row) }}%
                </span>
              </div>
              <div class="h-1 overflow-hidden rounded-full bg-border">
                <div
                  class="h-full rounded-full"
                  :class="row.failed > 0 ? 'bg-signal-hold' : 'bg-signal-ok'"
                  :style="{ width: `${share(row)}%` }"
                />
              </div>
              <p class="flex flex-wrap gap-x-3 font-mono text-[10px] text-muted-foreground">
                <span data-numeric>{{ compact(row.input_tokens) }}↑</span>
                <span data-numeric>{{ compact(row.output_tokens) }}↓</span>
                <span data-numeric>{{ row.cost_credits.toFixed(1) }} cr</span>
                <span data-numeric>{{ meanLatency(row) }} avg</span>
                <span v-if="row.failed" class="text-signal-fail" data-numeric>
                  {{ row.failed }} failed
                </span>
              </p>
            </li>
          </ul>
        </section>

        <!-- Per-day requests. A bar per day, so a spike is visible. -->
        <section
          v-if="snapshot.series.length > 1"
          class="rounded-lg border border-border bg-card"
          aria-labelledby="per-day"
        >
          <header class="border-b border-border px-4 py-2.5">
            <h2 id="per-day" class="text-[13px] font-medium">Requests per day</h2>
          </header>
          <div class="flex items-end gap-1 px-4 py-3" style="height: 96px">
            <div
              v-for="day in snapshot.series"
              :key="day.date"
              class="flex-1 rounded-t bg-signal-ok/70"
              :style="{ height: `${Math.max(2, (day.requests / peak) * 100)}%` }"
              :title="`${day.date}: ${day.requests} requests`"
            />
          </div>
          <p class="flex justify-between px-4 pb-2 font-mono text-[10px] text-muted-foreground">
            <span>{{ snapshot.series[0]?.date }}</span>
            <span>{{ snapshot.series[snapshot.series.length - 1]?.date }}</span>
          </p>
        </section>

        <!-- By model, keyed on provider too: the same id exists on two providers. -->
        <section class="rounded-lg border border-border bg-card" aria-labelledby="by-model">
          <header class="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h2 id="by-model" class="text-[13px] font-medium">By model</h2>
            <span class="label-micro">{{ snapshot.by_model.length }} models</span>
          </header>
          <div class="overflow-x-auto">
            <table class="w-full text-left">
              <thead>
                <tr class="border-b border-border">
                  <th class="label-micro px-4 py-2 font-normal">Model</th>
                  <th class="label-micro px-4 py-2 font-normal">Provider</th>
                  <th class="label-micro px-4 py-2 text-right font-normal">Req</th>
                  <th class="label-micro px-4 py-2 text-right font-normal">In</th>
                  <th class="label-micro px-4 py-2 text-right font-normal">Out</th>
                  <th class="label-micro px-4 py-2 text-right font-normal">Credits</th>
                  <th class="label-micro px-4 py-2 text-right font-normal">Last</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in snapshot.by_model"
                  :key="`${row.provider}/${row.model}`"
                  class="border-b border-border/60 last:border-0"
                >
                  <td class="truncate px-4 py-2 font-mono text-xs">{{ row.model }}</td>
                  <td class="px-4 py-2 font-mono text-[10px] text-muted-foreground">
                    {{ row.provider }}
                  </td>
                  <td class="px-4 py-2 text-right font-mono text-xs" data-numeric>
                    {{ row.requests }}
                  </td>
                  <td class="px-4 py-2 text-right font-mono text-[11px] text-muted-foreground" data-numeric>
                    {{ compact(row.input_tokens) }}
                  </td>
                  <td class="px-4 py-2 text-right font-mono text-[11px] text-muted-foreground" data-numeric>
                    {{ compact(row.output_tokens) }}
                  </td>
                  <td class="px-4 py-2 text-right font-mono text-[11px]" data-numeric>
                    {{ row.cost_credits.toFixed(2) }}
                  </td>
                  <td class="px-4 py-2 text-right font-mono text-[10px] text-muted-foreground">
                    {{ shortDate(row.last_used) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- Individual requests, from the live window rather than the rollups. -->
        <section
          v-if="snapshot.recent.length"
          class="rounded-lg border border-border bg-card"
          aria-labelledby="recent"
        >
          <header class="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h2 id="recent" class="text-[13px] font-medium">Recent requests</h2>
            <span class="label-micro">live window · lost on restart</span>
          </header>
          <ul class="divide-y divide-border">
            <li
              v-for="(item, index) in snapshot.recent"
              :key="index"
              class="flex items-center gap-3 px-4 py-2"
            >
              <span
                class="size-1.5 shrink-0 rounded-full"
                :class="item.outcome === 'success' ? 'bg-signal-ok' : 'bg-signal-fail'"
                :aria-label="item.outcome"
              />
              <span class="min-w-0 flex-1 truncate font-mono text-xs">
                {{ item.served_model || item.model }}
              </span>
              <span class="shrink-0 font-mono text-[10px] text-muted-foreground">
                {{ item.served_provider }}
              </span>
              <span class="shrink-0 font-mono text-[10px] text-muted-foreground" data-numeric>
                {{ compact(item.input_tokens) }}↑ {{ compact(item.output_tokens) }}↓
              </span>
              <span class="shrink-0 font-mono text-[10px] text-muted-foreground" data-numeric>
                {{ item.duration_ms }}ms
              </span>
            </li>
          </ul>
        </section>

        <Separator />

        <div class="flex items-center justify-between gap-3">
          <p class="text-[10px] text-muted-foreground">
            Clearing forgets every stored counter. It cannot be undone.
          </p>
          <Button variant="outline" size="sm" @click="clear()">Clear history</Button>
        </div>
      </template>
    </template>
  </div>
</template>
