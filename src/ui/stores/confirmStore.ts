import { defineStore } from "pinia";
import { ref } from "vue";

/** anzeige eines bestätigungsdialogs im hauptfenster (v0.3.1-stil). */
export interface ConfirmRequest {
  title: string;
  message: string;
}

interface ConfirmCallbacks {
  /** läuft nach erfolgreichem bestätigen (enthält das executeDelete). */
  onSuccess?: () => Promise<void> | void;
  /** räumt zustand auf, wenn der nutzer abbricht. */
  onCancel?: () => void;
}

/**
 * der bestätigungsdialog lebt wieder im hauptfenster: die aufrufenden stores
 * bereiten die löschung vor (prepareDelete, backend-autorisiert), der dialog
 * zeigt die folgen, und erst der bestätigungs-klick führt executeDelete aus.
 * bei einem fehler bleibt der dialog offen (retry), der fehler wird angezeigt.
 */
export const useConfirmStore = defineStore("confirm", () => {
  const pending = ref<ConfirmRequest | null>(null);
  const busy = ref(false);
  const error = ref<string | null>(null);
  let callbacks: ConfirmCallbacks = {};

  function ask(request: ConfirmRequest, cb: ConfirmCallbacks = {}) {
    pending.value = request;
    callbacks = cb;
    error.value = null;
  }

  function cancel() {
    pending.value = null;
    callbacks.onCancel?.();
    callbacks = {};
  }

  async function confirm() {
    if (!pending.value) return;
    busy.value = true;
    error.value = null;
    try {
      await callbacks.onSuccess?.();
      pending.value = null;
      callbacks = {};
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  return { pending, busy, error, ask, cancel, confirm };
});
