import { joinPath, paths } from "./paths.js";
import type { DirEntry, FileSystem } from "./ports.js";
import { NUMERIC_RE, type OrphanEntry, type OrphanType, parseSafeAppId } from "./types.js";

const ORPHAN_TYPES: OrphanType[] = ["compatdata", "shadercache"];

/** Namenspräfix, das `claim_delete_target` (delete_ops.rs) einem Ziel vor der
 *  Mutation gibt. Spiegel zum Rust-Code, beide zusammen pflegen. */
export const DELETE_CLAIM_PREFIX = ".protium-delete-claim-";

/** Parent-Location eines liegengebliebenen Claims. Der Delete-Pipeline claimt
 *  Ziele in vier Locations: compatdata/shadercache (Orphans), .protium-trash
 *  (Papierkorb-Einträge) und compatibilitytools.d (GE-Tools). */
export type IncompleteDeletionType = OrphanType | "trash" | "compat-tool";

/** Ein Verzeichnis, das Protium zum Löschen umbenannt, aber nicht mehr
 *  abgeschlossen hat (Absturz, SIGKILL, Stromausfall im Fenster zwischen
 *  Umbenennen und Mutation). Steam findet es unter diesem Namen nicht mehr;
 *  bei compatdata steckt darin ein Wine-Prefix samt Spielständen. */
export interface IncompleteDeletion {
  path: string;
  /** Library, in der der Rest gefunden wurde; bei compat-tool-Resten der
   *  Steam-Root, weil compatibilitytools.d dort liegt. */
  library: string;
  type: IncompleteDeletionType;
  name: string;
}

function typeDir(library: string, type: OrphanType): string {
  return type === "compatdata" ? paths.compatdataDir(library) : paths.shadercacheDir(library);
}

export async function findOrphans(
  libraries: readonly string[],
  installedAppIds: ReadonlySet<number>,
  blockedAppIds: ReadonlySet<number>,
  fs: FileSystem,
): Promise<OrphanEntry[]> {
  const orphans: OrphanEntry[] = [];

  for (const lib of libraries) {
    for (const type of ORPHAN_TYPES) {
      const dir = typeDir(lib, type);

      let entries: DirEntry[];
      try {
        entries = await fs.readDir(dir);
      } catch {
        continue; // Fehlende oder nicht lesbare Verzeichnisse überspringen.
      }

      for (const entry of entries) {
        if (!entry.isDirectory || entry.isSymlink) continue;
        // Claim-Reste sind keine Orphans: sie gehören zu einer abgebrochenen
        // Löschung und werden von findIncompleteDeletions gemeldet.
        if (entry.name.startsWith(DELETE_CLAIM_PREFIX)) continue;
        if (!NUMERIC_RE.test(entry.name)) continue;
        const appId = parseSafeAppId(entry.name);
        if (appId === null) continue;
        // blockedAppIds = appIDs, deren manifest existiert, die aber kein
        // spiel sind (z. B. proton-builtin-pakete). ihr prefix ist kein
        // verwaister prefix, sonst blockt das backend beim löschen
        // ("currently installed") und der eintrag bliebe für immer stehen.
        if (installedAppIds.has(appId) || blockedAppIds.has(appId)) continue;

        const orphanPath =
          type === "compatdata"
            ? paths.compatdataPath(lib, entry.name)
            : paths.shadercachePath(lib, entry.name);

        orphans.push({
          appId,
          type,
          path: orphanPath,
          library: lib,
        });
      }
    }
  }

  return orphans;
}

/** Prefix eines Steam-eigenen Pakets (Proton-Builtin oder Runtime), das der
 *  Cleanup nicht anbietet. Wird nur gemeldet, damit belegter Platz nicht
 *  unsichtbar wird (INV-2: melden, nicht anbieten). */
export interface SteamOwnedPrefix {
  path: string;
  library: string;
  appId: number;
  sizeBytes?: number;
}

/**
 * Findet compatdata-Prefixes, deren AppID auf der Blocklist steht.
 *
 * Die Filterbedingung ist dieselbe wie im findOrphans-Filter: `blockedAppIds`
 * enthält nur AppIDs, deren Manifest der Scan gesehen hat (Blocklist UND
 * Manifest vorhanden). Fehlt das Manifest eines Builtins, ist sein Prefix ein
 * echter Rest und wird als Orphan angeboten — bewusst so. Die Menge hier und
 * der Filter in findOrphans müssen dieselbe Quelle nutzen, sonst zeigt der
 * Hinweis eine andere Menge an, als tatsächlich ausgeblendet wurde.
 *
 * Nur compatdata: Shader-Caches der Steam-Pakete sind von dem Filter nicht
 * betroffen.
 */
export async function findSteamOwnedPrefixes(
  libraries: readonly string[],
  blockedAppIds: ReadonlySet<number>,
  fs: FileSystem,
): Promise<SteamOwnedPrefix[]> {
  const found: SteamOwnedPrefix[] = [];

  for (const lib of libraries) {
    const dir = paths.compatdataDir(lib);

    let entries: DirEntry[];
    try {
      entries = await fs.readDir(dir);
    } catch {
      continue; // Fehlende oder nicht lesbare Verzeichnisse überspringen.
    }

    for (const entry of entries) {
      if (!entry.isDirectory || entry.isSymlink) continue;
      if (entry.name.startsWith(DELETE_CLAIM_PREFIX)) continue;
      const appId = parseSafeAppId(entry.name);
      if (appId === null) continue;
      if (!blockedAppIds.has(appId)) continue;

      found.push({
        appId,
        path: paths.compatdataPath(lib, entry.name),
        library: lib,
      });
    }
  }

  return found;
}

/**
 * Sucht liegengebliebene Claim-Verzeichnisse in allen vier Parent-Locations
 * der Delete-Pipeline: compatdata, shadercache, .protium-trash (Papierkorb)
 * und compatibilitytools.d (GE-Tools). Ein Claim-Rest entsteht, wenn die
 * Mutation nach dem Claim-Rename nicht abgeschlossen wurde.
 *
 * Einschränkung: eine zweite, parallel laufende Protium-Instanz kann im
 * rename-nach-rm-Fenster einer laufenden Löschung kurzzeitig gemeldet werden.
 * Die Liste ist deshalb nur eine Meldung — sie bekommt nie Aktionen, die auf
 * einem solchen Eintrag Löschungen oder Restores ausführen.
 *
 * WARUM getrennt von findOrphans: ein Claim-Rest hat keine App-ID und ist kein
 * Löschkandidat — `inspect_deletion_target` im Backend lehnt nicht-numerische
 * Ziele ab. Er wird deshalb nur gemeldet, nicht angeboten (INV-2: lieber
 * sichtbar unbekannt als lautlos weg).
 */
export async function findIncompleteDeletions(
  libraries: readonly string[],
  steamRoot: string,
  fs: FileSystem,
): Promise<IncompleteDeletion[]> {
  const found: IncompleteDeletion[] = [];

  const collect = async (
    dir: string,
    library: string,
    type: IncompleteDeletionType,
  ): Promise<void> => {
    let entries: DirEntry[];
    try {
      entries = await fs.readDir(dir);
    } catch {
      return; // Fehlende oder nicht lesbare Verzeichnisse überspringen.
    }
    for (const entry of entries) {
      if (!entry.isDirectory || entry.isSymlink) continue;
      if (!entry.name.startsWith(DELETE_CLAIM_PREFIX)) continue;
      found.push({ path: joinPath(dir, entry.name), library, type, name: entry.name });
    }
  };

  for (const lib of libraries) {
    for (const type of ORPHAN_TYPES) {
      await collect(typeDir(lib, type), lib, type);
    }
    await collect(paths.trashDir(lib), lib, "trash");
  }
  await collect(paths.compatToolsDir(steamRoot), steamRoot, "compat-tool");

  return found;
}
