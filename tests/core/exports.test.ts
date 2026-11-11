// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { LibraryQuery, SortDir, SortKey } from "../../src/core/filter.js";
import * as filter from "../../src/core/filter.js";
import * as geproton from "../../src/core/geproton.js";
import * as guards from "../../src/core/guards.js";
import type { GeInstallParams, HttpResponse, PrepareDeleteRequest } from "../../src/core/ports.js";
import * as shortcuts from "../../src/core/shortcuts.js";
import { readRepoFile } from "../support/themeTokens";

/** 2.4: die exporte der vier module sind symbolweise klassifiziert. Die
 *  runtime-listen sind die klassifikation (namensraum-schlüssel sind
 *  alphabetisch sortiert). Typ-Seams deckt der typ-block unten ab; `vue-tsc`
 *  im gate bricht, sobald ein seam entfällt. */
const RUNTIME_EXPORTS = [
  {
    module: "core/filter",
    names: filter,
    expected: ["TIER_ORDER", "filterAndSortGames", "fuzzyMatch"],
  },
  {
    module: "core/guards",
    names: guards,
    expected: [
      "MAX_APP_ID",
      "NUMERIC_RE",
      "isRecord",
      "isString",
      "isValidAppId",
      "parseSafeAppId",
      "requireArrayOf",
      "validAppId",
      "validNonNegativeInteger",
    ],
  },
  {
    module: "core/shortcuts",
    names: shortcuts,
    expected: [
      "BinVdfError",
      "MAX_BINARY_VDF_DEPTH",
      "SHORTCUT_ID_THRESHOLD",
      "parseBinaryShortcutIds",
      "readAllShortcutAppIds",
    ],
  },
  {
    module: "core/geproton",
    names: geproton,
    expected: ["RELEASES_URL", "fetchReleases", "installRelease"],
  },
];

describe("Export-Klassifikation (2.4)", () => {
  it.each(RUNTIME_EXPORTS)(
    "$module: die exportierte Oberfläche ist symbolweise festgelegt",
    ({ names, expected }) => {
      expect(Object.keys(names).sort()).toEqual(expected);
    },
  );

  it("die Wert-Seams bleiben erreichbar", () => {
    expect(typeof guards.MAX_APP_ID).toBe("number");
    expect(typeof shortcuts.MAX_BINARY_VDF_DEPTH).toBe("number");
    expect(geproton.RELEASES_URL).toContain("api.github.com");
    expect(new shortcuts.BinVdfError("x")).toBeInstanceOf(Error);
    expect(typeof filter.fuzzyMatch).toBe("function");
  });

  it("die beim Sweep entfernten Exporte bleiben intern", () => {
    expect(readRepoFile("src/ui/gameConfig.ts")).not.toContain("export function launchHintText");
    for (const file of [
      "src/ui/stores/cleanupOrphans.ts",
      "src/ui/stores/cleanupTrash.ts",
      "src/ui/stores/protonListeners.ts",
    ]) {
      expect(readRepoFile(file), file).not.toMatch(
        /export interface (OrphanStore|TrashStore|ProtonListenerStore)/,
      );
    }
  });

  it("die Typ-Seams bleiben erreichbar", () => {
    // Der import selbst ist die prüfung; die zuordnung hält die namen in
    // benutzung, damit `biome` sie nicht als unbenutzt entfernt.
    const seams: {
      query?: LibraryQuery;
      sort?: { key?: SortKey; dir?: SortDir };
      http?: HttpResponse;
      prepare?: PrepareDeleteRequest;
      ge?: GeInstallParams;
    } = {};
    expect(seams).toEqual({});
  });

  it("die produktiven filter-exporte bleiben nutzbar", () => {
    expect(filter.TIER_ORDER[0]).toBe("platinum");
    const query: LibraryQuery = {
      search: "",
      sortKey: "name",
      sortDir: "asc",
      tiers: new Set(),
      compatTools: new Set(),
      libraries: new Set(),
    };
    expect(filter.filterAndSortGames([], query)).toEqual([]);
  });
});

describe("keine kopierten Literale in den Test-Seams", () => {
  it("die shortcuts-Mock-Fabrik liest die Schwelle aus dem modul", () => {
    // `vi.mock`-fabriken sind gehoistet; der wert kommt deshalb über
    // `importOriginal` statt über eine abgeschriebene zahl.
    expect(readRepoFile("tests/support/cleanupStoreMocks.ts")).not.toMatch(
      /SHORTCUT_ID_THRESHOLD:\s*\d/,
    );
  });
});
