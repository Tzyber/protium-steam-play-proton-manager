<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { t } from "../i18n";
import { useUiStore } from "../stores/uiStore";

const ui = useUiStore();

type CopyState = "idle" | "copied" | "failed";

const copyState = ref<CopyState>("idle");
/** Wie lange das kopier-häkchen stehen bleibt: lang genug zum sehen, kurz
 *  genug, um den knopf nicht dauerhaft als bestätigung zu zeigen. */
const COPY_CONFIRM_MS = 2000;
// nur "copied" läuft über COPY_CONFIRM_MS ab. "failed" hat bewusst keinen
// timer und bleibt bis zur nächsten meldung oder einem erfolgreichen kopieren
// stehen, damit ein fehlschlag nicht unbemerkt verschwindet (U-14).
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
// ein laufender clipboard-write darf nach dem unmount keinen timer mehr
// anlegen: den räumte niemand mehr ab (audit 4.3).
let unmounted = false;

function clearCopiedTimer() {
  if (copiedTimer) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
}

async function copyError() {
  if (!ui.notification) return;
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    clearCopiedTimer();
    copyState.value = "failed";
    return;
  }
  try {
    await clipboard.writeText(ui.notification.message);
    if (unmounted) return;
    copyState.value = "copied";
    clearCopiedTimer();
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      copyState.value = "idle";
    }, COPY_CONFIRM_MS);
  } catch {
    if (unmounted) return;
    // clipboard gesperrt (unsicherer kontext, fehlende berechtigung): sichtbar
    // melden statt den klick stumm zu verwerfen.
    clearCopiedTimer();
    copyState.value = "failed";
  }
}

// eine neue meldung trägt ihren eigenen kopierstatus
watch(
  () => ui.notification,
  () => {
    clearCopiedTimer();
    copyState.value = "idle";
  },
);

// der timer hängt an dieser komponente: ohne aufräumen feuert er nach dem
// unmount weiter und hält den scope am leben (audit 4.3).
onBeforeUnmount(() => {
  unmounted = true;
  clearCopiedTimer();
});
</script>

<template>
  <transition name="toast" mode="out-in">
        <div v-if="ui.notification" :key="ui.notification.message" class="note toast">
          <span class="note-icon" aria-hidden="true">⚠</span>
          <!-- die live-rolle sitzt am text: die knöpfe daneben sind bedienung,
               keine meldung (FR-3, audit 4.18). -->
          <span class="note-msg" role="alert">{{ ui.notification.message }}</span>
          <!-- der knopf kopiert weiterhin: sein name bleibt die aktion, nicht
               der fehlertext. der fehlschlag lebt in der live-region (U-14). -->
          <button
            class="note-copy"
            type="button"
            :aria-label="copyState === 'copied' ? t('app.copied') : t('app.copyError')"
            @click="copyError"
          >
            {{ copyState === "copied" ? "✓" : copyState === "failed" ? "⚠" : "📋" }}
          </button>
          <span v-if="copyState === 'failed'" class="sr-only" role="alert">{{ t("app.copyFailed") }}</span>
          <button class="note-close" type="button" :aria-label="t('app.dismissNotification')" @click="ui.dismissNotification()">✕</button>
        </div>
      </transition>
</template>

<style scoped>
/* app-weite meldung (store-notification, nicht der frühere drawer-toast): oben
   in der NoticeRail, copy-button, kein auto-dismiss im view (der store räumt nach 30s auf) */
.note.toast {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  margin: var(--space-2) var(--space-3) 0;
  background: var(--error-surface);
  border: 1px solid var(--error-border);
  border-radius: var(--r-sm);
  font-family: var(--font-body);
}
.note-icon { color: var(--danger-fg); font-size: var(--text-md); flex-shrink: 0; margin-top: var(--space-1); }
.note-msg { flex: 1; color: var(--fg-0); font-size: var(--text-md); line-height: var(--leading-body); word-break: break-word; }
.note-copy, .note-close {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--text-md);
  padding: 0;
  color: var(--fg-2);
  border-radius: 4px;
  font-family: var(--font-body);
  display: grid;
  place-items: center;
  line-height: 1;
}
.note-copy:hover, .note-close:hover { color: var(--fg-0); background: color-mix(in srgb, var(--fg-1) 10%, transparent); }

.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-6px); }
</style>
