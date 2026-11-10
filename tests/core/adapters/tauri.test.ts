import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: {},
  exists: vi.fn(),
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { exists as fsExists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  openPrefixFolder,
  parseEnvironmentSnapshot,
  tauriPorts,
} from "../../../src/core/adapters/tauri";
import { ProtiumError } from "../../../src/core/errors";

// S-02: kein webview-fetch mehr; url und etag gehen an den rust-command.
describe("http.get", () => {
  it("ruft http_get mit url und ifNoneMatch auf und bildet die antwort ab", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce({ status: 200, text: "{}", etag: 'W/"v2"' });

    const res = await tauriPorts.http.get("https://example.com", { ifNoneMatch: 'W/"v1"' });

    expect(invoke).toHaveBeenCalledExactlyOnceWith("http_get", {
      url: "https://example.com",
      ifNoneMatch: 'W/"v1"',
    });
    expect(res).toEqual({ status: 200, ok: true, text: "{}", headers: { etag: 'W/"v2"' } });
  });

  it("304 ist nicht ok, ohne etag bleiben die header leer", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce({ status: 304, text: "", etag: null });

    const res = await tauriPorts.http.get("https://example.com");

    expect(invoke).toHaveBeenCalledExactlyOnceWith("http_get", {
      url: "https://example.com",
      ifNoneMatch: null,
    });
    expect(res).toEqual({ status: 304, ok: false, text: "", headers: {} });
  });

  it("reicht ipc-fehler durch", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("unavailable: timeout");
    await expect(tauriPorts.http.get("https://example.com")).rejects.toBe("unavailable: timeout");
  });
});

describe("GE-Installation IPC", () => {
  it.each(["de", "en"] as const)("reicht locale %s an install_ge_proton weiter", async (locale) => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce("verified");
    const params = {
      steamRoot: "/steam",
      releaseTag: "GE-Proton10-12",
      downloadUrl: "https://github.com/GloriousEggroll/proton-ge-custom/x.tar.gz",
      downloadId: "dl-1",
      locale,
    };

    await expect(tauriPorts.system.installGeProton(params)).resolves.toBe("verified");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("install_ge_proton", params);
  });
});

describe("Prefix-Öffnen-IPC", () => {
  it("übergibt genau Library und AppID als String, keinen Zielpfad", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await openPrefixFolder("/library", 620);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_prefix_folder", {
      library: "/library",
      appId: "620",
    });
  });
});

describe("Backup-Sichtbarkeit IPC", () => {
  it("listConfigBackups ruft list_config_backups auf", async () => {
    const { listConfigBackups } = await import("../../../src/core/adapters/tauri");
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce([]);
    const res = await listConfigBackups();
    expect(res).toEqual([]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("list_config_backups");
  });

  it("openBackupsFolder ruft open_backups_folder auf", async () => {
    const { openBackupsFolder } = await import("../../../src/core/adapters/tauri");
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await openBackupsFolder();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_backups_folder");
  });
});

describe("Diagnostics IPC", () => {
  it("logDiagnostic ruft log_diagnostic mit Level und Message auf", async () => {
    const { logDiagnostic } = await import("../../../src/core/adapters/tauri");
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await logDiagnostic("warn", "Testwarnung");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("log_diagnostic", {
      level: "warn",
      message: "Testwarnung",
    });
  });

  it("readLogTail ruft read_log_tail auf", async () => {
    const { readLogTail } = await import("../../../src/core/adapters/tauri");
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce("zeile");
    const res = await readLogTail();
    expect(res).toBe("zeile");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("read_log_tail");
  });

  it("openLogsFolder ruft open_logs_folder auf", async () => {
    const { openLogsFolder } = await import("../../../src/core/adapters/tauri");
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await openLogsFolder();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_logs_folder");
  });
});

describe("cache-Dateiname (K-03)", () => {
  beforeEach(() => {
    vi.mocked(mkdir).mockReset();
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(fsExists).mockReset();
    vi.mocked(readTextFile).mockReset();
    vi.mocked(writeTextFile).mockReset();
  });

  it("legt kollidierende Schlüssel in getrennte Dateien und liest sie zurück", async () => {
    // "protondb:1" und "protondb_1" sanitisierten früher auf denselben Namen.
    const files = new Map<string, string>();
    vi.mocked(fsExists).mockImplementation(async (path) => files.has(String(path)));
    vi.mocked(writeTextFile).mockImplementation(async (path, data) => {
      files.set(String(path), String(data));
    });
    vi.mocked(readTextFile).mockImplementation(async (path) => {
      const value = files.get(String(path));
      if (value === undefined) throw new Error("not found");
      return value;
    });

    await tauriPorts.cache.set("protondb:1", "A");
    await tauriPorts.cache.set("protondb_1", "B");

    expect([...files.keys()]).toHaveLength(2);
    expect(await tauriPorts.cache.get("protondb:1")).toBe("A");
    expect(await tauriPorts.cache.get("protondb_1")).toBe("B");
  });

  it("behandelt einen unbekannten (alten) Dateinamen als Miss statt Fehler", async () => {
    vi.mocked(fsExists).mockResolvedValue(false);

    await expect(tauriPorts.cache.get("protondb:1")).resolves.toBeNull();
    await expect(tauriPorts.cache.set("protondb:1", "A")).resolves.toBeUndefined();
  });
});

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generation: 3,
    steamRoot: "/steam",
    libraries: ["/steam", "/games"],
    unavailableLibraries: [],
    systemCompatDirs: ["/usr/share/steam/compatibilitytools.d"],
    ...overrides,
  };
}

/** snapshot ohne das feld `unavailableLibraries` (versionsversatz). */
function withoutUnavailableLibraries(value: unknown): Record<string, unknown> {
  const raw = snapshot({ unavailableLibraries: value });
  if (value === undefined) delete raw.unavailableLibraries;
  return raw;
}

/** genau ein Sentinel auf der wurzel: er meint den ganzen scan, nicht eine
 *  einzelne library (fail-closed, INV-2). */
const SENTINEL = { path: "/steam", reason: "unverified" };

function expectInvalidSnapshot(raw: unknown): void {
  try {
    parseEnvironmentSnapshot(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ProtiumError);
    expect(error).toMatchObject({ kind: "unreadable", code: "invalid-environment-snapshot" });
    return;
  }
  throw new Error("parser hat einen ungültigen environment-snapshot akzeptiert");
}

describe("parseEnvironmentSnapshot", () => {
  it("reicht einen gültigen snapshot unverändert weiter", () => {
    expect(
      parseEnvironmentSnapshot(
        snapshot({ unavailableLibraries: [{ path: "/mnt/fehlt", reason: "path-missing" }] }),
      ),
    ).toEqual({
      generation: 3,
      steamRoot: "/steam",
      libraries: ["/steam", "/games"],
      unavailableLibraries: [{ path: "/mnt/fehlt", reason: "path-missing" }],
      systemCompatDirs: ["/usr/share/steam/compatibilitytools.d"],
    });
  });

  it.each([undefined, null, "fehlt", {}, 7] as const)(
    "ersetzt fehlende/nicht-array unavailableLibraries (%j) durch genau einen Sentinel",
    (value) => {
      const parsed = parseEnvironmentSnapshot(withoutUnavailableLibraries(value));

      expect(parsed.unavailableLibraries).toEqual([SENTINEL]);
    },
  );

  it.each([
    [{ path: 42, reason: "path-missing" }],
    [{ reason: "read-failed" }],
    [null],
    ["/mnt/fehlt"],
    [["/mnt/fehlt"]],
  ])("ersetzt einen kaputten eintrag (%j) durch genau einen Sentinel", (entry) => {
    const parsed = parseEnvironmentSnapshot(
      snapshot({ unavailableLibraries: [{ path: "/mnt/gut", reason: "read-failed" }, entry] }),
    );

    expect(parsed.unavailableLibraries).toEqual([SENTINEL]);
  });

  it.each(["bogus", undefined, 7])(
    "normalisiert einen unbekannten reason (%j) zu unverified",
    (reason) => {
      const parsed = parseEnvironmentSnapshot(
        snapshot({ unavailableLibraries: [{ path: "/mnt/fremd", reason }] }),
      );

      expect(parsed.unavailableLibraries).toEqual([{ path: "/mnt/fremd", reason: "unverified" }]);
    },
  );

  it.each([null, "snapshot", 3, true])("wirft bei einem rohwert ohne record (%j)", (raw) => {
    expectInvalidSnapshot(raw);
  });

  it("wirft bei einem array als rohwert", () => {
    expectInvalidSnapshot([]);
  });

  it.each(["", 42, null, undefined])("wirft bei ungültigem steamRoot (%j)", (steamRoot) => {
    expectInvalidSnapshot(snapshot({ steamRoot }));
  });

  it.each([undefined, "/steam", 7, { 0: "/steam" }])(
    "wirft bei ungültigen libraries (%j)",
    (libraries) => {
      expectInvalidSnapshot(snapshot({ libraries }));
    },
  );

  it("verwirft fremde library-elemente", () => {
    const parsed = parseEnvironmentSnapshot(snapshot({ libraries: ["/steam", 42, null] }));

    expect(parsed.libraries).toEqual(["/steam"]);
  });

  it.each([undefined, -1, 1.5, "3"])("wirft bei ungültiger generation (%j)", (generation) => {
    expectInvalidSnapshot(snapshot({ generation }));
  });

  it("behält generation 0: die INV-7-prüfung bleibt in scanLocal", () => {
    expect(parseEnvironmentSnapshot(snapshot({ generation: 0 })).generation).toBe(0);
  });

  it("behält nur strings in systemCompatDirs", () => {
    expect(
      parseEnvironmentSnapshot(snapshot({ systemCompatDirs: ["/a", 42, null, "/b"] }))
        .systemCompatDirs,
    ).toEqual(["/a", "/b"]);
  });

  it.each([undefined, "/a", 7, {}])(
    "liefert bei ungültigen systemCompatDirs (%j) ein leeres array",
    (systemCompatDirs) => {
      expect(parseEnvironmentSnapshot(snapshot({ systemCompatDirs })).systemCompatDirs).toEqual([]);
    },
  );
});

describe("discoverSteamEnvironment IPC", () => {
  it("validiert die backend-antwort am wire", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce({
      generation: 1,
      steamRoot: "",
      libraries: [],
      systemCompatDirs: [],
    });

    await expect(tauriPorts.system.discoverSteamEnvironment()).rejects.toMatchObject({
      kind: "unreadable",
      code: "invalid-environment-snapshot",
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("discover_steam_environment");
  });

  it("liefert den geparsten snapshot mit sentinel für ein fehlendes feld", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce({
      generation: 1,
      steamRoot: "/steam",
      libraries: ["/steam"],
      systemCompatDirs: [],
    });

    await expect(tauriPorts.system.discoverSteamEnvironment()).resolves.toEqual({
      generation: 1,
      steamRoot: "/steam",
      libraries: ["/steam"],
      unavailableLibraries: [SENTINEL],
      systemCompatDirs: [],
    });
  });
});
