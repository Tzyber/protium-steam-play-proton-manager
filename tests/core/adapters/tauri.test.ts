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
import { openPrefixFolder, tauriPorts } from "../../../src/core/adapters/tauri";

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
