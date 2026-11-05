// Audit 4.2: `useSelection` meldet „alle ausgewählt", sobald alle kandidaten
// gewählt sind, löschte beim abwählen aber nur über `selectable()`. Ein manuell
// gewählter, nicht wählbarer eintrag (z. b. `potentialShortcut`) blieb dadurch
// ausgewählt: der knopf meldete „auswählen", der löschdialog enthielt ihn
// weiter. Diese datei hält die regel fest: hinzufügen nur über die kandidaten,
// entfernen über alle sichtbaren `entries()`.

import { describe, expect, it } from "vitest";
import { useSelection } from "../../src/ui/composables/useSelection";

type Row = { path: string; appId: number };

const rows: Row[] = [
  { path: "/a", appId: 1 },
  { path: "/b", appId: 2 },
  { path: "/c", appId: 3 },
];

/** `/a` und `/b` sind wählbar, `/c` steht für den nicht wählbaren sonderfall. */
function selection() {
  return useSelection<Row>(() => rows, {
    candidates: () => rows.slice(0, 2),
  });
}

describe("useSelection, selectAll", () => {
  it("wählt nur die kandidaten, ein nicht wählbarer eintrag bleibt ungewählt", () => {
    const sel = selection();

    sel.selectAll();

    expect([...sel.selected].sort()).toEqual(["/a", "/b"]);
    expect(sel.selected.has("/c")).toBe(false);
    expect(sel.allSelected).toBe(true);
  });

  it("wählt beim zweiten aufruf auch den manuell gewählten, nicht wählbaren eintrag ab", () => {
    const sel = selection();
    sel.toggle("/c");

    sel.selectAll();

    // alle kandidaten sind gewählt, `/c` bleibt als manuelle wahl bestehen
    expect(sel.allSelected).toBe(true);
    expect(sel.selected.size).toBe(3);

    sel.selectAll();

    // der knopf stand auf „abwählen", also muss alles raus — auch `/c`
    expect(sel.selected.size).toBe(0);
    expect(sel.selectedEntries).toEqual([]);
  });
});

describe("useSelection, selectedEntries", () => {
  it("enthält nur einträge aus entries()", () => {
    const sel = selection();
    // ein pfad, der nicht in `entries()` steht, gehört nicht in die auswahl-liste
    sel.selected.add("/ghost");
    sel.toggle("/a");
    sel.toggle("/c");

    expect(sel.selectedEntries.map((entry) => entry.path)).toEqual(["/a", "/c"]);
    // die objekte kommen aus `entries()` (die gerenderten zeilen), nicht aus einer kopie
    expect(sel.selectedEntries[0]).toBe(rows[0]);
  });
});
