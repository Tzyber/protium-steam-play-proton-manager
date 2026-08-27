import { joinPath, paths } from "./paths.js";
import type { DirEntry, FileSystem } from "./ports.js";
import { NUMERIC_RE, type OrphanEntry, type OrphanType, parseSafeAppId } from "./types.js";

const ORPHAN_TYPES: OrphanType[] = ["compatdata", "shadercache"];

/** Namenspräfix, das `claim_delete_target` (delete_ops.rs) einem Ziel vor der
 *  Mutation gibt. Spiegel zum Rust-Code, beide zusammen pflegen. */
export const DELETE_CLAIM_PREFIX = ".protium-delete-claim-";

/** Ein Verzeichnis, das Protium zum Löschen umbenannt, aber nicht mehr
 *  abgeschlossen hat (Absturz, SIGKILL, Stromausfall im Fenster zwischen
 *  Umbenennen und Mutation). Steam findet es unter diesem Namen nicht mehr;
 *  bei compatdata steckt darin ein Wine-Prefix samt Spielständen. */
export interface IncompleteDeletion {
  path: string;
  library: string;
  type: OrphanType;
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

/**
 * Sucht liegengebliebene Claim-Verzeichnisse in compatdata und shadercache.
 *
 * Einschränkung: eine zweite, parallel laufende Protium-Instanz kann im
 * rename-nach-rm-Fenster einer laufenden Löschung kurzzeitig gemeldet werden.
 * Die Liste ist deshalb nur eine Meldung — sie bekommt nie Aktionen, die auf
 * einem solchen Eintrag Löschungen oder Restores ausführen.
 *
 * WARUM getrennt von findOrphans: ein Claim-Rest hat keine App-ID und ist kein
 * Löschkandidat — `inspect_deletion_target` im Backend lehnt nicht-numerische
 * Ziele ab. Er wird deshalb nur gemeldet, nicht angeboten (INV-2: lieber
 * sichtbar unbekannt als lautlos weg). Der Papierkorb meldet dieselbe Klasse
 * bereits über `unknown`, `compatibilitytools.d` zeigt sie als Tool ohne VDF.
 */
export async function findIncompleteDeletions(
  libraries: readonly string[],
  fs: FileSystem,
): Promise<IncompleteDeletion[]> {
  const found: IncompleteDeletion[] = [];

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
        if (!entry.name.startsWith(DELETE_CLAIM_PREFIX)) continue;

        found.push({
          path: joinPath(dir, entry.name),
          library: lib,
          type,
          name: entry.name,
        });
      }
    }
  }

  return found;
}
