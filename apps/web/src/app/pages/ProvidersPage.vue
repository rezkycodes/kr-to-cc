<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ArrowLeftIcon, PlusIcon, RefreshCwIcon, Trash2Icon, TriangleAlertIcon } from '@lucide/vue';
import ConnectProviderDialog from '../components/ConnectProviderDialog.vue';
import ConnectKiroDialog from '../components/ConnectKiroDialog.vue';
import ProviderModels from '../components/ProviderModels.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Toggle } from '@/components/ui/toggle';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { useConnections } from '../composables/useConnections';

const {
  providers,
  loading,
  error,
  testing,
  testResults,
  load,
  getProvider,
  setEnabled,
  remove,
  move,
  test,
  testAll,
} = useConnections();

/** Which provider's detail is open; null shows the list. */
const selectedId = ref<string | null>(null);
const connecting = ref(false);

const selected = computed(() => (selectedId.value ? getProvider(selectedId.value) : null));

/**
 * Every provider here reaches its upstream through a subscription session that was
 * not licensed for proxy use. Worth stating plainly rather than burying.
 */
const RISK_NOTICE =
  'This provider uses a subscription/OAuth session that is not officially licensed for '
  + 'proxy use. The account may be restricted or banned. Use at your own risk.';

function accountName(connection: { email: string | null; label: string }) {
  return connection.email || connection.label;
}

/** One-line state for a row. */
function statusOf(connection: {
  enabled: boolean;
  lastError: string | null;
  rateLimitedUntil: string | null;
}) {
  if (!connection.enabled) return { text: 'disabled', tone: 'muted' as const };
  if (connection.rateLimitedUntil && Date.parse(connection.rateLimitedUntil) > Date.now()) {
    return { text: 'rate limited', tone: 'warn' as const };
  }
  if (connection.lastError) return { text: 'error', tone: 'fail' as const };
  return { text: 'active', tone: 'ok' as const };
}

async function onConnected() {
  connecting.value = false;
  await load();
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <Alert v-if="error" variant="destructive">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <!-- Provider list -->
    <template v-if="!selected">
      <div v-if="loading && providers.length === 0" class="grid gap-3 sm:grid-cols-2">
        <Skeleton v-for="n in 4" :key="n" class="h-20 w-full" />
      </div>

      <div v-else class="grid gap-3 sm:grid-cols-2">
        <button
          v-for="provider in providers"
          :key="provider.id"
          type="button"
          class="flex items-start justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-muted-foreground/40"
          @click="selectedId = provider.id"
        >
          <div class="min-w-0">
            <p class="text-[13px] font-medium">{{ provider.label }}</p>
            <p class="mt-1 flex items-center gap-1.5 text-xs">
              <span
                v-if="provider.connectionCount > 0"
                class="size-1.5 rounded-full"
                :class="provider.enabledCount > 0 ? 'bg-signal-ok' : 'bg-signal-hold'"
                aria-hidden="true"
              />
              <span :class="provider.connectionCount > 0 ? 'text-muted-foreground' : 'text-muted-foreground'">
                {{
                  provider.connectionCount === 0
                    ? 'No connections'
                    : `${provider.connectionCount} connected${
                        provider.enabledCount < provider.connectionCount
                          ? ` · ${provider.connectionCount - provider.enabledCount} off`
                          : ''
                      }`
                }}
              </span>
            </p>
          </div>
          <span class="label-micro shrink-0">{{ provider.id }}</span>
        </button>
      </div>
    </template>

    <!-- Provider detail -->
    <template v-else>
      <div class="flex items-center gap-2">
        <Button variant="ghost" size="sm" @click="selectedId = null">
          <ArrowLeftIcon class="size-3.5" />
          Back to providers
        </Button>
      </div>

      <header class="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 class="text-[15px] font-medium">{{ selected.label }}</h1>
          <p class="label-micro mt-0.5">
            {{ selected.connectionCount }} connection{{ selected.connectionCount === 1 ? '' : 's' }}
          </p>
        </div>
        <div class="flex gap-2">
          <Button
            v-if="selected.connectionCount > 0"
            variant="outline"
            size="sm"
            @click="testAll(selected.id)"
          >
            <RefreshCwIcon class="size-3.5" />
            Test one by one
          </Button>
          <Button v-if="selected.supportsOAuth" size="sm" @click="connecting = true">
            <PlusIcon class="size-3.5" />
            Add account
          </Button>

        </div>
      </header>

      <Alert>
        <TriangleAlertIcon />
        <AlertDescription>{{ RISK_NOTICE }}</AlertDescription>
      </Alert>

      <section class="rounded-lg border border-border bg-card" aria-labelledby="accounts-heading">
        <header class="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 id="accounts-heading" class="text-[13px] font-medium">Accounts</h2>
          <span class="label-micro">rotation order</span>
        </header>

        <ul v-if="selected.connections.length" class="divide-y divide-border">
          <li
            v-for="(connection, index) in selected.connections"
            :key="connection.id"
            class="flex items-start gap-3 px-4 py-3"
          >
            <span class="label-micro w-4 shrink-0 pt-0.5" data-numeric>{{ index + 1 }}</span>

            <div class="min-w-0 flex-1">
              <p class="truncate font-mono text-xs">{{ accountName(connection) }}</p>
              <p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="flex items-center gap-1.5">
                  <span
                    class="size-1.5 rounded-full"
                    :class="{
                      'bg-signal-ok': statusOf(connection).tone === 'ok',
                      'bg-signal-hold': statusOf(connection).tone === 'warn',
                      'bg-signal-fail': statusOf(connection).tone === 'fail',
                      'bg-muted-foreground': statusOf(connection).tone === 'muted',
                    }"
                    aria-hidden="true"
                  />
                  <span class="label-micro">{{ statusOf(connection).text }}</span>
                </span>
                <span class="label-micro">{{ connection.authType }}</span>
                <span
                  v-if="testResults[connection.id]"
                  class="font-mono text-[10px]"
                  :class="testResults[connection.id].ok ? 'text-signal-ok' : 'text-signal-fail'"
                >
                  {{ testResults[connection.id].ok ? 'test ok' : 'test failed' }}
                </span>
              </p>
              <p
                v-if="connection.lastError"
                class="mt-1 truncate font-mono text-[10px] text-signal-fail"
                :title="connection.lastError"
              >
                {{ connection.lastError }}
              </p>
            </div>

            <div class="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                :disabled="index === 0"
                :aria-label="`Move ${accountName(connection)} up`"
                @click="move(selected.id, connection.id, -1)"
              >
                <span aria-hidden="true" class="text-xs">↑</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                :disabled="index === selected.connections.length - 1"
                :aria-label="`Move ${accountName(connection)} down`"
                @click="move(selected.id, connection.id, 1)"
              >
                <span aria-hidden="true" class="text-xs">↓</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                :disabled="testing.has(connection.id)"
                @click="test(connection.id)"
              >
                <Spinner v-if="testing.has(connection.id)" />
                <template v-else>Test</template>
              </Button>
              <Toggle
                :model-value="connection.enabled"
                size="sm"
                :aria-label="`${connection.enabled ? 'Disable' : 'Enable'} ${accountName(connection)}`"
                @update:model-value="(value) => setEnabled(connection.id, Boolean(value))"
              >
                {{ connection.enabled ? 'On' : 'Off' }}
              </Toggle>
              <Button
                variant="ghost"
                size="icon"
                :aria-label="`Remove ${accountName(connection)}`"
                @click="remove(connection.id)"
              >
                <Trash2Icon class="size-3.5" />
              </Button>
            </div>
          </li>
        </ul>

        <Empty v-else class="py-10">
          <EmptyHeader>
            <EmptyTitle>No accounts yet</EmptyTitle>
            <EmptyDescription>
              <template v-if="selected.supportsOAuth">
                Add one to sign in through your browser. Each account carries its own quota, and
                requests rotate between them.
              </template>
              <template v-else>
                This provider has no sign-in flow here yet.
              </template>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
      <ProviderModels :provider-id="selected.id" />
    </template>

    <ConnectProviderDialog
      v-if="connecting && selected?.signIn === 'google-oauth'"
      :provider-label="selected.label"
      @connected="onConnected"
      @cancel="connecting = false"
    />
    <ConnectKiroDialog
      v-if="connecting && selected?.signIn === 'kiro-methods'"
      @connected="onConnected"
      @cancel="connecting = false"
    />
  </div>
</template>
