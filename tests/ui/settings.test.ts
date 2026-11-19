// @vitest-environment happy-dom

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoad = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const mockSave = vi.hoisted(() => vi.fn<(value: string) => Promise<void>>());
const mockLogDiagnostic = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("../../src/core/adapters/tauri", () => ({
  tauriPorts: {
    settings: {
      load: mockLoad,
      save: mockSave,
    },
    system: {
      logDiagnostic: mockLogDiagnostic,
    },
  },
}));

import { getLocale, setLocale } from "../../src/ui/i18n";
import { initAppSettings, parseSettings, serializeSettings } from "../../src/ui/settings";
import { useLibraryStore } from "../../src/ui/stores/libraryStore";
import { useUiStore } from "../../src/ui/stores/uiStore";

beforeEach(() => {
  setLocale("en");
  mockLoad.mockReset();
  mockSave.mockReset();
  mockLogDiagnostic.mockReset();
  mockLoad.mockResolvedValue(null);
  mockSave.mockResolvedValue(undefined);
  mockLogDiagnostic.mockResolvedValue(undefined);
});

afterEach(() => {
  setLocale("en");
});

describe("settings: parseSettings", () => {
  it("parst ein vollständiges gültiges objekt", () => {
    const raw = JSON.stringify({
      language: "de",
      view: "proton",
      sortKey: "size",
      sortDir: "desc",
    });

    expect(parseSettings(raw)).toEqual({
      language: "de",
      view: "proton",
      sortKey: "size",
      sortDir: "desc",
    });
  });

  it("übernimmt nur vorhandene gültige felder und verwirft ungültige einzeln", () => {
    const raw = JSON.stringify({
      language: "fr",
      view: "cleanup",
      sortKey: "bogus",
      sortDir: "desc",
    });

    expect(parseSettings(raw)).toEqual({
      view: "cleanup",
      sortDir: "desc",
    });
  });

  it("ignoriert unbekannte zusätzliche felder", () => {
    const raw = JSON.stringify({
      language: "en",
      view: "history",
      futureFlag: true,
      nested: { a: 1 },
    });

    expect(parseSettings(raw)).toEqual({
      language: "en",
      view: "history",
    });
  });

  it("akzeptiert ein leeres json-objekt ohne felder", () => {
    expect(parseSettings("{}")).toEqual({});
  });

  it("meldet leerstring, kaputtes json und nicht-objekte als parse-fehler", () => {
    expect(() => parseSettings("")).toThrow();
    expect(() => parseSettings("{kaputt")).toThrow();
    expect(() => parseSettings("null")).toThrow();
    expect(() => parseSettings("[]")).toThrow();
    expect(() => parseSettings("42")).toThrow();
    expect(() => parseSettings('"de"')).toThrow();
  });
});

describe("settings: serializeSettings", () => {
  it("serialisiert alle vier felder in fester reihenfolge", () => {
    const json = serializeSettings({
      sortDir: "desc",
      sortKey: "tier",
      view: "cleanup",
      language: "de",
    });

    const parsed: Record<string, unknown> = JSON.parse(json);
    expect(Object.keys(parsed)).toEqual(["language", "view", "sortKey", "sortDir"]);
    expect(parseSettings(json)).toEqual({
      language: "de",
      view: "cleanup",
      sortKey: "tier",
      sortDir: "desc",
    });
  });
});

describe("settings: initAppSettings", () => {
  it("lässt bei fehlender datei (null) defaults stehen, schreibt nicht und loggt nicht", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    mockLoad.mockResolvedValueOnce(null);

    await initAppSettings(pinia);

    expect(getLocale()).toBe("en");
    expect(useUiStore(pinia).activeView).toBe("library");
    expect(useLibraryStore(pinia).sortKey).toBe("name");
    expect(useLibraryStore(pinia).sortDir).toBe("asc");
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
  });

  it("wendet gültige gespeicherte werte auf sprache, view und sortierung an", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    mockLoad.mockResolvedValueOnce(
      JSON.stringify({
        language: "de",
        view: "history",
        sortKey: "lastPlayed",
        sortDir: "asc",
      }),
    );

    await initAppSettings(pinia);

    expect(getLocale()).toBe("de");
    expect(document.documentElement.lang).toBe("de");
    expect(useUiStore(pinia).activeView).toBe("history");
    expect(useLibraryStore(pinia).sortKey).toBe("lastPlayed");
    expect(useLibraryStore(pinia).sortDir).toBe("asc");
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
  });

  it("wendet bei sortKey ohne sortDir die DEFAULT_DIR-regel über restoreSort an", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    mockLoad.mockResolvedValueOnce(JSON.stringify({ sortKey: "size" }));

    await initAppSettings(pinia);

    expect(useLibraryStore(pinia).sortKey).toBe("size");
    expect(useLibraryStore(pinia).sortDir).toBe("desc");
    expect(useUiStore(pinia).activeView).toBe("library");
    expect(getLocale()).toBe("en");
  });

  it("wendet bei teils ungültigen feldern nur die gültigen an ohne logError", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    mockLoad.mockResolvedValueOnce(
      JSON.stringify({ language: "de", view: "invalid", sortDir: "desc" }),
    );

    await initAppSettings(pinia);

    expect(getLocale()).toBe("de");
    expect(useUiStore(pinia).activeView).toBe("library");
    expect(useLibraryStore(pinia).sortKey).toBe("name");
    expect(useLibraryStore(pinia).sortDir).toBe("desc");
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
  });

  it("hält bei leerstring oder defektem json die defaults, loggt via logError und wirft nie", async () => {
    for (const raw of ["", "{defekt", "[]"]) {
      const pinia = createPinia();
      setActivePinia(pinia);
      setLocale("en");
      mockLogDiagnostic.mockClear();
      mockLoad.mockResolvedValueOnce(raw);

      await expect(initAppSettings(pinia)).resolves.toBeUndefined();

      expect(getLocale()).toBe("en");
      expect(useUiStore(pinia).activeView).toBe("library");
      expect(useLibraryStore(pinia).sortKey).toBe("name");
      expect(useLibraryStore(pinia).sortDir).toBe("asc");
      expect(mockLogDiagnostic).toHaveBeenCalledWith("error", expect.any(String));
    }
  });

  it("hält bei load-fehler die defaults, loggt via logError und wirft nie", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    mockLoad.mockRejectedValueOnce(new Error("unreadable"));

    await expect(initAppSettings(pinia)).resolves.toBeUndefined();

    expect(getLocale()).toBe("en");
    expect(useUiStore(pinia).activeView).toBe("library");
    expect(useLibraryStore(pinia).sortKey).toBe("name");
    expect(useLibraryStore(pinia).sortDir).toBe("asc");
    expect(mockLogDiagnostic).toHaveBeenCalledWith("error", expect.stringContaining("unreadable"));
  });
});
