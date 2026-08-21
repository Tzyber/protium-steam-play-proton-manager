import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Cache, EnvironmentSnapshot, Http, HttpResponse } from "../../src/core/ports.js";
import { nodeFs } from "./fakeSteam";

export const SCAN_FIXTURE_GAME_COUNT = 500;
export const SCAN_FIXTURE_HEADER_COUNT = 250;
export const SCAN_FIXTURE_FIRST_APP_ID = 10_000_000;
export const SCAN_FIXTURE_HTTP_DELAY_MS = 5;

export type ScanPerformanceScenario = "cold" | "warm" | "offline";

export interface ScanPerformanceFixture {
  root: string;
  environment: EnvironmentSnapshot;
  appIds: readonly number[];
  headerAppIds: readonly number[];
  localConfigText: string;
  cleanup: () => Promise<void>;
}

export interface CountedHttp {
  http: Http;
  urls: string[];
}

export interface MemoryCache {
  cache: Cache;
  values: Map<string, string>;
}

const manifest = (appId: number, index: number): string => `"AppState"
{
\t"appid"\t\t"${appId}"
\t"name"\t\t"Scan fixture game ${index + 1}"
\t"StateFlags"\t\t"4"
\t"SizeOnDisk"\t\t"${index + 1}000"
}
`;

const LIBRARY_FOLDERS = (root: string): string => `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"${root}"
\t}
}
`;

const CONFIG_VDF = `"InstallConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"CompatToolMapping"
\t\t\t\t{
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

const LOCAL_CONFIG_VDF = `"UserLocalConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"Apps"
\t\t\t\t{
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

export async function buildScanPerformanceFixture(): Promise<ScanPerformanceFixture> {
  const tempRoot = await mkdtemp(join(tmpdir(), "protium-scan-"));
  const root = join(tempRoot, "Steam");
  const appsDir = join(root, "steamapps");
  const configDir = join(root, "config");
  const userConfigDir = join(root, "userdata", "1", "config");
  const cacheDir = join(root, "appcache", "librarycache");
  const appIds = Array.from(
    { length: SCAN_FIXTURE_GAME_COUNT },
    (_, index) => SCAN_FIXTURE_FIRST_APP_ID + index,
  );
  const headerAppIds = appIds.slice(0, SCAN_FIXTURE_HEADER_COUNT);

  try {
    await Promise.all([
      mkdir(appsDir, { recursive: true }),
      mkdir(configDir, { recursive: true }),
      mkdir(userConfigDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(appsDir, "libraryfolders.vdf"), LIBRARY_FOLDERS(root), "utf8"),
      writeFile(join(configDir, "config.vdf"), CONFIG_VDF, "utf8"),
      writeFile(join(userConfigDir, "localconfig.vdf"), LOCAL_CONFIG_VDF, "utf8"),
    ]);

    await Promise.all(
      appIds.map((appId, index) =>
        writeFile(join(appsDir, `appmanifest_${appId}.acf`), manifest(appId, index), "utf8"),
      ),
    );
    await Promise.all(
      headerAppIds.map(async (appId, index) => {
        const hashDir = join(cacheDir, String(appId), `fixture-hash-${index + 1}`);
        await mkdir(hashDir, { recursive: true });
        await writeFile(join(hashDir, "library_header.jpg"), "fixture-cover", "utf8");
      }),
    );
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    environment: {
      generation: 1,
      steamRoot: root,
      libraries: [root],
      systemCompatDirs: [],
      appCacheDir: join(tempRoot, "app-cache"),
      appConfigDir: join(tempRoot, "app-config"),
    },
    appIds,
    headerAppIds,
    localConfigText: await readFile(join(userConfigDir, "localconfig.vdf"), "utf8"),
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
}

export function createScanPerformanceHttp(scenario: ScanPerformanceScenario): CountedHttp {
  const urls: string[] = [];
  const response: HttpResponse = {
    status: 200,
    ok: true,
    text: JSON.stringify({ tier: "gold", confidence: "strong" }),
    headers: {},
  };
  return {
    urls,
    http: {
      async get(url: string) {
        urls.push(url);
        await delay(SCAN_FIXTURE_HTTP_DELAY_MS);
        if (scenario === "offline") throw new Error("fixture network offline");
        return response;
      },
    },
  };
}

export function createScanPerformanceCache(): MemoryCache {
  const values = new Map<string, string>();
  return {
    values,
    cache: {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async set(key: string, value: string) {
        values.set(key, value);
      },
    },
  };
}

export async function warmScanPerformanceCache(
  cache: Cache,
  appIds: readonly number[],
): Promise<void> {
  const fetchedAt = Date.now();
  await Promise.all(
    appIds.map((appId) =>
      cache.set(
        `protondb:${appId}`,
        JSON.stringify({ tier: "gold", confidence: "strong", fetchedAt }),
      ),
    ),
  );
}

export { nodeFs };
