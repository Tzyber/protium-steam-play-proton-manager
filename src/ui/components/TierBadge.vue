<script setup lang="ts">
import { computed } from "vue";
import type { Tier } from "../../core/types";
import { t } from "../i18n";
import { tierName, tierTone } from "../tier";

const props = defineProps<{ tier: Tier; confidence?: string }>();

const color = computed(() => tierTone(props.tier));
const name = computed(() => tierName(props.tier));
// Konfidenz sichtbar machen: `title` allein ist für Screenreader und Tastatur
// nicht erreichbar, deshalb zusätzlich als versteckter Text (U-11).
const confidenceText = computed(() =>
  props.confidence ? t("tierBadge.confidence", { confidence: props.confidence }) : null,
);
</script>

<template>
  <span class="tier" :style="{ '--c': color }" :title="confidenceText ?? undefined">
    <span class="dot" aria-hidden="true" />
    {{ name }}<span v-if="confidenceText" class="sr-only">, {{ confidenceText }}</span>
  </span>
</template>

<style scoped>
.tier {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-body);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--c);
  background: rgba(8, 9, 14, 0.82);
  border: 1px solid color-mix(in srgb, var(--c) 65%, transparent);
  padding: 3px 8px 3px 7px;
  border-radius: 999px;
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.55),
    inset 0 0 0 1px rgba(0, 0, 0, 0.35);
  white-space: nowrap;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c);
  box-shadow: 0 0 7px var(--c), 0 0 2px var(--c);
}
</style>
