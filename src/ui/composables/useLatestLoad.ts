// Zwei Läufe (Refresh, neuer Mount) dürfen sich nicht überschreiben: nur der
// jüngste trägt Inhalt, Fehler und Ladezustand ein. Der bisherige Inhalt bleibt
// bis zur eigenen Antwort stehen, ein Fehler setzt den Leerwert.

import { ref, shallowRef } from "vue";
import { formatError } from "../formatError";
import { latest } from "../latest";

// shallowRef: beide aufrufer (HistoryView) ersetzen den ganzen wert, ein tiefes
// proxy auf den listen brächte nur overhead und hätte keinen vertrag.
export function useLatestLoad<T>(empty: T, read: () => Promise<T>) {
  const data = shallowRef<T>(empty);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const guard = latest();

  async function load(): Promise<void> {
    const isCurrent = guard.begin();
    loading.value = true;
    error.value = null;
    try {
      const value = await read();
      if (!isCurrent()) return;
      data.value = value;
    } catch (e) {
      if (!isCurrent()) return;
      data.value = empty;
      error.value = formatError(e);
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  return { data, loading, error, load };
}
