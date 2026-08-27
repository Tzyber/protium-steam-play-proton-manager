import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Cache,
  DirEntry,
  EnvironmentSnapshot,
  FileSystem,
  Http,
  HttpResponse,
  PathIdentity,
  System,
} from "../../src/core/ports.js";
import { getVdfValue, removeVdfEntry, setVdfValue } from "../../src/core/vdfpatch.js";

/** größenlimit, das der fake wie das rust-backend (16-MiB-caps) durchsetzt. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export function ensureSizeLimit(size: number): void {
  if (size > MAX_FILE_BYTES) {
    throw new Error(`datei zu groß (${size} bytes), übersprungen`);
  }
}

// ---- Fixture-Inhalte ----

const acf = (appId: number, name: string, flags: number, size: number) => `"AppState"
{
	"appid"		"${appId}"
	"name"		"${name}"
	"StateFlags"		"${flags}"
	"SizeOnDisk"		"${size}"
}
`;

const CONFIG_VDF = `"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"0"
					{
						"name"		"proton-cachyos-slr"
					}
					"620"
					{
						"name"		"GE-Proton9-27"
					}
					"730"
					{
						"name"		"proton-cachyos-slr"
					}
					"999999"
					{
						"name"		"proton-cachyos-slr"
					}
					"2207218128"
					{
						"name"		"proton-cachyos-slr"
					}
				}
			}
		}
	}
}
`;

// 620 hat startoptionen, die anderen spiele nichts (→ undefined im scan)
const LOCALCONFIG_VDF = `"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"Apps"
				{
					"620"
					{
						"LaunchOptions"		"gamemoderun %command%"
					}
				}
			}
		}
	}
}
`;

// steamID64 76561198073717116 = accountID 113451388 (= userdata-ordner), MostRecent
const LOGINUSERS_VDF = `"users"
{
	"76561198073717116"
	{
		"AccountName"		"testaccount"
		"MostRecent"		"1"
	}
}
`;

const toolVdf = (internal: string, display: string) => `"compatibilitytools"
{
	"compat_tools"
	{
		"${internal}"
		{
			"install_path"		"."
			"display_name"		"${display}"
			"from_oslist"		"windows"
			"to_oslist"		"linux"
		}
	}
}
`;

// binary shortcuts.vdf fixture: ein shortcut mit appId 3641016077
// format: TYPE-KEY-VALUE
const SHORTCUT_VDF_BINARY = new Uint8Array([
  0x00,
  ...new TextEncoder().encode("shortcuts"),
  0x00,
  0x00, // type: MAP
  ...new TextEncoder().encode("0"),
  0x00, // entry key
  0x02, // type: int32
  ...new TextEncoder().encode("appid"),
  0x00,
  0x0d,
  0x7f,
  0x05,
  0xd9,
  0x01, // type: string
  ...new TextEncoder().encode("AppName"),
  0x00,
  ...new TextEncoder().encode("Test"),
  0x00,
  0x00, // type: MAP
  ...new TextEncoder().encode("tags"),
  0x00,
  0x01, // type: string
  ...new TextEncoder().encode("0"),
  0x00,
  ...new TextEncoder().encode("favorite"),
  0x00,
  0x08, // end tags
  0x08, // end entry
  0x08, // end root
]);

// trunkierte version: parse muss scheitern → "unreadable"
export const CORRUPT_SHORTCUT_VDF_BINARY = SHORTCUT_VDF_BINARY.slice(0, 10);

/**
 * baut einen fake-steam-baum, der dominiks reales setup abbildet:
 *  - root-library + externer mount (lib2)
 *  - lib2Dup: symlink auf lib2 → muss per identität dedupliziert werden
 *  - staleLib: pfad in libraryfolders.vdf, der nicht existiert (nicht gemountet)
 *  - root compatibilitytools.d: GE + "Proton-CachyOS Latest" (interner name == dir, ungenutzt)
 *  - systemCompat (analog /usr/share/steam/…): "proton-cachyos-slr" (genutzt von 730)
 *  spiele: 570 (root, default), 620 (lib2, GE), 730 (lib2, cachyos-slr),
 *          1493710 (proton exp → gefiltert), 9999 (korrupt → warning)
 */
export async function buildFakeSteam(): Promise<{
  home: string;
  root: string;
  lib2: string;
  lib2Dup: string;
  staleLib: string;
  systemCompat: string;
  userId: string;
  environment: EnvironmentSnapshot;
}> {
  const home = await mkdtemp(join(tmpdir(), "protium-"));
  const root = join(home, ".local/share/Steam");
  const lib2 = join(home, "mnt/games/SteamLibrary");
  const lib2Dup = join(home, "run/media/user/SteamLibrary"); // symlink → lib2
  const staleLib = join(home, "gone/SteamLibrary"); // nie angelegt
  const systemCompat = join(home, "usr/share/steam/compatibilitytools.d");

  await mkdir(join(root, "steamapps"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "compatibilitytools.d/GE-Proton9-27"), { recursive: true });
  await mkdir(join(root, "compatibilitytools.d/Proton-CachyOS Latest"), { recursive: true });
  await mkdir(join(lib2, "steamapps"), { recursive: true });
  await mkdir(join(home, "run/media/user"), { recursive: true });
  // lokaler bild-cache: appcache/librarycache/{appId}/{hash}/library_header.jpg
  const cacheHashDir = join(root, "appcache/librarycache/620/abc123hash");
  await mkdir(cacheHashDir, { recursive: true });
  await writeFile(join(cacheHashDir, "library_header.jpg"), "JPEGDATA");
  await symlink(lib2, lib2Dup, "dir");
  await mkdir(join(systemCompat, "proton-cachyos-slr"), { recursive: true });

  const libraryFolders = `"libraryfolders"
{
	"0" { "path" "${root}" }
	"1" { "path" "${lib2}" }
	"2" { "path" "${lib2Dup}" }
	"3" { "path" "${staleLib}" }
}`.replace(/\{ "path" "([^"]+)" \}/g, '\n\t{\n\t\t"path"\t\t"$1"\n\t}');
  await writeFile(join(root, "steamapps/libraryfolders.vdf"), libraryFolders);

  await writeFile(join(root, "steamapps/appmanifest_570.acf"), acf(570, "Dota 2", 6, 1610612736));
  await writeFile(
    join(root, "steamapps/appmanifest_1493710.acf"),
    acf(1493710, "Proton Experimental", 4, 500000000),
  );
  await writeFile(join(root, "steamapps/appmanifest_9999.acf"), '"AppState" { kaputt ohne close');
  await writeFile(join(root, "config/config.vdf"), CONFIG_VDF);
  await writeFile(
    join(root, "compatibilitytools.d/GE-Proton9-27/compatibilitytool.vdf"),
    toolVdf("GE-Proton9-27", "GE-Proton9-27"),
  );
  await writeFile(
    join(root, "compatibilitytools.d/Proton-CachyOS Latest/compatibilitytool.vdf"),
    toolVdf("Proton-CachyOS Latest", "Proton-CachyOS Latest"),
  );
  await writeFile(
    join(systemCompat, "proton-cachyos-slr/compatibilitytool.vdf"),
    toolVdf("proton-cachyos-slr", "proton-cachyos-11.0 (steam linux runtime)"),
  );

  await writeFile(join(lib2, "steamapps/appmanifest_620.acf"), acf(620, "Portal 2", 4, 12345678));
  await writeFile(
    join(lib2, "steamapps/appmanifest_730.acf"),
    acf(730, "Counter-Strike 2", 6, 98765432),
  );

  // Compatdata und Shadercache für Cleanup-Tests.
  await mkdir(join(root, "steamapps/compatdata/570"), { recursive: true });
  await mkdir(join(root, "steamapps/compatdata/999999"), { recursive: true });
  await mkdir(join(root, "steamapps/compatdata/3641016077"), { recursive: true });
  await mkdir(join(root, "steamapps/compatdata/foo"), { recursive: true });
  await mkdir(join(root, "steamapps/compatdata/0"), { recursive: true });
  await mkdir(join(root, "steamapps/shadercache/570"), { recursive: true });
  await mkdir(join(root, "steamapps/shadercache/888888"), { recursive: true });
  await symlink("/etc", join(root, "steamapps/compatdata/symlink_123"), "dir");
  await writeFile(
    join(root, "steamapps/compatdata/not_a_dir"),
    "sollte nicht als orphan gelistet werden",
  );

  const userId = "113451388";
  await mkdir(join(root, "userdata", userId, "config"), { recursive: true });
  await writeFile(join(root, "userdata", userId, "config", "localconfig.vdf"), LOCALCONFIG_VDF);
  await writeFile(join(root, "config", "loginusers.vdf"), LOGINUSERS_VDF);

  await writeFile(join(root, "userdata", userId, "config", "shortcuts.vdf"), SHORTCUT_VDF_BINARY);

  const environment: EnvironmentSnapshot = {
    generation: 1,
    steamRoot: root,
    libraries: [root, lib2],
    systemCompatDirs: [systemCompat],
    appCacheDir: join(home, "app-cache"),
    appConfigDir: join(home, "app-config"),
  };
  return { home, root, lib2, lib2Dup, staleLib, systemCompat, userId, environment };
}

// ---- port-adapter über node:fs (echtes dir-walking gegen fixtures) ----

export function nodeFs(): FileSystem {
  return {
    async exists(p) {
      try {
        await lstat(p);
        return true;
      } catch {
        return false;
      }
    },
    // Größenprüfung wie im Tauri-Adapter: stat, Limit, Read.
    async readTextFile(p) {
      const st = await stat(p).catch(() => null);
      if (st) ensureSizeLimit(st.size);
      return readFile(p, "utf8");
    },
    async readFile(p) {
      const st = await stat(p).catch(() => null);
      if (st) ensureSizeLimit(st.size);
      return readFile(p);
    },
    async readDir(p) {
      const entries = await readdir(p, { withFileTypes: true });
      return entries.map(
        (e): DirEntry => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isSymlink: e.isSymbolicLink(),
        }),
      );
    },
    realpath: (p) => realpath(p),
    writeTextFile: (p, content) => writeFile(p, content, "utf8"),
    async mkdir(p) {
      await mkdir(p, { recursive: true });
    },
  };
}

/** system-port: pathIdentity via echtem stat; Environment wird vom Test
 *  explizit als Snapshot übergeben. */
export function fakeSystem(opts?: { environment?: EnvironmentSnapshot }): System {
  const environment =
    opts?.environment ??
    ({
      generation: 1,
      steamRoot: "/tmp/steam",
      libraries: ["/tmp/steam"],
      systemCompatDirs: [],
      appCacheDir: "/tmp/protium-cache",
      appConfigDir: "/tmp/protium-config",
    } satisfies EnvironmentSnapshot);
  return {
    async geTargetArch() {
      return "x86_64" as const;
    },
    async discoverSteamEnvironment() {
      return environment;
    },
    async listTrashEntries(library: string) {
      // fixture-fakes kennen keinen papierkorb; findTrashEntries wird separat getestet
      return { dir: `${library}/steamapps/.protium-trash`, present: false, entries: [] };
    },
    async isProcessRunning() {
      return false;
    },
    async dirSize() {
      return 4096;
    },
    async batchDirSizes() {
      return {};
    },
    async pathIdentity(p): Promise<PathIdentity | null> {
      try {
        const rp = await realpath(p);
        const st = await stat(rp);
        return { realpath: rp, dev: String(st.dev), ino: String(st.ino) };
      } catch {
        return null;
      }
    },
    async installGeProton() {
      return "verified";
    },
    async cancelDownload() {},
    async prepareDelete(request) {
      if (request.targetType !== "trash" && (await this.isProcessRunning("steam"))) {
        throw new Error("steam is running, deletion refused");
      }
      return {
        token: `token-${request.path}`,
        expiresAt: Date.now() + 60000,
        targetType: request.targetType,
        targetPath: request.path,
        consequences: [
          {
            path: request.path,
            action: request.targetType === "orphan" ? "trash" : "permanentDelete",
            description: `Delete ${request.targetType}`,
          },
        ],
      };
    },
    async executeDelete(token) {
      const path = token.replace(/^token-/, "");
      try {
        await rm(path, { recursive: true, force: true });
      } catch {}
      return { success: true, deletedPath: path };
    },
    // Bildet das Rust-Write-Gate nach: Steam läuft, Abbruch,
    // fail-closed bei fehlender datei, backup + atomarer temp+rename.
    async saveLaunchOptions(steamRoot, accountId, appId, launchOptions) {
      if (await this.isProcessRunning("steam")) {
        throw new Error("steam is running, write refused");
      }
      const file = `${steamRoot}/userdata/${accountId}/config/localconfig.vdf`;
      try {
        await lstat(file);
      } catch {
        throw new Error("write target canonicalize: not found");
      }
      const original = await readFile(file, "utf8");
      const path = [
        "UserLocalConfigStore",
        "Software",
        "Valve",
        "Steam",
        "Apps",
        String(appId),
        "LaunchOptions",
      ];
      const currentVal = getVdfValue(original, path);
      if (launchOptions.trim() === "") {
        if (currentVal === undefined) return "unchanged";
        const patched = removeVdfEntry(original, path);
        const backup = `${steamRoot}/backups/localconfig-${accountId}-${Date.now()}.vdf`;
        await mkdir(`${steamRoot}/backups`, { recursive: true });
        await writeFile(backup, original, "utf8");
        const tmp = `${file}.protium-tmp`;
        await writeFile(tmp, patched, "utf8");
        await rename(tmp, file);
        return "written";
      }
      if (currentVal === launchOptions) return "unchanged";
      const patched = setVdfValue(original, path, launchOptions);
      const backup = `${steamRoot}/backups/localconfig-${accountId}-${Date.now()}.vdf`;
      await mkdir(`${steamRoot}/backups`, { recursive: true });
      await writeFile(backup, original, "utf8");
      const tmp = `${file}.protium-tmp`;
      await writeFile(tmp, patched, "utf8");
      await rename(tmp, file);
      return "written";
    },
    async saveCompatTool(steamRoot, appId, toolName) {
      if (await this.isProcessRunning("steam")) {
        throw new Error("steam is running, write refused");
      }
      const file = `${steamRoot}/config/config.vdf`;
      try {
        await lstat(file);
      } catch {
        throw new Error("write target canonicalize: not found");
      }
      const original = await readFile(file, "utf8");
      const namePath = [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "CompatToolMapping",
        String(appId),
        "name",
      ];
      const currentName = getVdfValue(original, namePath);
      if (toolName === null || toolName === "default" || toolName === "") {
        if (currentName === undefined) return "unchanged";
        const blockPath = [
          "InstallConfigStore",
          "Software",
          "Valve",
          "Steam",
          "CompatToolMapping",
          String(appId),
        ];
        const patched = removeVdfEntry(original, blockPath);
        const backup = `${steamRoot}/backups/config-${appId}-${Date.now()}.vdf`;
        await mkdir(`${steamRoot}/backups`, { recursive: true });
        await writeFile(backup, original, "utf8");
        const tmp = `${file}.protium-tmp`;
        await writeFile(tmp, patched, "utf8");
        await rename(tmp, file);
        return "written";
      }
      if (currentName === toolName) return "unchanged";
      const basePath = [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "CompatToolMapping",
        String(appId),
      ];
      let p = setVdfValue(original, [...basePath, "name"], toolName);
      p = setVdfValue(p, [...basePath, "config"], "");
      p = setVdfValue(p, [...basePath, "priority"], "250");
      const backup = `${steamRoot}/backups/config-${appId}-${Date.now()}.vdf`;
      await mkdir(`${steamRoot}/backups`, { recursive: true });
      await writeFile(backup, original, "utf8");
      const tmp = `${file}.protium-tmp`;
      await writeFile(tmp, p, "utf8");
      await rename(tmp, file);
      return "written";
    },
  };
}

export function memCache(): Cache {
  const m = new Map<string, string>();
  return {
    async get(k) {
      return m.get(k) ?? null;
    },
    async set(k, v) {
      m.set(k, v);
    },
  };
}

/** http, das eine feste antwort pro url liefert; default 404 → tier unknown. */
export function fakeHttp(routes: Record<string, HttpResponse> = {}): Http {
  return {
    async get(url: string) {
      return routes[url] ?? { status: 404, ok: false, text: "", headers: {} };
    },
  };
}
