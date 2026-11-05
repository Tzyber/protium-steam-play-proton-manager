import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import type { ScanResult } from "../../src/core/types";
import { setLocale } from "../../src/ui/i18n";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { game, scanResult } from "../support/factories";

// applyGameConfig und coverage fassen den store direkt an: sie setzen
// `store.result` selbst und lesen nur abgeleitete werte. kein lauf braucht den
// scan-adapter oder die protondb-nachlauf-mocks aus scanStore.test.ts, deshalb
// steht diese datei ohne `vi.mock` da.
function fakeResult(): ScanResult {
  return scanResult({ games: [game()] });
}

describe("scanStore.applyGameConfig", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
  });

  it("schreibt launchOptions + compatTool ins passende spiel", () => {
    const store = useScanStore();
    store.result = fakeResult();

    store.applyGameConfig(42, { launchOptions: "-novid", compatTool: "GE-Proton10-1" });

    const g = store.result.games[0] as (typeof store.result.games)[number];
    expect(g.launchOptions).toBe("-novid");
    expect(g.compatTool).toBe("GE-Proton10-1");
  });

  it("compatTool-wechsel rechnet usedBy der tools neu", () => {
    const store = useScanStore();
    store.result = fakeResult();
    store.result.compatToolsInstalled = [
      {
        name: "GE-Proton9-27",
        internalName: "GE-Proton9-27",
        displayName: "GE-Proton9-27",
        sizeBytes: 0,
        usedBy: [42],
        source: "user",
      },
      {
        name: "GE-Proton10-1",
        internalName: "GE-Proton10-1",
        displayName: "GE-Proton10-1",
        sizeBytes: 0,
        usedBy: [],
        source: "user",
      },
    ];

    store.applyGameConfig(42, { compatTool: "GE-Proton10-1" });

    expect(store.result.games[0]?.compatTool).toBe("GE-Proton10-1");
    expect(store.result.compatToolsInstalled[0]?.usedBy).toEqual([]);
    expect(store.result.compatToolsInstalled[1]?.usedBy).toEqual([42]);
  });

  it("mapping-entfernen (default) nimmt das spiel aus usedBy", () => {
    const store = useScanStore();
    store.result = fakeResult();
    store.result.compatToolsInstalled = [
      {
        name: "GE-Proton9-27",
        internalName: "GE-Proton9-27",
        displayName: "GE-Proton9-27",
        sizeBytes: 0,
        usedBy: [42],
        source: "user",
      },
    ];

    store.applyGameConfig(42, { compatTool: "default" });

    expect(store.result.compatToolsInstalled[0]?.usedBy).toEqual([]);
  });

  it("unbekannte appId: kein throw, kein write", () => {
    const store = useScanStore();
    store.result = fakeResult();

    expect(() => store.applyGameConfig(999, { compatTool: "x" })).not.toThrow();
    expect(store.result.games[0]?.compatTool).toBe("default");
  });

  it("ohne scan-ergebnis: kein throw", () => {
    const store = useScanStore();
    expect(() => store.applyGameConfig(42, { compatTool: "x" })).not.toThrow();
  });
});

describe("scanStore.coverage", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("en");
  });

  it("leitet coverage nur für ein abgeschlossenes lokales resultat ab", () => {
    const store = useScanStore();
    store.result = fakeResult();

    store.status = "scanning";
    expect(store.coverage).toBeNull();
    store.status = "error";
    expect(store.coverage).toBeNull();
    store.status = "done";
    expect(store.coverage?.state).toBe("complete");
  });

  it("ändert coverage nicht durch den ProtonDB-reststatus", () => {
    const store = useScanStore();
    store.result = fakeResult();
    store.status = "done";
    const before = store.coverage;

    store.protonDbRemaining = 1;
    expect(store.coverage).toEqual(before);
    store.protonDbRemaining = 0;
    expect(store.coverage).toEqual(before);
  });
});
