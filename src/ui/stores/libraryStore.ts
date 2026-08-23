import { defineStore } from "pinia";
import type { Tier } from "../../core/types";
import type { SortDir, SortKey } from "../filter";

interface State {
  search: string;
  sortKey: SortKey;
  sortDir: SortDir;
  tiers: Tier[];
  compatTools: string[];
  libraries: string[];
  protonCheck: boolean;
}

// sinnvolle default-richtung je sortierschlüssel
const DEFAULT_DIR: Record<SortKey, SortDir> = { name: "asc", size: "desc", tier: "desc" };

export const useLibraryStore = defineStore("library", {
  state: (): State => ({
    search: "",
    sortKey: "name",
    sortDir: "asc",
    tiers: [],
    compatTools: [],
    libraries: [],
    protonCheck: false,
  }),
  getters: {
    // sets für die pure filter-funktion
    tierSet: (s) => new Set(s.tiers),
    compatToolSet: (s) => new Set(s.compatTools),
    librarySet: (s) => new Set(s.libraries),
    activeFilterCount: (s) =>
      s.tiers.length + s.compatTools.length + s.libraries.length + (s.protonCheck ? 1 : 0),
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
    reset() {
      this.search = "";
      this.tiers = [];
      this.compatTools = [];
      this.libraries = [];
      this.protonCheck = false;
    },
  },
});
