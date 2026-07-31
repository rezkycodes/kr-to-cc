<script setup lang="ts">
/**
 * LiveTrace — the one animated element in the app.
 *
 * Reads like a strip-chart recorder: one column per second, newest at the right
 * edge, the whole plot sliding left continuously. Motion comes from a single
 * requestAnimationFrame loop that derives a sub-second offset from the last tick
 * timestamp, so the scroll is self-correcting when a frame is late and it never
 * touches layout — only a transform.
 *
 * Outcomes are stacked because the interesting quantity is total load per second,
 * and the fill order follows the severity ramp: calm below, failures on top.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { LiveSample } from '../types/api';

const props = withDefaults(
  defineProps<{
    samples: LiveSample[];
    tickIntervalMs?: number;
    lastTickAt?: number;
    live?: boolean;
  }>(),
  { tickIntervalMs: 1_000, lastTickAt: 0, live: true },
);

const VIEW_WIDTH = 1200;
const VIEW_HEIGHT = 260;
/**
 * The plot fills the viewBox almost entirely: labels live in HTML rows above and
 * below the SVG, so no gridline can ever cross a caption. The few units of inset
 * are only there to keep the ceiling and baseline strokes off the clip edge.
 */
const PLOT_TOP = 6;
const PLOT_BOTTOM = VIEW_HEIGHT - 6;

const column = computed(() => VIEW_WIDTH / Math.max(1, props.samples.length - 1));

/** Sub-column scroll progress, 0 → 1 between ticks. */
const progress = ref(0);
let frame = 0;
const reduceMotion =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

function loop() {
  if (reduceMotion?.matches || !props.live || !props.lastTickAt) {
    progress.value = 0;
  } else {
    const elapsed = Date.now() - props.lastTickAt;
    progress.value = Math.min(1, Math.max(0, elapsed / props.tickIntervalMs));
  }
  frame = requestAnimationFrame(loop);
}

onMounted(() => {
  frame = requestAnimationFrame(loop);
});
onBeforeUnmount(() => cancelAnimationFrame(frame));

const totals = computed(() => props.samples.map((s) => s.ok + s.fail + s.hold));
const peak = computed(() => Math.max(...totals.value, 0));

/**
 * The vertical scale eases toward the peak instead of snapping, so a single
 * burst does not visually flatten the history around it.
 */
const scale = ref(4);
watch(
  peak,
  (next) => {
    const target = Math.max(4, next * 1.25);
    scale.value = scale.value + (target - scale.value) * (target > scale.value ? 0.55 : 0.12);
  },
  { immediate: true },
);

function x(index: number) {
  return index * column.value;
}

function y(value: number) {
  const ratio = Math.min(1, value / Math.max(1, scale.value));
  return PLOT_BOTTOM - ratio * (PLOT_BOTTOM - PLOT_TOP);
}

/** Cumulative stack: ok, then ok+hold, then the full total. */
function stackAt(index: number, layer: 'ok' | 'hold' | 'fail') {
  const sample = props.samples[index];
  if (!sample) return 0;
  if (layer === 'ok') return sample.ok;
  if (layer === 'hold') return sample.ok + sample.hold;
  return sample.ok + sample.hold + sample.fail;
}

function areaPath(layer: 'ok' | 'hold' | 'fail') {
  if (props.samples.length < 2) return '';
  const top = props.samples
    .map((_, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(stackAt(index, layer)).toFixed(1)}`)
    .join(' ');
  return `${top} L${x(props.samples.length - 1).toFixed(1)},${PLOT_BOTTOM} L0,${PLOT_BOTTOM} Z`;
}

const layers = [
  { key: 'fail', label: 'Failed', color: 'var(--signal-fail)' },
  { key: 'hold', label: 'Canceled', color: 'var(--signal-hold)' },
  { key: 'ok', label: 'Success', color: 'var(--signal-ok)' },
] as const;

const latest = computed(() => props.samples[props.samples.length - 1]);
const latestTotal = computed(() => totals.value[totals.value.length - 1] ?? 0);
const idle = computed(() => peak.value === 0);
const edgeY = computed(() => y(latestTotal.value));

const spanLabel = computed(() => `${props.samples.length}s`);
const summary = computed(() => {
  const sum = totals.value.reduce((a, b) => a + b, 0);
  return `${sum} requests over the last ${props.samples.length} seconds, peak ${peak.value} per second.`;
});
</script>

<template>
  <figure class="m-0 flex flex-col">
    <!-- Axis captions sit in their own row so the gridlines never run through them. -->
    <div class="flex items-baseline justify-between gap-3 px-4 pt-3 pb-2">
      <span class="label-micro">−{{ spanLabel }}</span>
      <span v-if="idle" class="label-micro">idle · awaiting traffic</span>
      <span v-else class="font-mono text-[10px] tracking-[0.14em] text-signal-ok uppercase" data-numeric>
        peak {{ peak }}/s
      </span>
    </div>

    <svg
      class="block h-[170px] w-full sm:h-[220px]"
      :viewBox="`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="summary"
    >
      <defs>
        <linearGradient v-for="layer in layers" :id="`trace-${layer.key}`" :key="layer.key" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="layer.color" stop-opacity="0.34" />
          <stop offset="100%" :stop-color="layer.color" stop-opacity="0.02" />
        </linearGradient>
        <!-- Hide the column that scrolls past the left edge. -->
        <clipPath id="trace-clip">
          <rect x="0" y="0" :width="VIEW_WIDTH" :height="VIEW_HEIGHT" />
        </clipPath>
      </defs>

      <g aria-hidden="true" stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke">
        <line
          v-for="ratio in [0, 0.25, 0.5, 0.75, 1]"
          :key="ratio"
          x1="0"
          :y1="PLOT_TOP + ratio * (PLOT_BOTTOM - PLOT_TOP)"
          :x2="VIEW_WIDTH"
          :y2="PLOT_TOP + ratio * (PLOT_BOTTOM - PLOT_TOP)"
          vector-effect="non-scaling-stroke"
        />
      </g>

      <g :clip-path="'url(#trace-clip)'">
        <g :transform="`translate(${(-progress * column).toFixed(2)} 0)`">
          <template v-for="layer in layers" :key="layer.key">
            <path :d="areaPath(layer.key)" :fill="`url(#trace-${layer.key})`" />
            <path
              :d="areaPath(layer.key)"
              fill="none"
              :stroke="layer.color"
              stroke-width="1.5"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          </template>
        </g>
      </g>

      <!-- Leading edge: where the next second will be written. -->
      <line
        :x1="VIEW_WIDTH - 1"
        :y1="PLOT_TOP"
        :x2="VIEW_WIDTH - 1"
        :y2="PLOT_BOTTOM"
        stroke="var(--signal-ok)"
        stroke-width="1"
        :stroke-opacity="latestTotal > 0 ? 0.9 : 0.35"
        vector-effect="non-scaling-stroke"
      />
      <circle
        v-if="latestTotal > 0"
        :cx="VIEW_WIDTH - 1"
        :cy="edgeY"
        r="3"
        fill="var(--signal-ok)"
        class="signal-glow"
      />

      <line
        x1="0"
        :y1="PLOT_BOTTOM"
        :x2="VIEW_WIDTH"
        :y2="PLOT_BOTTOM"
        stroke="var(--border)"
        stroke-width="1"
        vector-effect="non-scaling-stroke"
      />
    </svg>

    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-2.5 pb-3">
      <dl class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div v-for="layer in layers.slice().reverse()" :key="layer.key" class="flex items-center gap-1.5">
          <span class="h-[3px] w-4 shrink-0 rounded-full" :style="{ background: layer.color }" aria-hidden="true" />
          <dt class="label-micro">{{ layer.label }}</dt>
          <dd class="font-mono text-[10px] text-foreground" data-numeric>
            {{ latest ? latest[layer.key] : 0 }}
          </dd>
        </div>
      </dl>
      <span class="label-micro">now</span>
    </div>
  </figure>
</template>
