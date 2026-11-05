import { defineStore } from "pinia";
import type { SortDir, SortKey } from "../../core/filter";
import type { CompatToolSource, Tier } from "../../core/types";

interface State {
  search: string;
  sortKey: SortKey;
  sortDir: SortDir;
  tiers: Tier[];
  compatTools: string[];
  libraries: string[];
  compatSource: CompatToolSource | null;
  protonCheck: boolean;
}

// sinnvolle default-richtung je sortierschlüssel
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  size: "desc",
  tier: "desc",
  lastPlayed: "desc",
};

export const useLibraryStore = defineStore("library", {
  state: (): State => ({
    search: "",
    sortKey: "name",
    sortDir: "asc",
    tiers: [],
    compatTools: [],
    libraries: [],
    compatSource: null,
    protonCheck: false,
  }),
  getters: {
    // sets für die pure filter-funktion
    tierSet: (s) => new Set(s.tiers),
    compatToolSet: (s) => new Set(s.compatTools),
    librarySet: (s) => new Set(s.libraries),
    activeFilterCount: (s) =>
      s.tiers.length +
      s.compatTools.length +
      s.libraries.length +
      (s.compatSource ? 1 : 0) +
      (s.protonCheck ? 1 : 0),
  },
  actions: {
    setSort(key: SortKey) {
      if (this.sortKey === key) {
        this.sortDir = this.sortDir === "asc" ? "desc" : "asc"; // gleicher key → richtung togglen
      } else {
        this.sortKey = key;
        this.sortDir = DEFAULT_DIR[key];
      }
    },
    toggle(kind: "tiers" | "compatTools" | "libraries", value: string) {
      const arr = this[kind] as string[];
      const i = arr.indexOf(value);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(value);
    },
    cycleCompatSource() {
      if (this.compatSource === null) this.compatSource = "unavailable";
      else if (this.compatSource === "unavailable") this.compatSource = "default";
      else this.compatSource = null;
    },
    reset() {
      this.search = "";
      this.tiers = [];
      this.compatTools = [];
      this.libraries = [];
      this.compatSource = null;
      this.protonCheck = false;
    },
    /** nach einem erfolgreichen scan gegen das inventar beschneiden: die chips
     *  der filterleiste entstehen aus dem scan, ein toter wert wäre sonst
     *  aktiv, aber nicht mehr abwählbar. */
    pruneFilters(available: { libraries: readonly string[]; compatTools: readonly string[] }) {
      const libraries = new Set(available.libraries);
      const compatTools = new Set(available.compatTools);
      // filter erhält die reihenfolge der auswahl, alles andere bleibt unberührt.
      this.libraries = this.libraries.filter((value) => libraries.has(value));
      this.compatTools = this.compatTools.filter((value) => compatTools.has(value));
    },
  },
});
