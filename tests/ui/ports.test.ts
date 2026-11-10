import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() =>
  vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(
    async () => undefined,
  ),
);
const mockGetVersion = vi.hoisted(() => vi.fn(async () => "0.11.5"));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mockGetVersion }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: {},
  exists: vi.fn(),
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

import * as adapter from "../../src/core/adapters/tauri";
import { ports } from "../../src/ui/ports";

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  mockGetVersion.mockReset();
  mockGetVersion.mockResolvedValue("0.11.5");
});

describe("Composition-Root der UI", () => {
  it("reicht genau die Adapter-Ports durch", () => {
    expect(ports).toBe(adapter.tauriPorts);
  });

  it("lässt neben tauriPorts keinen zweiten Aufrufpfad im Adapter", () => {
    expect(Object.keys(adapter).sort()).toEqual(["parseEnvironmentSnapshot", "tauriPorts"]);
  });
});

interface IpcCase {
  method: string;
  call: () => Promise<unknown>;
  command: string;
  args?: Record<string, unknown>;
  expected?: unknown;
}

// P10a/FR-1: die neun bisherigen freien Funktionen sind System-Methoden.
const ipcCases: IpcCase[] = [
  {
    method: "openExternal",
    call: () => ports.system.openExternal("https://example.com/spiel"),
    command: "open_external",
    args: { url: "https://example.com/spiel" },
  },
  {
    method: "launchGame",
    call: () => ports.system.launchGame(570),
    command: "open_external",
    args: { url: "steam://rungameid/570" },
  },
  {
    method: "openPrefixFolder",
    call: () => ports.system.openPrefixFolder("/library", 620),
    command: "open_prefix_folder",
    args: { library: "/library", appId: 620 },
  },
  {
    method: "listConfigBackups",
    call: () => ports.system.listConfigBackups(),
    command: "list_config_backups",
    expected: [],
  },
  {
    method: "openBackupsFolder",
    call: () => ports.system.openBackupsFolder(),
    command: "open_backups_folder",
  },
  {
    method: "logDiagnostic",
    call: () => ports.system.logDiagnostic("warn", "Testwarnung"),
    command: "log_diagnostic",
    args: { level: "warn", message: "Testwarnung" },
  },
  {
    method: "readLogTail",
    call: () => ports.system.readLogTail(),
    command: "read_log_tail",
    expected: "zeile",
  },
  {
    method: "openLogsFolder",
    call: () => ports.system.openLogsFolder(),
    command: "open_logs_folder",
  },
];

describe("System-Ports der UI", () => {
  it.each(ipcCases)(
    "$method ruft $command über ports.system",
    async ({ call, command, args, expected }) => {
      if (expected !== undefined) mockInvoke.mockResolvedValueOnce(expected);
      const result = await call();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      if (expected !== undefined) expect(result).toBe(expected);
      if (args === undefined) {
        expect(mockInvoke).toHaveBeenCalledExactlyOnceWith(command);
        return;
      }
      expect(mockInvoke).toHaveBeenCalledExactlyOnceWith(command, args);
    },
  );

  it("appVersion kommt aus der app-version des backends", async () => {
    await expect(ports.system.appVersion()).resolves.toBe("0.11.5");
    expect(mockGetVersion).toHaveBeenCalledTimes(1);
  });
});
