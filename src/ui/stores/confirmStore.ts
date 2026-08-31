import { defineStore } from "pinia";
import { computed, ref } from "vue";

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

let nextReservationId = 0;

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
  const reservation = ref<number | null>(null);
  const reserved = computed(() => reservation.value !== null);
  let callbacks: ConfirmCallbacks = {};

  function reserve(): number | null {
    if (busy.value || pending.value || reservation.value !== null) return null;
    nextReservationId += 1;
    reservation.value = nextReservationId;
    return nextReservationId;
  }

  function release(token: number): boolean {
    if (reservation.value !== token) return false;
    reservation.value = null;
    return true;
  }

  function ask(request: ConfirmRequest, cb: ConfirmCallbacks = {}, token?: number): boolean {
    if (busy.value) return false;
    if (pending.value) {
      cb.onCancel?.();
      return false;
    }
    if (token === undefined) {
      if (reservation.value !== null) {
        cb.onCancel?.();
        return false;
      }
      token = reserve() ?? undefined;
    } else if (reservation.value !== token) {
      cb.onCancel?.();
      return false;
    }
    if (token === undefined) {
      cb.onCancel?.();
      return false;
    }
    pending.value = request;
    callbacks = cb;
    return true;
  }

  function cancel() {
    if (busy.value) return;
    const onCancel = callbacks.onCancel;
    pending.value = null;
    callbacks = {};
    reservation.value = null;
    onCancel?.();
  }

  async function confirm() {
    if (busy.value || !pending.value) return;
    busy.value = true;
    const { onSuccess, onError } = callbacks;
    try {
      await onSuccess?.();
    } catch (error) {
      await onError?.(error);
    } finally {
      pending.value = null;
      callbacks = {};
      reservation.value = null;
      busy.value = false;
    }
  }

  return { pending, busy, reserved, ask, reserve, release, cancel, confirm };
});
