<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  ArrowLeftIcon,
  BracesIcon,
  Building2Icon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  GlobeIcon,
  KeyIcon,
  ShieldIcon,
  UploadIcon,
} from '@lucide/vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

const emit = defineEmits<{ connected: []; cancel: [] }>();

interface Method {
  id: string;
  title: string;
  description: string;
  icon: string;
  available: boolean;
  unavailableReason?: string;
}

const ICONS: Record<string, unknown> = {
  download: DownloadIcon,
  globe: GlobeIcon,
  upload: UploadIcon,
  braces: BracesIcon,
  shield: ShieldIcon,
  building: Building2Icon,
  key: KeyIcon,
};

const methods = ref<Method[]>([]);
const chosen = ref<Method | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

/** Local logins this machine already has. */
const localSources = ref<{ id: string; label: string }[]>([]);

/** Social sign-in state. */
const authUrl = ref<string | null>(null);
const copied = ref(false);

/** Form inputs, one per method. */
const callbackUrl = ref('');
const refreshToken = ref('');
const cliproxyJson = ref('');

const heading = computed(() => (chosen.value ? chosen.value.title : 'Connect Kiro'));

async function loadMethods() {
  try {
    const response = await fetch('/oauth/kiro/connect/methods');
    methods.value = (await response.json()).methods ?? [];
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function choose(method: Method) {
  if (!method.available) return;
  chosen.value = method;
  error.value = null;

  if (method.id === 'local') {
    busy.value = true;
    try {
      const response = await fetch('/oauth/kiro/connect/local');
      localSources.value = (await response.json()).sources ?? [];
    } finally {
      busy.value = false;
    }
  }

  if (method.id === 'social') {
    busy.value = true;
    try {
      const response = await fetch('/oauth/kiro/connect/social/start');
      const data = await response.json();
      authUrl.value = data.authUrl;
      window.open(data.authUrl, 'kiro-signin', 'width=520,height=680');
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy.value = false;
    }
  }
}

function back() {
  chosen.value = null;
  error.value = null;
  authUrl.value = null;
  callbackUrl.value = '';
  refreshToken.value = '';
  cliproxyJson.value = '';
}

/** POST a method's payload and report the first problem clearly. */
async function submit(path: string, body: Record<string, unknown>) {
  busy.value = true;
  error.value = null;
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      error.value = data?.error?.message ?? `Failed (HTTP ${response.status})`;
      return;
    }
    emit('connected');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function copyUrl() {
  if (!authUrl.value) return;
  try {
    await navigator.clipboard.writeText(authUrl.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard can be denied; the field is selectable either way.
  }
}

onMounted(loadMethods);
</script>

<template>
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="kiro-connect-heading"
  >
    <div class="flex max-h-[90vh] w-full max-w-md flex-col rounded-lg border border-border bg-card shadow-lg">
      <header class="flex items-center gap-2 border-b border-border px-4 py-3">
        <Button v-if="chosen" variant="ghost" size="icon" aria-label="Back to methods" @click="back">
          <ArrowLeftIcon class="size-3.5" />
        </Button>
        <h2 id="kiro-connect-heading" class="text-[13px] font-medium">{{ heading }}</h2>
      </header>

      <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        <Alert v-if="error" variant="destructive">
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>

        <!-- Method picker -->
        <template v-if="!chosen">
          <p class="text-xs text-muted-foreground">Choose your authentication method:</p>

          <button
            v-for="method in methods"
            :key="method.id"
            type="button"
            :disabled="!method.available"
            class="flex items-start gap-3 rounded-md border border-border px-3 py-2.5 text-left transition-colors enabled:hover:border-muted-foreground/40 disabled:opacity-55"
            @click="choose(method)"
          >
            <component :is="ICONS[method.icon]" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0">
              <span class="flex items-baseline gap-2">
                <span class="text-[13px] font-medium">{{ method.title }}</span>
                <span v-if="!method.available" class="label-micro">unavailable</span>
              </span>
              <span class="mt-0.5 block text-xs text-muted-foreground">
                {{ method.available ? method.description : method.unavailableReason }}
              </span>
            </span>
          </button>
        </template>

        <!-- Import from this machine -->
        <template v-else-if="chosen.id === 'local'">
          <Spinner v-if="busy" />
          <template v-else-if="localSources.length">
            <p class="text-xs text-muted-foreground">
              Found {{ localSources.length }} login on this machine.
            </p>
            <ul class="flex flex-col gap-1">
              <li
                v-for="source in localSources"
                :key="source.id"
                class="rounded-md border border-border px-3 py-2 font-mono text-xs"
              >
                {{ source.label }}
              </li>
            </ul>
            <Button :disabled="busy" @click="submit('/oauth/kiro/connect/local', {})">
              <Spinner v-if="busy" />
              Import {{ localSources.length === 1 ? 'it' : 'all' }}
            </Button>
          </template>
          <p v-else class="text-xs text-muted-foreground">
            No Kiro login found here. Sign in to the Kiro CLI or IDE first, or use another method.
          </p>
        </template>

        <!-- Google / GitHub -->
        <template v-else-if="chosen.id === 'social'">
          <div class="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
            <Spinner />
            Waiting for the popup to finish authorization…
          </div>

          <div class="flex items-center gap-3">
            <Separator class="flex-1" />
            <span class="label-micro whitespace-nowrap">or paste the callback URL</span>
            <Separator class="flex-1" />
          </div>

          <Field>
            <FieldLabel for="kiro-auth-url">Step 1 — open this URL</FieldLabel>
            <div class="flex gap-2">
              <Input
                id="kiro-auth-url"
                :model-value="authUrl ?? ''"
                readonly
                class="font-mono text-[11px]"
                @focus="(event: FocusEvent) => (event.target as HTMLInputElement).select()"
              />
              <Button variant="outline" size="icon" aria-label="Copy the sign-in URL" @click="copyUrl">
                <CheckIcon v-if="copied" class="size-3.5 text-signal-ok" />
                <CopyIcon v-else class="size-3.5" />
              </Button>
            </div>
          </Field>

          <Field>
            <FieldLabel for="kiro-callback">Step 2 — paste the URL you land on</FieldLabel>
            <Input
              id="kiro-callback"
              v-model="callbackUrl"
              class="font-mono text-[11px]"
              autocomplete="off"
              spellcheck="false"
            />
          </Field>

          <Button
            :disabled="busy || callbackUrl.trim() === ''"
            @click="submit('/oauth/kiro/connect/social/complete', { callbackUrl })"
          >
            <Spinner v-if="busy" />
            Connect
          </Button>
        </template>

        <!-- Import a refresh token -->
        <template v-else-if="chosen.id === 'token'">
          <Field>
            <FieldLabel for="kiro-token">Refresh token</FieldLabel>
            <Textarea
              id="kiro-token"
              v-model="refreshToken"
              rows="4"
              class="font-mono text-[11px]"
              spellcheck="false"
            />
            <FieldDescription>
              From the Kiro IDE. It is checked against Kiro before being saved, so a bad paste fails
              here rather than on your next request.
            </FieldDescription>
          </Field>
          <Button
            :disabled="busy || refreshToken.trim() === ''"
            @click="submit('/oauth/kiro/connect/token', { refreshToken })"
          >
            <Spinner v-if="busy" />
            Connect
          </Button>
        </template>

        <!-- CLIProxyAPI JSON -->
        <template v-else-if="chosen.id === 'cliproxy'">
          <Field>
            <FieldLabel for="kiro-cliproxy">Auth JSON</FieldLabel>
            <Textarea
              id="kiro-cliproxy"
              v-model="cliproxyJson"
              rows="8"
              class="font-mono text-[11px]"
              spellcheck="false"
              placeholder='{ "external_idp": { "refresh_token": "…" } }'
            />
            <FieldDescription>
              Paste the whole file, including <code>external_idp</code>.
            </FieldDescription>
          </Field>
          <Button
            :disabled="busy || cliproxyJson.trim() === ''"
            @click="submit('/oauth/kiro/connect/cliproxy', { json: cliproxyJson })"
          >
            <Spinner v-if="busy" />
            Connect
          </Button>
        </template>
      </div>

      <footer class="flex justify-end border-t border-border px-4 py-3">
        <Button variant="ghost" @click="emit('cancel')">Cancel</Button>
      </footer>
    </div>
  </div>
</template>
