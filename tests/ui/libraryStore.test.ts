import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useLibraryStore } from "../../src/ui/stores/libraryStore";

describe("libraryStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("setSort mit neuem key setzt key + default-richtung des keys", () => {
    const lib = useLibraryStore();
    lib.setSort("size");
    expect(lib.sortKey).toBe("size");
    expect(lib.sortDir).toBe("desc"); // größe default: absteigend

    lib.setSort("name");
    expect(lib.sortKey).toBe("name");
    expect(lib.sortDir).toBe("asc"); // name default: aufsteigend

    lib.setSort("tier");
    expect(lib.sortKey).toBe("tier");
    expect(lib.sortDir).toBe("desc");
  });

  it("setSort mit demselben key toggelt die richtung", () => {
    const lib = useLibraryStore();
    expect(lib.sortKey).toBe("name");
    expect(lib.sortDir).toBe("asc");

    lib.setSort("name");
    expect(lib.sortDir).toBe("desc");
    lib.setSort("name");
    expect(lib.sortDir).toBe("asc");
  });

  it("toggle fügt hinzu wenn abwesend, entfernt wenn vorhanden", () => {
    const lib = useLibraryStore();
    lib.toggle("tiers", "gold");
    lib.toggle("tiers", "bronze");
    lib.toggle("compatTools", "GE-Proton10-1");
    lib.toggle("libraries", "/mnt/lib");

    expect(lib.tiers).toEqual(["gold", "bronze"]);
    expect(lib.compatTools).toEqual(["GE-Proton10-1"]);
    expect(lib.libraries).toEqual(["/mnt/lib"]);

    lib.toggle("tiers", "gold");
    expect(lib.tiers).toEqual(["bronze"]);
  });

  it("activeFilterCount zählt alle drei filter-arten", () => {
    const lib = useLibraryStore();
    expect(lib.activeFilterCount).toBe(0);

    lib.toggle("tiers", "gold");
    lib.toggle("compatTools", "proton-experimental");
    lib.toggle("libraries", "/home");
    lib.toggle("libraries", "/mnt");
    expect(lib.activeFilterCount).toBe(4);
  });

  it("set-getter spiegeln die arrays als Set", () => {
    const lib = useLibraryStore();
    lib.toggle("tiers", "platinum");
    expect(lib.tierSet.has("platinum")).toBe(true);
    expect(lib.compatToolSet.size).toBe(0);
    expect(lib.librarySet.size).toBe(0);
  });

  it("reset leert suche + filter, lässt die sortierung unangetastet", () => {
    const lib = useLibraryStore();
    lib.search = "witcher";
    lib.setSort("size");
    lib.toggle("tiers", "gold");
    lib.toggle("compatTools", "GE-Proton10-1");
    lib.toggle("libraries", "/mnt");

    lib.reset();

    expect(lib.search).toBe("");
    expect(lib.tiers).toEqual([]);
    expect(lib.compatTools).toEqual([]);
    expect(lib.libraries).toEqual([]);
    expect(lib.activeFilterCount).toBe(0);
    // sortierung ist ansichts-präferenz, kein filter, reset rührt sie nicht an
    expect(lib.sortKey).toBe("size");
    expect(lib.sortDir).toBe("desc");
  });
});
