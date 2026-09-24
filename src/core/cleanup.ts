import { joinPath, paths } from "./paths.js";
import type { DirEntry, FileSystem } from "./ports.js";
import { SHORTCUT_ID_THRESHOLD } from "./shortcuts.js";
import { ORPHAN_TYPES, type OrphanEntry, type OrphanType, parseSafeAppId } from "./types.js";

/** Namenspräfix, das `claim_delete_target` (delete_ops.rs) einem Ziel vor der
 *  Mutation gibt. Spiegel zum Rust-Code, beide zusammen pflegen. */
export const DELETE_CLAIM_PREFIX = ".protium-delete-claim-";

/** Parent-Location eines liegengebliebenen Claims. Der Delete-Pipeline claimt
 *  Ziele in vier Locations: compatdata/shadercache (Orphans), .protium-trash
 *  (Papierkorb-Einträge) und compatibilitytools.d (GE-Tools). */
type IncompleteDeletionType = OrphanType | "trash" | "compat-tool";

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

/** Ergebnis der read-only Claim-Suche. Fehlende Parent-Verzeichnisse sind
 * normal; nur vorhandene, aber nicht lesbare Orte stehen in `unreadable`. */
interface IncompleteDeletionScanResult {
  entries: IncompleteDeletion[];
  unreadable: string[];
}

function typeDir(library: string, type: OrphanType): string {
  return type === "compatdata" ? paths.compatdataDir(library) : paths.shadercacheDir(library);
}

interface CompatEntry {
  library: string;
  type: OrphanType;
  appId: number;
  name: string;
}

/** Gemeinsamer Iterator über die compat-einträge aller libraries. Alle
 *  Ausschlussfilter (kein Ordner, Symlink, Claim-Rest, nicht-numerischer Name)
 *  liegen hier genau einmal; `accept` entscheidet je appId. findOrphans und
 *  findSteamOwnedPrefixes teilen den Iterator, damit ihre Filter nicht driften
 *  (K-05). Reihenfolge: library-major, danach die übergebene Typ-Reihenfolge. */
async function forEachCompatEntry(
  libraries: readonly string[],
  types: readonly OrphanType[],
  fs: FileSystem,
  accept: (appId: number) => boolean,
  handle: (entry: CompatEntry) => void,
): Promise<void> {
  for (const lib of libraries) {
    for (const type of types) {
      let entries: DirEntry[];
      try {
        entries = await fs.readDir(typeDir(lib, type));
      } catch {
        continue; // Fehlende oder nicht lesbare Verzeichnisse überspringen.
      }

      for (const entry of entries) {
        if (!entry.isDirectory || entry.isSymlink) continue;
        // Claim-Reste sind keine Orphans: sie gehören zu einer abgebrochenen
        // Löschung und werden von findIncompleteDeletions gemeldet.
        if (entry.name.startsWith(DELETE_CLAIM_PREFIX)) continue;
        // parseSafeAppId prüft dasselbe zahlenformat und zusätzlich den bereich.
        const appId = parseSafeAppId(entry.name);
        if (appId === null) continue;
        if (!accept(appId)) continue;
        handle({ library: lib, type, appId, name: entry.name });
      }
    }
  }
}

export async function findOrphans(
  libraries: readonly string[],
  installedAppIds: ReadonlySet<number>,
  blockedAppIds: ReadonlySet<number>,
  fs: FileSystem,
): Promise<OrphanEntry[]> {
  const orphans: OrphanEntry[] = [];

  // blockedAppIds = appIDs, deren manifest existiert, die aber kein spiel sind
  // (z. B. proton-builtin-pakete). ihr prefix ist kein verwaister prefix, sonst
  // blockt das backend beim löschen ("currently installed") und der eintrag
  // bliebe für immer stehen.
  await forEachCompatEntry(
    libraries,
    ORPHAN_TYPES,
    fs,
    (appId) => !installedAppIds.has(appId) && !blockedAppIds.has(appId),
    ({ library, type, appId, name }) => {
      orphans.push({
        appId,
        type,
        path:
          type === "compatdata"
            ? paths.compatdataPath(library, name)
            : paths.shadercachePath(library, name),
        library,
      });
    },
  );

  return orphans;
}

/**
 * Klassifiziert die gefundenen Orphans für die Anzeige.
 *
 * Ist `shortcuts.vdf` unlesbar, sind Non-Steam-Shortcuts nicht von echten
 * Orphans unterscheidbar. compatdata kann echte Savegames enthalten, deshalb
 * fail-closed blockieren; shadercache ist regenerierbar und darf bereinigt
 * werden. Shortcut-AppIDs liegen ab 2^31 und sind nicht über ein App-Manifest
 * identifizierbar; sie werden als `potentialShortcut` markiert und von der
 * Prefix-Löschung ausgenommen.
 */
export function classifyOrphans(
  orphans: readonly OrphanEntry[],
  shortcutsUnreadable: boolean,
): OrphanEntry[] {
  const usable = shortcutsUnreadable
    ? orphans.filter((orphan) => orphan.type === "shadercache")
    : orphans;
  return usable.map((orphan) =>
    orphan.appId >= SHORTCUT_ID_THRESHOLD ? { ...orphan, potentialShortcut: true } : orphan,
  );
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
 * echter Rest und wird als Orphan angeboten, bewusst so. Die Menge hier und
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

  await forEachCompatEntry(
    libraries,
    ["compatdata"],
    fs,
    (appId) => blockedAppIds.has(appId),
    ({ library, appId, name }) => {
      found.push({
        appId,
        path: paths.compatdataPath(library, name),
        library,
      });
    },
  );

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
 * Die Liste ist deshalb nur eine Meldung, sie bekommt nie Aktionen, die auf
 * einem solchen Eintrag Löschungen oder Restores ausführen.
 *
 * WARUM getrennt von findOrphans: ein Claim-Rest hat keine App-ID und ist kein
 * Löschkandidat, `inspect_deletion_target` im Backend lehnt nicht-numerische
 * Ziele ab. Er wird deshalb nur gemeldet, nicht angeboten (INV-2: lieber
 * sichtbar unbekannt als lautlos weg).
 */
export async function findIncompleteDeletions(
  libraries: readonly string[],
  steamRoot: string,
  fs: FileSystem,
): Promise<IncompleteDeletionScanResult> {
  const found: IncompleteDeletion[] = [];
  const unreadable = new Set<string>();

  const collect = async (
    dir: string,
    library: string,
    type: IncompleteDeletionType,
  ): Promise<void> => {
    let entries: DirEntry[];
    try {
      entries = await fs.readDir(dir);
    } catch {
      // Ein fehlender Parent ist der Normalfall. Bei einem echten Lesefehler
      // muss der Store ihn sichtbar halten, sonst wird ein unbekannter Claim
      // als leerer Scan dargestellt (INV-2).
      try {
        if (!(await fs.exists(dir))) return;
      } catch {
        // Ein fehlgeschlagener Exists-Check bestätigt kein fehlendes Ziel.
      }
      unreadable.add(dir);
      return;
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

  return { entries: found, unreadable: [...unreadable] };
}
