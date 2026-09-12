// @vitest-environment happy-dom
// Das Composable hat genau einen Aufrufer (Drawer), aber eigene Logik: sechs
// Fehlercodes werden auf i18n-Keys abgebildet, `disabledReason` leitet sich aus
// Scan-Status und Startoptionen ab, und eine überholte Anfrage darf ihr
// Ergebnis nicht eintragen. Genau das prüft diese Datei direkt.

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, type Ref, ref } from "vue";
import type { Game } from "../../src/core/types";

const { mockOpenPrefixFolder } = vi.hoisted(() => ({
  mockOpenPrefixFolder: vi.fn<(library: string, appId: number) => Promise<void>>(async () => {}),
}));

vi.mock("../../src/core/adapters/tauri", () => ({
  openPrefixFolder: mockOpenPrefixFolder,
}));

import { setLocale, t } from "../../src/ui/i18n";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { usePrefixOpen } from "../../src/ui/usePrefixOpen";
import { game as makeGame, scanResult } from "../support/factories";

function game(overrides: Partial<Game> = {}): Game {
  return makeGame({ appId: 42, library: "/library", ...overrides });
}

beforeEach(() => {
  setActivePinia(createPinia());
  setLocale("de");
  mockOpenPrefixFolder.mockReset();
  mockOpenPrefixFolder.mockResolvedValue();
});

describe("usePrefixOpen, disabledReason", () => {
  it("sperrt ohne scan-ergebnis und während des scans", () => {
    const g = ref(game()) as Ref<Game | null>;
    const { disabledReason } = usePrefixOpen(g, ref(false));
    expect(disabledReason.value).toBe("drawer.prefixScanPending");

    const scan = useScanStore();
    scan.status = "scanning";
    scan.result = scanResult({ launchConfigStatus: "available" });
    expect(disabledReason.value).toBe("drawer.prefixScanPending");
  });

  it("sperrt während eines laufenden speichervorgangs", () => {
    const scan = useScanStore();
    scan.status = "done";
    scan.result = scanResult({ launchConfigStatus: "available" });

    const { disabledReason } = usePrefixOpen(ref<Game | null>(game()), ref(true));
    expect(disabledReason.value).toBe("drawer.prefixSaving");
  });

  it("sperrt bei nicht verfügbarer startoptionen-quelle", () => {
    const scan = useScanStore();
    scan.status = "done";
    scan.result = scanResult({ launchConfigStatus: "unreadable" });

    const { disabledReason } = usePrefixOpen(ref(game()) as Ref<Game | null>, ref(false));
    expect(disabledReason.value).toBe("drawer.prefixUnchecked");
  });

  it("sperrt bei externem compatdata-pfad in den startoptionen", () => {
    const scan = useScanStore();
    scan.status = "done";
    scan.result = scanResult({ launchConfigStatus: "available" });

    const g = ref(
      game({ launchOptions: "STEAM_COMPAT_DATA_PATH=/mnt/other/prefix %command%" }),
    ) as Ref<Game | null>;
    const { disabledReason } = usePrefixOpen(g, ref(false));
    expect(disabledReason.value).toBe("drawer.prefixExternal");
  });

  it("gibt frei, wenn quelle, scan und startoptionen stimmen", () => {
    const scan = useScanStore();
    scan.status = "done";
    scan.result = scanResult({ launchConfigStatus: "available" });

    const { disabledReason } = usePrefixOpen(ref(game()) as Ref<Game | null>, ref(false));
    expect(disabledReason.value).toBeNull();
  });
});

describe("usePrefixOpen, open", () => {
  function ready(): { g: Ref<Game | null> } {
    const scan = useScanStore();
    scan.status = "done";
    scan.result = scanResult({ launchConfigStatus: "available" });
    return { g: ref(game()) as Ref<Game | null> };
  }

  it("öffnet den prefix-ordner des sichtbaren spiels und meldet geöffnet", async () => {
    const { g } = ready();
    const { state, errorKey, open } = usePrefixOpen(g, ref(false));

    await open();

    expect(mockOpenPrefixFolder).toHaveBeenCalledWith("/library", 42);
    expect(state.value).toBe("opened");
    expect(errorKey.value).toBe("drawer.prefixBlocked");
  });

  it("tut nichts, wenn der start gesperrt ist", async () => {
    const scan = useScanStore();
    scan.status = "idle";
    scan.result = null;
    const { state, open } = usePrefixOpen(ref(game()) as Ref<Game | null>, ref(false));

    await open();

    expect(mockOpenPrefixFolder).not.toHaveBeenCalled();
    expect(state.value).toBe("idle");
  });

  it.each([
    ["external-target", "drawer.prefixExternal"],
    ["unchecked", "drawer.prefixUnchecked"],
    ["not-found", "drawer.prefixNotFound"],
    ["unreadable", "drawer.prefixUnreadable"],
    // "blocked" ist bewusst derselbe key wie der fallback
    ["blocked", "drawer.prefixBlocked"],
    ["handler-unavailable", "drawer.prefixHandlerUnavailable"],
  ] as const)("bildet den backend-fehler %s auf %s ab", async (code, expected) => {
    const { g } = ready();
    // tauri rejectet mit einem rohen string (kein Error-objekt)
    mockOpenPrefixFolder.mockRejectedValue(code);
    const { state, errorKey, open } = usePrefixOpen(g, ref(false));

    await open();

    expect(state.value).toBe("failed");
    expect(errorKey.value).toBe(expected);
    // der key muss ein echter i18n-text sein, kein platzhalter
    expect(t(errorKey.value)).not.toBe(errorKey.value);
  });

  it("fällt bei unbekanntem fehlertext auf die generische meldung zurück", async () => {
    const { g } = ready();
    mockOpenPrefixFolder.mockRejectedValue("irgendwas anderes");
    const { state, errorKey, open } = usePrefixOpen(g, ref(false));

    await open();

    expect(state.value).toBe("failed");
    expect(errorKey.value).toBe("drawer.prefixBlocked");
  });

  it("verwirft das ergebnis einer überholten anfrage", async () => {
    const { g } = ready();
    let reject: (reason?: unknown) => void = () => undefined;
    mockOpenPrefixFolder.mockImplementation(
      () =>
        new Promise<void>((_resolve, rejectFn) => {
          reject = rejectFn;
        }),
    );
    const { state, open } = usePrefixOpen(g, ref(false));

    const pending = open();
    expect(state.value).toBe("opening");
    // spielwechsel während der anfrage: die antwort gehört nicht mehr hierher
    g.value = game({ appId: 43 });
    await nextTick();
    reject("not-found");
    await pending;

    expect(state.value).toBe("idle");
  });

  it("ignoriert einen zweiten start, solange der erste läuft", async () => {
    const { g } = ready();
    let resolve: () => void = () => undefined;
    mockOpenPrefixFolder.mockImplementation(
      () =>
        new Promise<void>((resolveFn) => {
          resolve = resolveFn;
        }),
    );
    const { open } = usePrefixOpen(g, ref(false));

    const first = open();
    await open();
    expect(mockOpenPrefixFolder).toHaveBeenCalledTimes(1);

    resolve();
    await first;
  });
});
