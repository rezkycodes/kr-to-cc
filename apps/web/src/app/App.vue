<script setup lang="ts">
import { RouterView } from 'vue-router';
import AppNav from './components/AppNav.vue';
import { useGatewayStatus } from './composables/useGatewayStatus';

const { state } = useGatewayStatus();
</script>

<template>
  <a
    href="#main"
    class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
  >
    Skip to content
  </a>

  <AppNav :state="state" />

  <main id="main" class="mx-auto max-w-[1440px] px-4 pt-4 pb-16 sm:px-6">
    <RouterView v-slot="{ Component }">
      <component :is="Component" :gateway="state" />
    </RouterView>
  </main>
</template>
