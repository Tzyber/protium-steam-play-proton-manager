<script setup lang="ts">
import type { SaveState } from "../composables/useGameConfigSave";
import type { ExplainTopic } from "../explain";
import { saveLabel } from "../gameConfig";
import { type Key, t } from "../i18n";
import ExplainInfo from "./ExplainInfo.vue";
import SelectBox from "./SelectBox.vue";

defineProps<{
  appId: number;
  configTopics: ExplainTopic[];
  compatOptions: { value: string; label: string }[];
  compatState: SaveState;
  compatDirty: boolean;
  compatProvenance: string;
  compatToolUnrecognized: boolean;
  launchState: SaveState;
  launchDirty: boolean;
  launchConfigUnavailable: boolean;
  launchHints: string[];
  prefixState: "idle" | "opening" | "opened" | "failed";
  prefixErrorKey: Key;
  prefixDisabledReason: Key | null;
}>();

const compatSelected = defineModel<string>("compatSelected", { required: true });
const launchInput = defineModel<string>("launchInput", { required: true });

const emit = defineEmits<{
  "save-compat": [];
  "save-launch": [];
  "open-prefix": [];
}>();
</script>

<template>
  <div class="divider" />
  <div class="section-label-explained">
    <p class="section-label mono">{{ t("drawer.configuration") }}</p>
    <ExplainInfo
      :label="t('drawer.configuration')"
      :topics="configTopics"
      :context-key="appId"
    />
  </div>

  <div class="field">
    <label class="k" for="compat-tool">{{ t("drawer.compatToolLabel") }}</label>
    <div class="field-row">
      <SelectBox id="compat-tool" v-model="compatSelected" :options="compatOptions" />
      <button
        class="save"
        type="button"
        :disabled="!compatDirty || compatState.kind === 'saving'"
        @click="emit('save-compat')"
      >
        {{ saveLabel(compatState) }}
      </button>
    </div>
    <p class="hint" data-testid="compat-provenance">
      {{ compatProvenance }}
    </p>
    <p v-if="compatToolUnrecognized" class="hint" data-testid="compat-unrecognized">
      {{ t("drawer.compatToolUnrecognized") }}
    </p>
  </div>

  <div class="field">
    <label class="k" for="launch-options">{{ t("drawer.launchOptionsLabel") }}</label>
    <div class="field-row">
      <input
        id="launch-options"
        v-model="launchInput"
        type="text"
        class="control mono"
        :placeholder="t('drawer.launchOptionsPlaceholder')"
        spellcheck="false"
        @keydown.enter="emit('save-launch')"
      />
      <button
        class="save"
        type="button"
        :disabled="!launchDirty || launchState.kind === 'saving'"
        @click="emit('save-launch')"
      >
        {{ saveLabel(launchState) }}
      </button>
    </div>
    <p class="hint">{{ t("drawer.launchOptionsHint") }}</p>
    <p v-if="launchConfigUnavailable" class="hint" data-testid="launch-config-unavailable">
      {{ t("drawer.launchOptionsUnavailable") }}
    </p>
    <ul
      v-if="launchHints.length"
      class="launch-hints"
      data-testid="launch-hints"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <li v-for="hint in launchHints" :key="hint">{{ hint }}</li>
    </ul>
  </div>

  <div class="prefix-actions" :aria-busy="prefixState === 'opening'">
    <button
      class="save"
      data-testid="prefix-open"
      type="button"
      :disabled="prefixDisabledReason !== null || prefixState === 'opening'"
      :aria-describedby="prefixDisabledReason ? 'prefix-disabled-reason' : undefined"
      @click="emit('open-prefix')"
    >
      {{ t(prefixState === 'opening' ? 'drawer.prefixOpening' : 'drawer.prefixOpen') }}
    </button>
    <p v-if="prefixDisabledReason" id="prefix-disabled-reason" class="hint" data-testid="prefix-reason" role="status">{{ t(prefixDisabledReason) }}</p>
    <p v-if="prefixState === 'opened' || prefixState === 'failed'" class="hint" data-testid="prefix-status" :role="prefixState === 'failed' ? 'alert' : 'status'">{{ t(prefixState === 'opened' ? 'drawer.prefixOpened' : prefixErrorKey) }}</p>
  </div>
</template>

<style scoped>
.divider { height: 1px; background: var(--line-soft); margin: var(--space-5) 0 var(--space-4); }

.field { margin-bottom: var(--space-4); }
.field-row { display: flex; gap: var(--space-2); }
.control:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; border-color: var(--signal); }

.launch-hints {
  margin: var(--space-2) var(--space-1) 0;
  padding-left: var(--space-4);
  color: var(--fg-2);
  font-size: var(--text-sm);
  line-height: var(--leading-prose);
}

.prefix-actions { margin-top: var(--space-3); }
</style>
