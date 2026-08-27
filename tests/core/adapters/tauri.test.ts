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

import { tauriPorts } from "../../../src/core/adapters/tauri";

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
