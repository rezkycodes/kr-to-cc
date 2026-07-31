<script setup lang="ts">
/**
 * Sign in — deliberately the opposite rhythm of the monitor: one narrow column,
 * generous vertical air, one decision at a time. The three methods are ordered by
 * how little work they need, and each is a complete path on its own.
 */
import { onMounted } from 'vue';
import { CheckIcon, RefreshCwIcon } from '@lucide/vue';
import StatusPip from '../components/StatusPip.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useKiroSignIn } from '../composables/useKiroSignIn';

const {
  authenticated,
  sources,
  scanning,
  busy,
  result,
  pendingProvider,
  callbackValue,
  refreshToken,
  refreshStatus,
  scanSources,
  startBrowserSignIn,
  completeBrowserSignIn,
  importSource,
  importRefreshToken,
} = useKiroSignIn();

onMounted(() => {
  void refreshStatus();
  void scanSources();
});

function sourceDetail(expired: boolean | null) {
  if (expired === null) return 'no expiry recorded';
  return expired ? 'expired · will refresh on import' : 'valid';
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-[34rem] flex-col gap-8 pt-10 pb-6 sm:pt-16">
    <header class="flex items-start justify-between gap-4">
      <div>
        <p class="label-micro">Kiro credentials</p>
        <h1 class="mt-2 text-2xl font-medium tracking-tight">Connect an account</h1>
      </div>
      <StatusPip
        :state="authenticated"
        :label="authenticated === null ? 'checking' : authenticated ? 'signed in' : 'not signed in'"
      />
    </header>

    <Alert v-if="result" :variant="result.kind === 'error' ? 'destructive' : 'default'">
      <CheckIcon v-if="result.kind === 'ok'" />
      <AlertDescription>{{ result.message }}</AlertDescription>
    </Alert>

    <!-- 1. Browser -->
    <section class="flex flex-col gap-3" aria-labelledby="browser-heading">
      <h2 id="browser-heading" class="label-micro">Browser</h2>
      <div class="grid gap-2 sm:grid-cols-2">
        <Button
          variant="outline"
          :disabled="busy === 'google'"
          @click="startBrowserSignIn('google')"
        >
          <Spinner v-if="busy === 'google'" data-icon="inline-start" />
          Continue with Google
        </Button>
        <Button
          variant="outline"
          :disabled="busy === 'github'"
          @click="startBrowserSignIn('github')"
        >
          <Spinner v-if="busy === 'github'" data-icon="inline-start" />
          Continue with GitHub
        </Button>
      </div>

      <FieldGroup v-if="pendingProvider" class="rounded-lg border border-border bg-card p-4">
        <Field>
          <FieldLabel for="callback">Callback URL</FieldLabel>
          <Textarea
            id="callback"
            v-model="callbackValue"
            rows="3"
            class="font-mono text-xs"
            placeholder="kiro://kiro.kiroAgent/authenticate-success?code=…"
            spellcheck="false"
          />
          <FieldDescription>
            Paste the URL the {{ pendingProvider }} tab redirected to. It is sent only to this
            process.
          </FieldDescription>
        </Field>
        <Button :disabled="busy === 'callback'" @click="completeBrowserSignIn">
          <Spinner v-if="busy === 'callback'" data-icon="inline-start" />
          Finish sign-in
        </Button>
      </FieldGroup>
    </section>

    <Separator />

    <!-- 2. Credentials already on this machine -->
    <section class="flex flex-col gap-3" aria-labelledby="machine-heading">
      <div class="flex items-center justify-between gap-4">
        <h2 id="machine-heading" class="label-micro">This machine</h2>
        <Button variant="ghost" size="xs" :disabled="scanning" @click="scanSources">
          <RefreshCwIcon data-icon="inline-start" />
          Rescan
        </Button>
      </div>

      <p v-if="scanning" class="font-mono text-xs text-muted-foreground">Scanning…</p>

      <ul v-else-if="sources.length" class="flex flex-col gap-2">
        <li v-for="source in sources" :key="source.id">
          <Button
            variant="outline"
            class="h-auto w-full justify-between gap-3 px-3 py-2.5 text-left"
            :disabled="busy === source.id"
            @click="importSource(source)"
          >
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="truncate text-[13px] font-medium">{{ source.label }}</span>
              <span class="truncate font-mono text-[10px] text-muted-foreground">
                {{ [source.provider, source.authType].filter(Boolean).join(' · ') || 'kiro' }} ·
                {{ sourceDetail(source.expired) }}
              </span>
            </span>
            <Spinner v-if="busy === source.id" />
            <span v-else class="label-micro shrink-0">import</span>
          </Button>
        </li>
      </ul>

      <p v-else class="font-mono text-xs text-muted-foreground">
        No Kiro CLI or IDE credentials found here.
      </p>
    </section>

    <Separator />

    <!-- 3. Manual -->
    <section aria-labelledby="token-heading">
      <FieldGroup>
        <h2 id="token-heading" class="label-micro">Refresh token</h2>
        <Field>
          <FieldLabel for="refresh-token" class="sr-only">Refresh token</FieldLabel>
          <Input
            id="refresh-token"
            v-model="refreshToken"
            type="password"
            autocomplete="off"
            spellcheck="false"
            class="font-mono text-xs"
            placeholder="Paste a Kiro refresh token"
          />
          <FieldDescription>Validated against Kiro before it is stored.</FieldDescription>
        </Field>
        <Button variant="outline" :disabled="busy === 'token'" @click="importRefreshToken">
          <Spinner v-if="busy === 'token'" data-icon="inline-start" />
          Validate and store
        </Button>
      </FieldGroup>
    </section>

    <p class="font-mono text-[10px] leading-relaxed text-muted-foreground">
      Credentials stay in ~/.config/kiro-proxy and refresh automatically.
    </p>
  </div>
</template>
