<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { CheckIcon, CopyIcon } from '@lucide/vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { useProviderSignIn } from '../composables/useConnections';

const props = defineProps<{ providerLabel: string }>();
const emit = defineEmits<{ connected: []; cancel: [] }>();

const { authUrl, waiting, error, submitting, begin, complete, reset } = useProviderSignIn();
const pasted = ref('');
const copied = ref(false);

/**
 * The popup reports back when it can. When it cannot — blocked, or a different
 * browser profile — the manual path below is the way through, which is why it is
 * always visible rather than revealed after a failure.
 */
function onMessage(event: MessageEvent) {
  if (event.data?.source !== 'kiro-proxy-oauth') return;
  if (event.data.ok) emit('connected');
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

async function submit() {
  if (await complete(pasted.value)) {
    pasted.value = '';
    emit('connected');
  }
}

onMounted(() => {
  window.addEventListener('message', onMessage);
  begin();
});

onUnmounted(() => {
  window.removeEventListener('message', onMessage);
  reset();
});
</script>

<template>
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="connect-heading"
  >
    <div class="w-full max-w-md rounded-lg border border-border bg-card shadow-lg">
      <header class="border-b border-border px-4 py-3">
        <h2 id="connect-heading" class="text-[13px] font-medium">
          Connect {{ props.providerLabel }}
        </h2>
      </header>

      <div class="flex flex-col gap-4 px-4 py-4">
        <div
          v-if="waiting"
          class="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
        >
          <Spinner />
          Waiting for the popup to finish authorization…
        </div>

        <Alert v-if="error" variant="destructive">
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>

        <div class="flex items-center gap-3">
          <Separator class="flex-1" />
          <span class="label-micro whitespace-nowrap">or paste the callback URL</span>
          <Separator class="flex-1" />
        </div>

        <Field>
          <FieldLabel for="auth-url">Step 1 — open this URL in your browser</FieldLabel>
          <div class="flex gap-2">
            <Input
              id="auth-url"
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
          <FieldLabel for="callback-url">Step 2 — paste the URL you land on</FieldLabel>
          <Input
            id="callback-url"
            v-model="pasted"
            placeholder="http://127.0.0.1:4000/oauth/google/callback?code=…"
            class="font-mono text-[11px]"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter="submit"
          />
          <FieldDescription>
            After approving access, copy the full address from your browser — even if the page shows
            an error.
          </FieldDescription>
        </Field>

        <div class="flex justify-end gap-2">
          <Button variant="ghost" @click="emit('cancel')">Cancel</Button>
          <Button :disabled="submitting || pasted.trim() === ''" @click="submit">
            <Spinner v-if="submitting" />
            Connect
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
