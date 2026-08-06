<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import StatusPip from './StatusPip.vue';
import type { GatewayState } from '../types/api';

const props = defineProps<{ state: GatewayState }>();

const links = [
  { to: '/dashboard', label: 'Monitor' },
  { to: '/providers', label: 'Providers' },
  { to: '/config/claude', label: 'Configure' },
  { to: '/combos', label: 'Combos' },
];

const host = computed(() => {
  if (typeof window === 'undefined') return 'localhost';
  const { hostname, host: browserHost } = window.location;
  // Show the gateway's address, which is what clients dial. In dev this page is
  // served by Vite on another port, so fall back only when /health is silent.
  return props.state.port ? `${hostname}:${props.state.port}` : browserHost;
});
const online = computed(() => props.state.healthy);
</script>

<template>
  <header class="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-sm">
    <!--
      Two rows below `sm`, one row above. With four sections the nav needs more
      width than is left over after the wordmark and the status pip, so on a phone
      it takes a row of its own rather than being squeezed into a strip that hides
      most of the links behind a horizontal scroll.
    -->
    <div
      class="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 px-4 sm:h-14 sm:flex-nowrap sm:gap-x-6 sm:px-6"
    >
      <RouterLink
        to="/dashboard"
        class="flex h-14 items-center font-mono text-[11px] font-semibold tracking-[0.18em] whitespace-nowrap text-foreground uppercase"
      >
        kiro<span class="text-muted-foreground"> → </span>claude
      </RouterLink>

      <div class="ml-auto flex h-14 items-center gap-4 sm:order-last sm:ml-0">
        <StatusPip :state="online" :label="online === false ? 'offline' : host" pulse />
      </div>

      <!--
        `order-last` puts this on the second row on a phone; from `sm` up it sits
        between the wordmark and the pip. `items-stretch` with a fixed height is
        what lets the active underline sit on the container's bottom edge.
      -->
      <nav
        class="no-scrollbar -mx-2 order-last flex h-12 w-full min-w-0 items-stretch gap-1 overflow-x-auto overflow-y-hidden border-t border-border sm:order-none sm:h-14 sm:w-auto sm:flex-1 sm:border-t-0"
        aria-label="Sections"
      >
        <RouterLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="group relative flex items-center px-2 text-[13px] whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:text-foreground"
        >
          {{ link.label }}
          <span
            class="absolute inset-x-2 bottom-0 hidden h-px bg-foreground group-aria-[current=page]:block"
            aria-hidden="true"
          />
        </RouterLink>
      </nav>
    </div>
  </header>
</template>
