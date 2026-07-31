<script setup lang="ts">
import { computed } from 'vue';
import type { Tristate } from '../types/api';

const props = withDefaults(
  defineProps<{
    /** null renders as "unknown" rather than guessing a state. */
    state: Tristate;
    label?: string;
    pulse?: boolean;
  }>(),
  { label: '', pulse: false },
);

const tone = computed(() => {
  if (props.state === null) return 'bg-muted-foreground';
  return props.state ? 'bg-signal-ok' : 'bg-signal-fail';
});
</script>

<template>
  <span class="inline-flex items-center gap-2">
    <span class="relative flex size-1.5" aria-hidden="true">
      <span
        v-if="pulse && state === true"
        class="absolute inline-flex size-full animate-ping rounded-full bg-signal-ok opacity-70"
      />
      <span :class="['relative inline-flex size-1.5 rounded-full', tone]" />
    </span>
    <span v-if="label" class="label-micro">{{ label }}</span>
  </span>
</template>
