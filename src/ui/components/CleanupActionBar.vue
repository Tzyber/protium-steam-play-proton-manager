<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import { trashDeleteBlockedText } from "../stores/cleanupHelpers";
import { useCleanupStore } from "../stores/cleanupStore";
import { useConfirmStore } from "../stores/confirmStore";

const props = defineProps<{
  tab: "shaders" | "prefixes" | "trash";
  selectedCount: number;
  selectedSize: string;
  totalTabCount: number;
  hasShaders: boolean;
  busy: boolean;
  deleteBlockedHere: boolean;
  trashSelectedCount: number;
  trashSelectedSize: string;
  trashDeleting: boolean;
}>();

const emit = defineEmits<{
  "delete-shaders-all": [];
  "confirm-delete-orphans": [];
  "delete-trash": [all: boolean];
}>();

const cleanup = useCleanupStore();
const confirm = useConfirmStore();

const destructiveBusy = computed(() => props.busy || confirm.reserved || confirm.busy);

/** Sperrtext des Papierkorbs. Bewusst eine Funktion und kein computed: der Text
 *  wird bei jedem render neu übersetzt, damit ein Sprachwechsel den stehenden
 *  Sperrfakt mitnimmt (FR-1). Übersetzt wird nur in `cleanupHelpers`. */
const trashBlockedText = () => trashDeleteBlockedText(cleanup.trashDeleteBlocked);
</script>

<template>
  <!-- footer: außerhalb der scroll-fläche, deshalb immer am unteren rand und
       nie über einer listenzeile. bezieht sich nur auf den sichtbaren tab. -->
  <div v-if="tab !== 'trash' && selectedCount + totalTabCount > 0" class="actionbar">
    <span class="sel-info" aria-live="polite" data-testid="orphan-selected-info">
      {{ t("cleanup.selectedInfo", { n: selectedCount, size: selectedSize }) }}
    </span>
    <div class="actionbar-btns">
      <button
        v-if="tab === 'shaders' && hasShaders"
        class="action"
        type="button"
        :disabled="destructiveBusy || deleteBlockedHere"
        @click="emit('delete-shaders-all')"
      >
        {{ t("cleanup.cleanAllShaders") }}
      </button>
      <button
        class="action danger"
        type="button"
        :disabled="destructiveBusy || deleteBlockedHere || !selectedCount"
        @click="emit('confirm-delete-orphans')"
      >
        {{ t("cleanup.deleteSelected", { n: selectedCount }) }}
      </button>
    </div>
  </div>

  <div v-if="tab === 'trash' && cleanup.trash.length" class="actionbar">
    <span class="sel-info" aria-live="polite" data-testid="trash-selected-info">
      {{ t("cleanup.selectedInfo", { n: trashSelectedCount, size: trashSelectedSize }) }}
    </span>
    <span
      v-if="cleanup.trashDeleteBlocked"
      class="hint"
      role="alert"
      data-testid="trash-delete-blocked"
    >
      {{ trashBlockedText() }}
    </span>
    <div class="actionbar-btns">
      <button
        class="action"
        type="button"
        :disabled="!trashSelectedCount || trashDeleting || confirm.reserved || confirm.busy || cleanup.trashDeleteBlocked"
        :title="trashBlockedText() ?? undefined"
        @click="emit('delete-trash', false)"
      >
        {{ t("cleanup.trashDeleteEntry") }}
      </button>
      <button
        class="action danger"
        type="button"
        :disabled="!cleanup.trash.length || trashDeleting || confirm.reserved || confirm.busy || cleanup.trashDeleteBlocked"
        :title="trashBlockedText() ?? undefined"
        @click="emit('delete-trash', true)"
      >
        {{ t("cleanup.trashEmpty") }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* footer der view: liegt außerhalb der scroll-fläche, also immer unten und
   niemals über einer listenzeile. vorher war das position:sticky mit negativem
   margin, dadurch verdeckte die leiste die letzte zeile, die dann nicht mehr
   abwählbar war. */
.actionbar {
  flex: 0 0 auto;
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  margin: 0; padding: var(--space-3) var(--view-pad);
  background: var(--bg-1);
  border-top: 1px solid var(--line);
}
.sel-info { font-size: var(--text-md); color: var(--fg-1); }
/* der sperrgrund steht in der leiste, nicht als block über der liste */
.actionbar .hint { color: var(--warning-text); font-family: var(--font-body); font-size: var(--text-md); margin-bottom: 0; padding: 0; }
.actionbar-btns { display: flex; gap: var(--space-3); }

.action {
  background: var(--signal); color: var(--on-signal); border: none;
  border-radius: var(--r-sm); padding: var(--space-3) var(--space-4);
  font-family: var(--font-body); font-weight: 600; font-size: var(--text-md); cursor: pointer;
}
.action:hover:not(:disabled) { background: var(--signal-bright); }
.action:disabled { opacity: 0.4; cursor: default; }
.action:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.action.danger {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger-fg);
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
}
.action.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger-hover) 30%, transparent); }
</style>
