<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import StatusPip from './StatusPip.vue';
import type { GatewayState } from '../types/api';

const props = defineProps<{ state: GatewayState }>();

const links = [
  { to: '/dashboard', label: 'Monitor' },
  { to: '/oauth/kiro', label: 'Sign in' },
  { to: '/config/claude', label: 'Configure' },
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
    <div class="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:gap-6 sm:px-6">
      <RouterLink
        to="/dashboard"
        class="font-mono text-[11px] font-semibold tracking-[0.18em] whitespace-nowrap text-foreground uppercase"
      >
        kiro<span class="text-muted-foreground"> → </span>claude
      </RouterLink>

      <nav
        class="no-scrollbar -mx-2 flex h-14 min-w-0 flex-1 items-stretch gap-1 overflow-x-auto overflow-y-hidden"
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

      <div class="flex items-center gap-4">
        <StatusPip :state="online" :label="online === false ? 'offline' : host" pulse />
      </div>
    </div>
  </header>
</template>
