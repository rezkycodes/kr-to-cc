<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    value: string;
    detail?: string;
    /** Numeric source of truth; a change triggers the highlight. */
    watchValue?: number | string | null;
    tone?: 'default' | 'ok' | 'warn' | 'fail';
  }>(),
  { detail: '', watchValue: null, tone: 'default' },
);

const flash = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

// A brief highlight is the only feedback needed to say "this just moved".
watch(
  () => props.watchValue ?? props.value,
  () => {
    flash.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => (flash.value = false), 700);
  },
);

const valueTone = computed(
  () =>
    ({
      default: 'text-foreground',
      ok: 'text-signal-ok',
      warn: 'text-signal-hold',
      fail: 'text-signal-fail',
    })[props.tone],
);
</script>

<template>
  <div class="flex flex-col gap-1 px-4 py-3.5">
    <span class="label-micro">{{ label }}</span>
    <strong
      :class="[
        'font-mono text-[26px] leading-none font-medium tracking-tight transition-opacity duration-500',
        valueTone,
        flash ? 'opacity-55' : 'opacity-100',
      ]"
      data-numeric
    >
      {{ value }}
    </strong>
    <span v-if="detail" class="font-mono text-[10px] text-muted-foreground" data-numeric>{{ detail }}</span>
  </div>
</template>
