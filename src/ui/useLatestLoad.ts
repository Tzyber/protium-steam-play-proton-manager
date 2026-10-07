// Zwei Läufe (Refresh, neuer Mount) dürfen sich nicht überschreiben: nur der
// jüngste trägt Inhalt, Fehler und Ladezustand ein. Der bisherige Inhalt bleibt
// bis zur eigenen Antwort stehen, ein Fehler setzt den Leerwert.

import { type Ref, ref } from "vue";
import { formatError } from "./formatError";

export function useLatestLoad<T>(empty: T, read: () => Promise<T>) {
  const data = ref(empty) as Ref<T>;
  const loading = ref(false);
  const error = ref<string | null>(null);
  let request = 0;

  async function load(): Promise<void> {
    const requestId = ++request;
    loading.value = true;
    error.value = null;
    try {
      const value = await read();
      if (requestId !== request) return;
      data.value = value;
    } catch (e) {
      if (requestId !== request) return;
      data.value = empty;
      error.value = formatError(e);
    } finally {
      if (requestId === request) loading.value = false;
    }
  }

  return { data, loading, error, load };
}
