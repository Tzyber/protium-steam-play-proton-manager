// Kontext einer laufenden Auflage und die Invalide-Schaltung daran: beide
// Stellen im Drawer (Speicherbedarf, Support-Bericht) bauten denselben
// feldvergleich, Watch und invalidate von hand. Die Feldliste bleibt beim
// Aufrufer, damit ein neues Feld nicht stillschweigend unvergleichen bleibt.

import { type Ref, watch } from "vue";

/** Vergleicht zwei Kontexte über die aufgezählten Felder. `null` heißt „kein
 *  gültiger Kontext"; genau ein null ist immer ein Wechsel, damit eine alte
 *  Antwort sicher verworfen wird (INV-2). */
export function sameContext<T extends object>(
  fields: readonly (keyof T)[],
): (left: T | null, right: T | null) => boolean {
  return (left, right) => {
    if (left === null || right === null) return left === right;
    return fields.every((field) => left[field] === right[field]);
  };
}

/** Verwirft eine laufende Auflage, sobald sich ihr Kontext fachlich ändert.
 *  `immediate` deckt den Startzustand ab, in dem es noch keinen vorherigen
 *  Kontext gibt (dort wird einmal invalidiert). */
export function watchContext<T>(
  context: Readonly<Ref<T | null>>,
  sameAs: (left: T | null, right: T | null) => boolean,
  invalidate: () => void,
): void {
  watch(
    context,
    (current, previous?: T | null) => {
      if (previous === undefined || !sameAs(current, previous)) invalidate();
    },
    { immediate: true },
  );
}
