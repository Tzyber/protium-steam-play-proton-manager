import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: mockFetch,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ appCacheDir: vi.fn(async () => "/tmp/cache") }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: {},
  exists: vi.fn(),
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { openPrefixFolder, tauriPorts } from "../../../src/core/adapters/tauri";

describe("http.get", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("liefert antwort inkl. body und headern", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => "{}",
      headers: new Map([["content-type", "application/json"]]),
    });

    const res = await tauriPorts.http.get("https://example.com");

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.text).toBe("{}");
    expect(res.headers["content-type"]).toBe("application/json");
  });

  it("bricht nach timeout ab, wenn der server nie antwortet", async () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // nie auflösen

    const promise = tauriPorts.http.get("https://example.com");
    const assertion = expect(promise).rejects.toThrow("HTTP request timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
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
