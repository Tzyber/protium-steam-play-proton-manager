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
  const selectedEntries = computed(() => entries().filter((entry) => picked.has(entry.path)));
  const allSelected = computed(() => {
    const list = selectable();
    return list.length > 0
      ? list.every((entry) => picked.has(entry.path))
      : selectedEntries.value.length > 0;
  });
  function toggle(path: string) {
    toggleInSet(picked, path);
  }
  function selectAll() {
    // abwählen muss über alle sichtbaren zeilen laufen: ein manuell gewählter,
    // nicht wählbarer eintrag bliebe sonst ausgewählt, während der knopf schon
    // „auswählen" meldet (audit 4.2). hinzufügen bleibt auf die kandidaten begrenzt.
    if (allSelected.value) {
      for (const entry of entries()) picked.delete(entry.path);
      return;
    }
    for (const entry of selectable()) picked.add(entry.path);
  }
  return reactive({ selected: picked, allSelected, selectedEntries, toggle, selectAll });
}
