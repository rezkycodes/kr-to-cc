<script setup lang="ts">
/**
 * Monitor — a dense instrument panel. No prose: the live trace answers "is it
 * moving", the cells answer "how well", and the two tables answer "what broke".
 */
import { computed } from 'vue';
import { CircleAlertIcon, RadioIcon } from '@lucide/vue';
import LiveTrace from '../components/LiveTrace.vue';
import MetricCell from '../components/MetricCell.vue';
import StatusPip from '../components/StatusPip.vue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTelemetryStream, type TelemetryWindow } from '../composables/useTelemetryStream';

const { windowMinutes, snapshot, live, status, error, tickIntervalMs, lastTickAt } =
  useTelemetryStream();

const WINDOWS: { value: TelemetryWindow; label: string }[] = [
  { value: 15, label: '15m' },
  { value: 60, label: '1h' },
  { value: 360, label: '6h' },
];

function setWindow(next: unknown) {
  const value = Number(next);
  if (value === 15 || value === 60 || value === 360) windowMinutes.value = value;
}

const totals = computed(() => snapshot.value?.totals);
const latency = computed(() => snapshot.value?.latency_ms);
const usage = computed(() => snapshot.value?.usage);
const recent = computed(() => snapshot.value?.recent_requests ?? []);

/**
 * Compact token counts — 68,784 reads as 68.8k once the column is dense.
 * Null stays an em dash: the upstream never reported it, which is not zero.
 */
function tokens(value: number | null | undefined) {
  if (value == null) return '—';
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * How the token counts were arrived at.
 *
 * Providers differ: Google reports measured usage, Kiro reports none so it is
 * estimated locally. A window with both needs to say so rather than labelling
 * everything one way.
 */
const measurementNote = computed(() => {
  const u = usage.value;
  if (!u) return '';
  const estimated = u.estimated_requests ?? 0;
  const measured = u.measured_requests ?? 0;
  if (estimated > 0 && measured > 0) return ' · part estimated';
  if (estimated > 0) return ' · estimated';
  if (measured > 0) return ' · measured';
  return '';
});

/** Kiro credits, the only cost basis the upstream exposes. */
function credits(value: number | null | undefined) {
  if (value == null) return '—';
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
}

function count(value: number | null | undefined) {
  return value == null ? '—' : new Intl.NumberFormat().format(value);
}

function duration(value: number | null | undefined) {
  if (value == null) return '—';
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}s`;
}

function clockTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

const successRate = computed(() => {
  const rate = totals.value?.success_rate;
  return rate == null ? '—' : `${rate.toFixed(1)}%`;
});

const successTone = computed(() => {
  const rate = totals.value?.success_rate;
  if (rate == null) return 'default';
  if (rate >= 99) return 'ok';
  return rate >= 95 ? 'warn' : 'fail';
});

const streamLabel = computed(
  () => ({ live: 'streaming', connecting: 'connecting', offline: 'reconnecting' })[status.value],
);
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- Live traffic -->
    <section
      class="overflow-hidden rounded-lg border border-border bg-card"
      aria-labelledby="trace-heading"
    >
      <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div class="flex items-center gap-3">
          <h1 id="trace-heading" class="text-[13px] font-medium">Live traffic</h1>
          <StatusPip :state="status === 'live' ? true : status === 'offline' ? false : null" :label="streamLabel" pulse />
        </div>
        <div class="flex items-center gap-3">
          <span class="label-micro hidden sm:inline">Window</span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            :model-value="String(windowMinutes)"
            @update:model-value="setWindow"
          >
            <ToggleGroupItem
              v-for="option in WINDOWS"
              :key="option.value"
              :value="String(option.value)"
              :aria-label="`Aggregate over ${option.label}`"
              class="font-mono text-[11px]"
            >
              {{ option.label }}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </header>

      <LiveTrace
        :samples="live"
        :tick-interval-ms="tickIntervalMs"
        :last-tick-at="lastTickAt"
        :live="status === 'live'"
      />
    </section>

    <Alert v-if="error" variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>Telemetry stream interrupted</AlertTitle>
      <AlertDescription>{{ error }} The last values stay on screen.</AlertDescription>
    </Alert>

    <!-- Aggregates over the selected window -->
    <section
      class="hairline-grid grid-cols-2 overflow-hidden rounded-lg border border-border sm:grid-cols-3 lg:grid-cols-5"
      aria-label="Aggregate metrics"
    >
      <MetricCell
        label="Requests"
        :value="count(totals?.requests)"
        :watch-value="totals?.requests ?? null"
        :detail="`${count(totals?.success)} ok · ${count(totals?.failed)} failed`"
      />
      <MetricCell
        label="Success rate"
        :value="successRate"
        :watch-value="totals?.success_rate ?? null"
        :tone="successTone"
        :detail="`over ${snapshot?.window_minutes ?? '—'} min`"
      />
      <MetricCell
        label="P95 latency"
        :value="duration(latency?.p95)"
        :watch-value="latency?.p95 ?? null"
        :detail="`p50 ${duration(latency?.p50)} · max ${duration(latency?.max)}`"
      />
      <MetricCell
        label="In flight"
        :value="count(totals?.in_flight)"
        :watch-value="totals?.in_flight ?? null"
        :tone="(totals?.in_flight ?? 0) > 0 ? 'ok' : 'default'"
        detail="open right now"
      />
      <MetricCell
        label="Canceled"
        :value="count(totals?.canceled)"
        :watch-value="totals?.canceled ?? null"
        :tone="(totals?.canceled ?? 0) > 0 ? 'warn' : 'default'"
        detail="aborted by client"
      />
    </section>

    <!-- Token and credit accounting over the same window -->
    <section
      class="hairline-grid grid-cols-2 overflow-hidden rounded-lg border border-border lg:grid-cols-4"
      aria-label="Token usage"
    >
      <MetricCell
        label="Input tokens"
        :value="tokens(usage?.input_tokens)"
        :watch-value="usage?.input_tokens ?? null"
        :detail="`prompt sent${measurementNote}`"
      />
      <MetricCell
        label="Cached tokens"
        :value="tokens(usage?.cached_tokens)"
        :watch-value="usage?.cached_tokens ?? null"
        detail="not reported by Kiro"
      />
      <MetricCell
        label="Output tokens"
        :value="tokens(usage?.output_tokens)"
        :watch-value="usage?.output_tokens ?? null"
        :tone="(usage?.output_tokens ?? 0) > 0 ? 'ok' : 'default'"
        :detail="`generated${measurementNote}`"
      />
      <MetricCell
        label="Est. credits"
        :value="credits(usage?.cost_credits)"
        :watch-value="usage?.cost_credits ?? null"
        :detail="
          usage?.unpriced_requests
            ? `${usage.priced_requests} priced · ${usage.unpriced_requests} unknown model`
            : `${usage?.priced_requests ?? 0} requests priced`
        "
      />
    </section>

    <div class="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
      <!-- Per-model traffic -->
      <section class="rounded-lg border border-border bg-card" aria-labelledby="models-heading">
        <header class="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 id="models-heading" class="text-[13px] font-medium">By model</h2>
          <span class="label-micro">{{ snapshot?.by_model.length ?? 0 }} active</span>
        </header>

        <Table v-if="snapshot?.by_model.length">
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead class="text-right">Req</TableHead>
              <TableHead class="text-right">In</TableHead>
              <TableHead class="text-right">Out</TableHead>
              <TableHead class="text-right">Success</TableHead>
              <TableHead class="text-right">P95</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="model in snapshot.by_model" :key="model.model">
              <TableCell class="font-mono text-xs">{{ model.model }}</TableCell>
              <TableCell class="text-right font-mono text-xs" data-numeric>{{ model.requests }}</TableCell>
              <TableCell class="text-right font-mono text-xs text-muted-foreground" data-numeric>
                {{ tokens(model.usage.input_tokens) }}
              </TableCell>
              <TableCell class="text-right font-mono text-xs text-signal-ok" data-numeric>
                {{ tokens(model.usage.output_tokens) }}
              </TableCell>
              <TableCell
                :class="[
                  'text-right font-mono text-xs',
                  model.success_rate != null && model.success_rate < 95 ? 'text-signal-fail' : '',
                ]"
                data-numeric
              >
                {{ model.success_rate == null ? '—' : `${model.success_rate.toFixed(1)}%` }}
              </TableCell>
              <TableCell class="text-right font-mono text-xs" data-numeric>
                {{ duration(model.p95_latency_ms) }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <Empty v-else class="py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RadioIcon />
            </EmptyMedia>
            <EmptyTitle>No traffic yet</EmptyTitle>
            <EmptyDescription>Model rows appear after the first request reaches /v1/messages.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>

      <!-- Failure detail -->
      <section class="rounded-lg border border-border bg-card" aria-labelledby="failures-heading">
        <header class="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 id="failures-heading" class="text-[13px] font-medium">Failures</h2>
          <span class="label-micro">newest first</span>
        </header>

        <div v-if="snapshot?.by_error.length" class="flex flex-wrap gap-x-5 gap-y-2 px-4 py-3">
          <div v-for="item in snapshot.by_error" :key="item.type" class="flex items-baseline gap-2">
            <span class="font-mono text-xs text-signal-fail">{{ item.type }}</span>
            <span class="font-mono text-xs text-muted-foreground" data-numeric>{{ item.count }}</span>
          </div>
        </div>
        <Separator v-if="snapshot?.by_error.length" />

        <ul v-if="snapshot?.recent_failures.length" class="divide-y divide-border">
          <li
            v-for="failure in snapshot.recent_failures"
            :key="`${failure.request_id}-${failure.timestamp}`"
            class="flex items-center gap-3 px-4 py-2.5"
          >
            <span
              :class="[
                'size-1.5 shrink-0 rounded-full',
                failure.outcome === 'canceled' ? 'bg-signal-hold' : 'bg-signal-fail',
              ]"
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate font-mono text-xs text-foreground">
                {{ failure.error_type || failure.outcome }}
              </p>
              <p class="truncate font-mono text-[10px] text-muted-foreground">
                {{ failure.model || 'unknown model' }}
              </p>
            </div>
            <div class="shrink-0 text-right">
              <p class="font-mono text-xs text-muted-foreground" data-numeric>
                {{ failure.status ?? '—' }} · {{ duration(failure.duration_ms) }}
              </p>
              <p class="font-mono text-[10px] text-muted-foreground" data-numeric>
                {{ clockTime(failure.timestamp) }}
              </p>
            </div>
          </li>
        </ul>

        <Empty v-else class="py-10">
          <EmptyHeader>
            <EmptyTitle>Nothing failed</EmptyTitle>
            <EmptyDescription>No failed or canceled requests in this window.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    </div>

    <!-- Per-request token flow -->
    <section class="rounded-lg border border-border bg-card" aria-labelledby="recent-heading">
      <header class="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 id="recent-heading" class="text-[13px] font-medium">Recent requests</h2>
        <span class="label-micro">in / out{{ measurementNote }}</span>
      </header>

      <Table v-if="recent.length">
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead class="text-right">In / Out</TableHead>
            <TableHead class="hidden text-right sm:table-cell">Credits</TableHead>
            <TableHead class="hidden text-right sm:table-cell">Took</TableHead>
            <TableHead class="text-right">Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="request in recent" :key="`${request.request_id}-${request.timestamp}`">
            <TableCell class="max-w-[16rem]">
              <span class="flex items-center gap-2">
                <span
                  :class="[
                    'size-1.5 shrink-0 rounded-full',
                    request.outcome === 'success'
                      ? 'bg-signal-ok'
                      : request.outcome === 'canceled'
                        ? 'bg-signal-hold'
                        : 'bg-signal-fail',
                  ]"
                  aria-hidden="true"
                />
                <span class="truncate font-mono text-xs">{{ request.model || 'unknown' }}</span>
              </span>
            </TableCell>
            <TableCell class="text-right font-mono text-xs whitespace-nowrap" data-numeric>
              <span class="text-muted-foreground">
                {{ tokens(request.input_tokens) }}<span aria-label="input">↑</span>
              </span>
              <span class="ml-2 text-signal-ok">
                {{ tokens(request.output_tokens) }}<span aria-label="output">↓</span>
              </span>
            </TableCell>
            <TableCell
              class="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell"
              data-numeric
            >
              {{ credits(request.cost_credits) }}
            </TableCell>
            <TableCell
              class="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell"
              data-numeric
            >
              {{ duration(request.duration_ms) }}
            </TableCell>
            <TableCell class="text-right font-mono text-[10px] text-muted-foreground" data-numeric>
              {{ clockTime(request.timestamp) }}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <Empty v-else class="py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RadioIcon />
          </EmptyMedia>
          <EmptyTitle>No requests yet</EmptyTitle>
          <EmptyDescription>Each request appears here with the tokens it moved.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>

    <p class="px-1 font-mono text-[10px] text-muted-foreground">
      Memory-only telemetry · Google reports measured tokens, Kiro reports none so those are
      estimated · no prompts, headers, credentials, or response bodies · expires after
      {{ snapshot?.retention_minutes ?? 360 }} min
    </p>
  </div>
</template>
