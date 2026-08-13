import { errText } from "./errtext.js";
import { joinPath } from "./paths.js";
import type { System, TrashListing } from "./ports.js";
import { parseSafeAppId } from "./types.js";

export interface TrashEntry {
  /** voller pfad des papierkorb-eintrags */
  path: string;
  library: string;
  /** verzeichnisname, z. b. "compatdata_1091500_1753372800123" */
  name: string;
  type: "compatdata" | "shadercache";
  appId: number;
  /** unix-ms aus dem verzeichnisnamen */
  trashedAt: number;
  /** größe in bytes (vom store via batchDirSizes gesetzt) */
  sizeBytes?: number;
}

/** stand pro library, auch dann, wenn dort nichts liegt. der nutzer soll sehen,
 *  dass BEIDE libraries geprüft wurden, statt aus einer leeren liste schließen zu
 *  müssen, ob überhaupt geprüft wurde. */
export interface TrashLibraryStatus {
  library: string;
  /** kanonischer papierkorb-pfad, den das backend gelesen hat */
  dir: string;
  /** false = kein papierkorb-verzeichnis vorhanden (normalfall) */
  present: boolean;
  /** anzahl erkannter einträge in dieser library */
  count: number;
  /** gesetzt, wenn das lesen fehlgeschlagen ist (rechte, io) */
  error?: string;
  /** gesetzt, wenn diese library denselben papierkorb-pfad hat wie eine
   *  frühere (symlink-library): eigene einträge zählt sie keine. */
  duplicateOf?: string;
}

export interface TrashScanResult {
  entries: TrashEntry[];
  /** verzeichnisse im papierkorb, die dem muster NICHT entsprechen.
   *  werden nicht angeboten, aber gemeldet, INV-2, nichts lautlos verstecken. */
  unknown: string[];
  /** libraries, deren papierkorb existiert, aber nicht gelesen werden konnte.
   *  MUSS getrennt von "kein papierkorb vorhanden" behandelt werden: sonst sieht
   *  ein lesefehler aus wie ein leerer papierkorb (INV-2/3). */
  unreadable: string[];
  /** eine zeile pro geprüfter library, unabhängig vom ergebnis */
  libraries: TrashLibraryStatus[];
}

const TRASH_NAME_RE = /^(compatdata|shadercache)_(\d+)_(\d+)$/;

export async function findTrashEntries(
  libraries: readonly string[],
  system: System,
): Promise<TrashScanResult> {
  const entries: TrashEntry[] = [];
  const unknown: string[] = [];
  const unreadable: string[] = [];
  const status: TrashLibraryStatus[] = [];
  const seenDirs = new Map<string, string>();

  for (const lib of libraries) {
    let listing: TrashListing;
    try {
      // WARUM über rust und nicht per fs.readDir: der fs-scope des webviews wird
      // per glob (`<library>/**`) vergeben und erfasst ein verzeichnis mit
      // führendem punkt nicht zuverlässig. `.protium-trash` war in externen
      // libraries deshalb unlesbar, die app zeigte einen leeren papierkorb,
      // obwohl prefixes darin lagen. rust hat keinen webview-scope.
      listing = await system.listTrashEntries(lib);
    } catch (e) {
      const msg = errText(e);
      status.push({ library: lib, dir: "", present: true, count: 0, error: msg });
      unreadable.push(lib);
      continue;
    }

    const firstLib = seenDirs.get(listing.dir); // zwei libraries, ein realpath
    if (firstLib !== undefined) {
      // auch für das duplikat eine statuszeile: der nutzer sieht sonst eine
      // zeile weniger als libraries vorhanden sind, ohne erklärung.
      status.push({
        library: lib,
        dir: listing.dir,
        present: listing.present,
        count: 0,
        duplicateOf: firstLib,
      });
      continue;
    }
    seenDirs.set(listing.dir, lib);

    if (!listing.present) {
      status.push({ library: lib, dir: listing.dir, present: false, count: 0 });
      continue;
    }

    let count = 0;
    for (const entry of listing.entries) {
      // pfad aus dem verzeichnis des backends bauen, nicht selbst joinen, sonst
      // zeigt die UI einen anderen ort als den, der gelesen wurde
      const fullPath = joinPath(listing.dir, entry.name);
      const match = TRASH_NAME_RE.exec(entry.name);

      if (!match) {
        unknown.push(fullPath);
        continue;
      }

      const [, typeRaw, appIdRaw, msRaw] = match;
      if (typeRaw === undefined || appIdRaw === undefined || msRaw === undefined) {
        unknown.push(fullPath);
        continue;
      }

      // M4.1 für den timestamp-teil: riesige ziffernfolgen und 0 sind
      // nie gültige unix-ms (appId-guard steckt in parseSafeAppId)
      const appId = parseSafeAppId(appIdRaw);
      const trashedAt = Number.parseInt(msRaw, 10);
      if (appId === null || !Number.isFinite(trashedAt) || trashedAt <= 0) {
        unknown.push(fullPath);
        continue;
      }

      if (!entry.isDirectory || entry.isSymlink) {
        unknown.push(fullPath);
        continue;
      }

      entries.push({
        path: fullPath,
        library: lib,
        name: entry.name,
        type: typeRaw as "compatdata" | "shadercache",
        appId,
        trashedAt,
      });
      count++;
    }

    status.push({ library: lib, dir: listing.dir, present: true, count });
  }

  return { entries, unknown, unreadable, libraries: status };
}
