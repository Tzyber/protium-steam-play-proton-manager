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
  /** übernimmt einen execute-fehler im aufrufenden store. */
  onError?: (error: unknown) => Promise<void> | void;
}

/**
 * der bestätigungsdialog lebt wieder im hauptfenster: die aufrufenden stores
 * bereiten die löschung vor (prepareDelete, backend-autorisiert), der dialog
 * zeigt die folgen, und erst der bestätigungs-klick führt executeDelete aus.
 * bei einem execute-fehler schließt der dialog; der aufrufende store übernimmt
 * die fehlermeldung und eine neue aktion muss erneut vorbereiten.
 */
export const useConfirmStore = defineStore("confirm", () => {
  const pending = ref<ConfirmRequest | null>(null);
  const busy = ref(false);
  let callbacks: ConfirmCallbacks = {};

  function ask(request: ConfirmRequest, cb: ConfirmCallbacks = {}) {
    if (busy.value) return;
    pending.value = request;
    callbacks = cb;
  }

  function cancel() {
    if (busy.value) return;
    pending.value = null;
    callbacks.onCancel?.();
    callbacks = {};
  }

  async function confirm() {
    if (busy.value || !pending.value) return;
    busy.value = true;
    const { onSuccess, onError } = callbacks;
    try {
      await onSuccess?.();
      pending.value = null;
      callbacks = {};
    } catch (error) {
      pending.value = null;
      callbacks = {};
      await onError?.(error);
    } finally {
      busy.value = false;
    }
  }

  return { pending, busy, ask, cancel, confirm };
});
