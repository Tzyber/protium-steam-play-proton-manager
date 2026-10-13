// Auswahl-Logik der cleanup-panels (R-05), aus `CleanupView.vue` herausgelöst:
// halte die optionale gemeinsame `selected`-menge und die kandidatenauswahl
// unabhängig von der view prüfbar.

import { computed, reactive } from "vue";
import { toggleInSet } from "../stores/cleanupHelpers";

export function useSelection<T extends { path: string }>(
  entries: () => readonly T[],
  options?: {
    selected?: Set<string>;
    candidates?: (entries: readonly T[]) => readonly T[];
  },
) {
  const picked = options?.selected ?? reactive(new Set<string>());
  const selectable = () => options?.candidates?.(entries()) ?? entries();
  const allSelected = computed(() => {
    const list = selectable();
    return list.length > 0 && list.every((entry) => picked.has(entry.path));
  });
  const selectedEntries = computed(() => entries().filter((entry) => picked.has(entry.path)));
  function toggle(path: string) {
    toggleInSet(picked, path);
  }
  function selectAll() {
    const list = selectable();
    const clear = allSelected.value;
    for (const entry of list) {
      if (clear) picked.delete(entry.path);
      else picked.add(entry.path);
    }
  }
  return reactive({ selected: picked, allSelected, selectedEntries, toggle, selectAll });
}
