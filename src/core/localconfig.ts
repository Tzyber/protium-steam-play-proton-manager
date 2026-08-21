// localconfig.vdf (pro steam-account): startoptionen lesen/schreiben + aktiven user finden.
import { paths } from "./paths.js";
import type { FileSystem, System, WriteResult } from "./ports.js";
import { NUMERIC_RE } from "./types.js";
import { asInt, asNode, getPath, parseVdf } from "./vdf.js";
import { getVdfValue } from "./vdfpatch.js";

/** pfad des LaunchOptions-werts eines spiels in localconfig.vdf. */
function launchOptionsPath(appId: number): string[] {
  return [
    "UserLocalConfigStore",
    "Software",
    "Valve",
    "Steam",
    "Apps",
    String(appId),
    "LaunchOptions",
  ];
}

export function readLaunchOptions(localConfigText: string, appId: number): string | undefined {
  return getVdfValue(localConfigText, launchOptionsPath(appId));
}

// steamID64 → accountID (= userdata-ordnername); nur individuelle accounts.
function accountIdOf(steamId64: string): string | null {
  const BASE = 76561197960265728n;
  try {
    const id = BigInt(steamId64);
    return id > BASE ? (id - BASE).toString() : null;
  } catch {
    return null;
  }
}

// loginusers.vdf: der zuletzt eingeloggte account ("MostRecent" "1").
async function mostRecentUser(fs: FileSystem, steamRoot: string): Promise<string | null> {
  try {
    const p = paths.loginusersVdf(steamRoot);
    if (!(await fs.exists(p))) return null;
    const users = asNode(getPath(parseVdf(await fs.readTextFile(p)), "users"));
    if (!users) return null;
    for (const key of Object.keys(users)) {
      if (asInt(getPath(users, key, "MostRecent")) === 1) return accountIdOf(key);
    }
  } catch {
    // Defekte Daten lassen den Aufrufer auf den Fallback zurückfallen.
  }
  return null;
}

/**
 * der account, dessen localconfig.vdf wir lesen/schreiben: kandidaten sind userdata-dirs
 * MIT localconfig.vdf. bei mehreren entscheidet loginusers.vdf (MostRecent), sonst fallback.
 * null wenn es keinen kandidaten gibt.
 */
export async function findActiveUser(
  fs: FileSystem,
  steamRoot: string,
): Promise<{ userId: string; warning?: string } | null> {
  const candidates: string[] = [];
  try {
    const dir = paths.userdataDir(steamRoot);
    if (!(await fs.exists(dir))) return null;
    for (const e of await fs.readDir(dir)) {
      if (!e.isDirectory || !NUMERIC_RE.test(e.name)) continue;
      if (await fs.exists(paths.localConfigVdf(steamRoot, e.name))) candidates.push(e.name);
    }
  } catch {
    return null; // Nicht lesbare Benutzerdaten lassen die Startoptionen unbekannt.
  }
  // numerisch sortieren: lexikographisch läge "10" vor "2".
  const first = candidates.sort((a, b) => Number(a) - Number(b))[0];
  if (first === undefined) return null;
  if (candidates.length === 1) return { userId: first };

  const recent = await mostRecentUser(fs, steamRoot);
  if (recent && candidates.includes(recent)) return { userId: recent };
  return {
    userId: first,
    warning: `mehrere steam-accounts gefunden, loginusers.vdf nicht eindeutig → nehme ${first}`,
  };
}

export type LaunchWriteResult = WriteResult;

/**
 * setzt die startoptionen eines spiels via Write-Gate.
 * "unchanged" = wert stand schon so drin → kein write, kein backup.
 */
export async function writeLaunchOptions(
  ports: { system: System },
  steamRoot: string,
  userId: string,
  appId: number,
  value: string,
): Promise<LaunchWriteResult> {
  return ports.system.saveLaunchOptions(steamRoot, userId, appId, value);
}
