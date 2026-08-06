<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { PlayIcon } from '@lucide/vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { useProviderModels } from '../composables/useProviderModels';

const props = defineProps<{ providerId: string }>();

const { models, quota, unavailable, loading, error, testing, results, load, test, testAll } =
  useProviderModels();

/** Compact context window: 1048576 reads as 1M. */
function contextLabel(tokens: number | null) {
  if (!tokens) return '—';
  // 1048576 is a hair over 1M; one decimal then a trailing '.0' strip reads as 1M.
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** Accounts holding one shared allowance (Kiro). */
const accountQuotas = computed(() =>
  quota.value?.scope === 'account' ? (quota.value.accounts ?? []) : [],
);

/**
 * Accounts holding a figure per model (Google).
 *
 * Quota lives per account, so the rows have to show one account's numbers at a
 * time. Merging them would invent a total that no single account has.
 */
const modelQuotaAccounts = computed(() =>
  quota.value?.scope === 'model' ? (quota.value.accounts ?? []) : [],
);

/** Which account's per-model figures the rows show. */
const selectedAccountId = ref<string | null>(null);

// Default to the first account that can actually report, so the rows are not
// blank just because account #1 has a revoked login.
watch(modelQuotaAccounts, (accounts) => {
  if (selectedAccountId.value && accounts.some((a) => a.connectionId === selectedAccountId.value)) {
    return;
  }
  const reporting = accounts.find((a) => Object.keys(a.models ?? {}).length > 0);
  selectedAccountId.value = (reporting ?? accounts[0])?.connectionId ?? null;
});

const selectedAccount = computed(
  () => modelQuotaAccounts.value.find((a) => a.connectionId === selectedAccountId.value) ?? null,
);

/** This model's remaining fraction for the selected account, if reported. */
function modelQuota(modelId: string) {
  return selectedAccount.value?.models?.[modelId] ?? null;
}

function quotaTone(fraction: number | null) {
  if (fraction == null) return 'text-muted-foreground';
  if (fraction <= 0) return 'text-signal-fail';
  if (fraction < 0.2) return 'text-signal-hold';
  return 'text-signal-ok';
}

onMounted(() => load(props.providerId));
watch(() => props.providerId, (id) => load(id));
</script>

<template>
  <section class="rounded-lg border border-border bg-card" aria-labelledby="models-heading">
    <header class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
      <h2 id="models-heading" class="text-[13px] font-medium">Models</h2>
      <div class="flex items-center gap-2">
        <span class="label-micro">{{ models.length }} available</span>
        <Button
          v-if="models.length"
          variant="outline"
          size="sm"
          :disabled="testing.size > 0"
          @click="testAll(props.providerId)"
        >
          <Spinner v-if="testing.size > 0" />
          <PlayIcon v-else class="size-3.5" />
          Test all
        </Button>
      </div>
    </header>

    <div class="flex flex-col gap-3 px-4 py-3">
      <Alert v-if="error" variant="destructive">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <Alert v-if="unavailable">
        <AlertDescription>{{ unavailable }}</AlertDescription>
      </Alert>

      <!--
        Account-level allowance, for a provider that meters the whole account
        rather than each model. Shown once, above the list, so it cannot be
        mistaken for a per-model figure.
      -->
      <div
        v-for="account in accountQuotas"
        :key="account.connectionId"
        class="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="truncate font-mono text-xs">{{ account.label }}</span>
          <span class="label-micro">
            {{ account.plan || 'plan unknown'
            }}{{ account.resetAt ? ` · resets ${account.resetAt.slice(0, 10)}` : '' }}
          </span>
        </div>
        <p v-if="account.error" class="font-mono text-[10px] text-signal-fail">
          {{ account.error }}
        </p>
        <div v-for="q in account.quotas ?? []" :key="q.resource" class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between gap-2 font-mono text-xs">
            <span class="text-muted-foreground">{{ q.label }}</span>
            <span :class="quotaTone(q.remainingFraction)" data-numeric>
              {{ q.used }} / {{ q.total }}{{ q.unit ? ` ${q.unit.toLowerCase()}` : '' }}
            </span>
          </div>
          <!-- A bar makes "nothing left" obvious at a glance. -->
          <div class="h-1 overflow-hidden rounded-full bg-border">
            <div
              class="h-full rounded-full"
              :class="{
                'bg-signal-fail': (q.remainingFraction ?? 0) <= 0,
                'bg-signal-hold': (q.remainingFraction ?? 0) > 0 && (q.remainingFraction ?? 0) < 0.2,
                'bg-signal-ok': (q.remainingFraction ?? 0) >= 0.2,
              }"
              :style="{ width: `${Math.round((1 - (q.remainingFraction ?? 0)) * 100)}%` }"
            />
          </div>
        </div>
      </div>

      <p
        v-if="accountQuotas.length && quota?.note"
        class="text-[10px] leading-relaxed text-muted-foreground"
      >
        {{ quota.note }}
      </p>

      <!--
        Google case: quota is per model, but each account has its own set. One
        account's figures are shown at a time, chosen here.
      -->
      <div v-else-if="modelQuotaAccounts.length" class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="account in modelQuotaAccounts"
            :key="account.connectionId"
            type="button"
            class="rounded-md border px-2 py-1 font-mono text-[10px] transition-colors"
            :class="
              account.connectionId === selectedAccountId
                ? 'border-foreground/30 bg-accent text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground'
            "
            :aria-pressed="account.connectionId === selectedAccountId"
            @click="selectedAccountId = account.connectionId"
          >
            {{ account.label }}
            <span v-if="account.plan" class="text-muted-foreground"> · {{ account.plan }}</span>
            <span v-if="Object.keys(account.models ?? {}).length === 0" class="text-signal-fail">
              · no data
            </span>
          </button>
        </div>
        <p v-if="selectedAccount?.error" class="font-mono text-[10px] text-signal-fail">
          {{ selectedAccount.error }}
        </p>
        <p v-if="quota?.note" class="text-[10px] leading-relaxed text-muted-foreground">
          {{ quota.note }}
        </p>
      </div>

      <Alert v-if="quota?.error" variant="destructive">
        <AlertDescription>{{ quota.error }}</AlertDescription>
      </Alert>

      <div v-if="loading && models.length === 0" class="flex flex-col gap-2">
        <Skeleton v-for="n in 5" :key="n" class="h-10 w-full" />
      </div>

      <ul v-else-if="models.length" class="divide-y divide-border">
        <li v-for="model in models" :key="model.id" class="flex items-center gap-3 py-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <span class="truncate font-mono text-xs">{{ model.id }}</span>
              <span v-if="model.thinking" class="label-micro">thinking</span>
              <span v-if="model.status !== 'active'" class="label-micro">{{ model.status }}</span>
            </div>
            <p class="mt-0.5 flex flex-wrap items-baseline gap-x-3 font-mono text-[10px] text-muted-foreground">
              <span data-numeric>ctx {{ contextLabel(model.contextWindow) }}</span>
              <span v-if="model.costMultiplier != null" data-numeric>
                {{ model.costMultiplier }}x
              </span>
              <span
                v-if="modelQuota(model.id)"
                :class="quotaTone(modelQuota(model.id)!.remainingFraction)"
                data-numeric
              >
                {{ (modelQuota(model.id)!.remainingFraction * 100).toFixed(0) }}% left
              </span>
              <span
                v-if="results[model.id]"
                :class="results[model.id].ok ? 'text-signal-ok' : 'text-signal-fail'"
              >
                {{
                  results[model.id].ok
                    ? `ok · ${results[model.id].durationMs}ms${
                        results[model.id].reply ? ` · "${results[model.id].reply}"` : ''
                      }`
                    : results[model.id].error
                }}
              </span>
            </p>
          </div>

          <Button
            variant="ghost"
            size="sm"
            :disabled="testing.has(model.id)"
            :aria-label="`Test ${model.id}`"
            @click="test(props.providerId, model.id)"
          >
            <Spinner v-if="testing.has(model.id)" />
            <template v-else>Test</template>
          </Button>
        </li>
      </ul>

      <Empty v-else-if="!loading && !unavailable" class="py-8">
        <EmptyHeader>
          <EmptyTitle>No models</EmptyTitle>
          <EmptyDescription>This provider reported no models.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  </section>
</template>
