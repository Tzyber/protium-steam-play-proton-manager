// localconfig.vdf (pro steam-account): startoptionen lesen/schreiben + aktiven user finden.
import { paths } from "./paths.js";
import type { FileSystem } from "./ports.js";
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

/** spielname aus steams localconfig (Apps/<appId>/name). steam pflegt die
 *  einträge auch für deinstallierte spiele weiter, daher die quelle für
 *  namen in der cleanup-liste. undefined = kein eintrag. */
export function readAppName(localConfigText: string, appId: number): string | undefined {
  const name = getVdfValue(localConfigText, [
    "UserLocalConfigStore",
    "Software",
    "Valve",
    "Steam",
    "Apps",
    String(appId),
    "name",
  ]);
  return name && name.trim() !== "" ? name : undefined;
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

export type ActiveUserSearchResult =
  | { status: "missing" }
  | { status: "unreadable"; detail: string }
  | { status: "selected"; userId: string; selection: "unique" | "ambiguous" };

/**
 * der account, dessen localconfig.vdf wir lesen/schreiben: kandidaten sind userdata-dirs
 * MIT localconfig.vdf. bei mehreren entscheidet loginusers.vdf (MostRecent), sonst fallback.
 */
export async function findActiveUser(
  fs: FileSystem,
  steamRoot: string,
): Promise<ActiveUserSearchResult> {
  const candidates: string[] = [];
  try {
    const dir = paths.userdataDir(steamRoot);
    if (!(await fs.exists(dir))) return { status: "missing" };
    for (const e of await fs.readDir(dir)) {
      if (!e.isDirectory || !NUMERIC_RE.test(e.name)) continue;
      if (await fs.exists(paths.localConfigVdf(steamRoot, e.name))) candidates.push(e.name);
    }
  } catch (e) {
    return { status: "unreadable", detail: e instanceof Error ? e.message : String(e) };
  }
  // numerisch sortieren: lexikographisch läge "10" vor "2".
  const first = candidates.sort((a, b) => Number(a) - Number(b))[0];
  if (first === undefined) return { status: "missing" };
  if (candidates.length === 1) return { status: "selected", userId: first, selection: "unique" };

  const recent = await mostRecentUser(fs, steamRoot);
  if (recent && candidates.includes(recent)) {
    return { status: "selected", userId: recent, selection: "unique" };
  }
  return { status: "selected", userId: first, selection: "ambiguous" };
}
