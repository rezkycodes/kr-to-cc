<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { PlusIcon, Trash2Icon, XIcon } from '@lucide/vue';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { useCombos, type Combo } from '../composables/useCombos';

const {
  combos,
  strategies,
  modelsByProvider,
  loading,
  saving,
  error,
  problems,
  load,
  save,
  remove,
} = useCombos();

const name = ref('');
const strategy = ref('failover');
const members = ref<string[]>([]);
const editing = ref<string | null>(null);

const chosenStrategy = computed(() => strategies.value.find((s) => s.id === strategy.value));

/**
 * Member order is meaningful in every strategy, but it means something different
 * in each, so the hint changes with the selection rather than being generic.
 */
const orderNote = computed(() => {
  switch (strategy.value) {
    case 'failover':
      return 'Tried top to bottom.';
    case 'router':
      return 'List cheapest first — heavier requests go further down.';
    case 'load-balance':
      return 'Rotated in order.';
    case 'race':
      return 'All called at once; streaming uses the first.';
    default:
      return '';
  }
});

const canSubmit = computed(() => !saving.value && name.value.trim() !== '' && members.value.length > 0);

function addMember(model: string) {
  if (model && !members.value.includes(model)) members.value.push(model);
}

function removeMember(model: string) {
  members.value = members.value.filter((m) => m !== model);
}

/** Order is load-bearing, so members can be reordered rather than only removed. */
function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= members.value.length) return;
  const next = [...members.value];
  [next[index], next[target]] = [next[target], next[index]];
  members.value = next;
}

function reset() {
  name.value = '';
  strategy.value = 'failover';
  members.value = [];
  editing.value = null;
  problems.value = [];
}

function edit(combo: Combo) {
  name.value = combo.name;
  strategy.value = combo.strategy;
  members.value = combo.members.map((m) => m.model);
  editing.value = combo.name;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function submit() {
  if (await save({ name: name.value, strategy: strategy.value, members: members.value }, editing.value ?? undefined)) {
    reset();
  }
}

onMounted(load);
</script>

<template>
  <!-- Two columns: the editor stays put while the list scrolls, since building a
       combo means repeatedly consulting what already exists. -->
  <div class="grid gap-4 lg:grid-cols-[1fr_1.15fr]">
    <!-- Editor -->
    <section class="rounded-lg border border-border bg-card lg:sticky lg:top-20 lg:self-start" aria-labelledby="editor-heading">
      <header class="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 id="editor-heading" class="text-[13px] font-medium">
          {{ editing ? 'Edit combo' : 'New combo' }}
        </h2>
        <span v-if="editing" class="label-micro font-mono">{{ editing }}</span>
      </header>

      <div class="px-4 py-4">
        <Alert v-if="error" variant="destructive" class="mb-4">
          <AlertDescription>
            {{ problems.length > 1 ? 'This combo cannot be saved:' : error }}
            <ul v-if="problems.length > 1" class="mt-1 list-disc pl-4">
              <li v-for="problem in problems" :key="problem">{{ problem }}</li>
            </ul>
          </AlertDescription>
        </Alert>

        <FieldGroup>
          <Field>
            <FieldLabel for="combo-name">Name</FieldLabel>
            <Input id="combo-name" v-model="name" placeholder="fast" autocomplete="off" spellcheck="false" />
            <FieldDescription>
              Lowercase letters, digits, and hyphens. Cannot reuse a model or provider name.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel for="combo-strategy">Strategy</FieldLabel>
            <Select v-model="strategy">
              <SelectTrigger id="combo-strategy">
                <SelectValue placeholder="Choose a strategy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in strategies" :key="option.id" :value="option.id">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription v-if="chosenStrategy">
              {{ chosenStrategy.summary }} {{ chosenStrategy.detail }}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel for="combo-add-member">Members</FieldLabel>
            <Select @update:model-value="(value) => addMember(String(value))">
              <SelectTrigger id="combo-add-member">
                <SelectValue placeholder="Add a model" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup v-for="group in modelsByProvider" :key="group.provider">
                  <SelectLabel>{{ group.provider }}</SelectLabel>
                  <SelectItem
                    v-for="model in group.items"
                    :key="model.namespaced_id"
                    :value="model.namespaced_id"
                  >
                    {{ model.namespaced_id }}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>{{ orderNote }}</FieldDescription>
          </Field>

          <ol v-if="members.length" class="flex flex-col gap-1">
            <li
              v-for="(model, index) in members"
              :key="model"
              class="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
            >
              <span class="label-micro w-4 shrink-0" data-numeric>{{ index + 1 }}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ model }}</span>
              <Button
                variant="ghost"
                size="icon"
                :disabled="index === 0"
                :aria-label="`Move ${model} up`"
                @click="move(index, -1)"
              >
                <span aria-hidden="true" class="text-xs">↑</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                :disabled="index === members.length - 1"
                :aria-label="`Move ${model} down`"
                @click="move(index, 1)"
              >
                <span aria-hidden="true" class="text-xs">↓</span>
              </Button>
              <Button variant="ghost" size="icon" :aria-label="`Remove ${model}`" @click="removeMember(model)">
                <XIcon class="size-3.5" />
              </Button>
            </li>
          </ol>

          <div class="flex gap-2">
            <Button :disabled="!canSubmit" @click="submit">
              <Spinner v-if="saving" />
              <PlusIcon v-else class="size-3.5" />
              {{ editing ? 'Save changes' : 'Create combo' }}
            </Button>
            <Button v-if="editing" variant="ghost" @click="reset">Cancel</Button>
          </div>
        </FieldGroup>
      </div>
    </section>

    <!-- Existing combos -->
    <section class="rounded-lg border border-border bg-card" aria-labelledby="list-heading">
      <header class="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 id="list-heading" class="text-[13px] font-medium">Combos</h2>
        <span class="label-micro">{{ combos.length }} defined</span>
      </header>

      <div v-if="loading && combos.length === 0" class="flex flex-col gap-2 px-4 py-4">
        <Skeleton v-for="n in 3" :key="n" class="h-14 w-full" />
      </div>

      <ul v-else-if="combos.length" class="divide-y divide-border">
        <li v-for="combo in combos" :key="combo.name" class="flex items-start gap-3 px-4 py-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <p class="font-mono text-xs text-foreground">{{ combo.name }}</p>
              <span class="label-micro">{{ combo.strategy }}</span>
            </div>
            <ol class="mt-1.5 flex flex-col gap-0.5">
              <li
                v-for="(member, index) in combo.members"
                :key="member.model"
                class="flex items-baseline gap-2 font-mono text-[10px] text-muted-foreground"
              >
                <span data-numeric>{{ index + 1 }}</span>
                <span class="truncate">{{ member.model }}</span>
              </li>
            </ol>
          </div>
          <div class="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" @click="edit(combo)">Edit</Button>
            <Button
              variant="ghost"
              size="icon"
              :aria-label="`Delete combo ${combo.name}`"
              @click="remove(combo.name)"
            >
              <Trash2Icon class="size-3.5" />
            </Button>
          </div>
        </li>
      </ul>

      <Empty v-else class="py-10">
        <EmptyHeader>
          <EmptyTitle>No combos yet</EmptyTitle>
          <EmptyDescription>
            A combo groups models from any provider under one name and appears in the model list, so
            a client can select it without knowing it is a group.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  </div>
</template>
