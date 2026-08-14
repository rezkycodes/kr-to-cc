<script setup lang="ts">
/**
 * Configure — a third rhythm again: a two-column editor. The left column is the
 * form; the right column is the exact env block that will be merged into
 * ~/.claude/settings.json, so the outcome is visible before saving.
 */
import { computed, onMounted } from 'vue';
import { CheckIcon, CopyIcon, RotateCcwIcon } from '@lucide/vue';
import StatusPip from '../components/StatusPip.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useClaudeConfig } from '../composables/useClaudeConfig';
import type { ClaudeConfigValues } from '../types/api';

const { form, state, loading, saving, result, pointsHere, baseUrlIssue, previewJson, load, restoreDefaults, save, copyPreview } =
  useClaudeConfig();

onMounted(load);

/** Combos, which the server names separately so they can be grouped. */
const comboModels = computed(() => state.value?.combos ?? []);

/** Everything that is not a combo, in catalog order. */
const plainModels = computed(() => {
  const combos = new Set(comboModels.value);
  return (state.value?.models ?? []).filter((id) => !combos.has(id));
});

const ALIASES: { key: keyof ClaudeConfigValues; label: string; role: string }[] = [
  { key: 'opusModel', label: 'Opus', role: 'deep reasoning' },
  { key: 'sonnetModel', label: 'Sonnet', role: 'daily coding' },
  { key: 'haikuModel', label: 'Haiku', role: 'fast tasks' },
  { key: 'subagentModel', label: 'Subagent', role: 'delegated work' },
];

function pick(key: keyof ClaudeConfigValues, value: unknown) {
  if (typeof value === 'string' && value) form[key] = value;
}
</script>

<template>
  <div class="grid gap-6 pt-6 lg:grid-cols-[1fr_minmax(320px,26rem)] lg:gap-10">
    <!-- Editor -->
    <div class="flex flex-col gap-6">
      <header class="flex items-start justify-between gap-4">
        <div>
          <p class="label-micro">Claude Code</p>
          <h1 class="mt-2 text-2xl font-medium tracking-tight">Point Claude at this gateway</h1>
        </div>
        <StatusPip
          :state="loading ? null : pointsHere"
          :label="loading ? 'reading' : pointsHere ? 'connected' : 'not pointing here'"
        />
      </header>

      <Alert v-if="result" :variant="result.kind === 'error' ? 'destructive' : 'default'">
        <CheckIcon v-if="result.kind === 'ok'" />
        <AlertDescription>{{ result.message }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="flex flex-col gap-3">
        <Skeleton class="h-9 w-full" />
        <Skeleton class="h-9 w-2/3" />
        <Skeleton class="h-9 w-full" />
      </div>

      <template v-else>
        <FieldGroup>
          <Field>
            <FieldLabel for="base-url">Endpoint</FieldLabel>
            <Input id="base-url" v-model="form.baseUrl" class="font-mono text-xs" spellcheck="false" />
            <FieldDescription>
              Where Claude Code sends Messages API calls. The origin works too. Defaults to the
              proxy serving this page.
            </FieldDescription>
            <FieldDescription v-if="baseUrlIssue" class="text-signal-fail">
              On disk: {{ baseUrlIssue }} Save to correct it.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel for="auth-token">Proxy key</FieldLabel>
            <Input
              id="auth-token"
              v-model="form.authToken"
              type="password"
              autocomplete="off"
              class="font-mono text-xs"
            />
            <FieldDescription>
              Must match PROXY_API_KEY. Use <code class="font-mono">dummy</code> when the proxy runs
              unauthenticated on loopback.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <Separator />

        <FieldGroup>
          <h2 class="label-micro">Model aliases</h2>
          <div class="grid gap-4 sm:grid-cols-2">
            <Field v-for="alias in ALIASES" :key="alias.key">
              <FieldLabel :for="alias.key">
                {{ alias.label }}
                <span class="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground">
                  {{ alias.role }}
                </span>
              </FieldLabel>
              <div class="flex gap-2">
                <Input
                  :id="alias.key"
                  v-model="form[alias.key]"
                  class="font-mono text-xs"
                  spellcheck="false"
                />
                <Select @update:model-value="(value) => pick(alias.key, value)">
                  <SelectTrigger
                    class="w-9 shrink-0 justify-center px-0 [&>span]:hidden"
                    :aria-label="`Choose a ${alias.label} model from the catalog`"
                  />
                  <!--
                    Anchored with `popper`, not the default `item-aligned`.
                    item-aligned positions the panel by placing the selected item
                    over the trigger's value text; this trigger is an icon-only
                    button with no value and its span hidden, so there is nothing to
                    align against and the panel lands at the viewport's left edge.
                  -->
                  <SelectContent position="popper" align="end" :side-offset="4">
                    <!-- Combos first and labelled: they are few, user-made, and
                         otherwise lost at the end of forty-odd model ids. -->
                    <SelectGroup v-if="comboModels.length">
                      <SelectLabel>Combos</SelectLabel>
                      <SelectItem
                        v-for="model in comboModels"
                        :key="model"
                        :value="model"
                        class="font-mono text-xs"
                      >
                        {{ model }}
                      </SelectItem>
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel v-if="comboModels.length">Models</SelectLabel>
                      <SelectItem
                        v-for="model in plainModels"
                        :key="model"
                        :value="model"
                        class="font-mono text-xs"
                      >
                        {{ model }}
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </Field>
          </div>
        </FieldGroup>

        <div class="flex flex-wrap gap-2">
          <Button :disabled="saving || !form.baseUrl" @click="save">
            <Spinner v-if="saving" data-icon="inline-start" />
            Save to settings.json
          </Button>
          <Button variant="ghost" :disabled="saving" @click="restoreDefaults">
            <RotateCcwIcon data-icon="inline-start" />
            Restore defaults
          </Button>
        </div>
      </template>
    </div>

    <!-- What will be written -->
    <aside class="lg:sticky lg:top-20 lg:self-start" aria-labelledby="preview-heading">
      <div class="overflow-hidden rounded-lg border border-border bg-card">
        <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2 id="preview-heading" class="label-micro">Merged env block</h2>
          <Button variant="ghost" size="xs" @click="copyPreview">
            <CopyIcon data-icon="inline-start" />
            Copy
          </Button>
        </header>
        <pre class="overflow-x-auto px-3 py-3 font-mono text-[11px] leading-relaxed text-foreground"><code>{{ previewJson }}</code></pre>
      </div>

      <dl class="mt-4 flex flex-col gap-2 font-mono text-[10px] text-muted-foreground">
        <div class="flex justify-between gap-3">
          <dt class="label-micro">File</dt>
          <dd class="truncate">{{ state?.settingsPath ?? '—' }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="label-micro">Current</dt>
          <dd class="truncate">{{ state?.current?.baseUrl || 'not set' }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="label-micro">Other keys</dt>
          <dd>preserved · timestamped backup</dd>
        </div>
      </dl>

    </aside>
  </div>
</template>
