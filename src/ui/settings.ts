import type { Pinia } from "pinia";
import type { SortDir, SortKey } from "../core/filter";
import { isRecord } from "../core/guards";
import { logError } from "./diagnostics";
import { type Locale, setLocale } from "./i18n";
import { ports } from "./ports";
import { useLibraryStore } from "./stores/libraryStore";
import { useUiStore, type ViewId } from "./stores/uiStore";

export interface AppSettings {
  language: Locale;
  view: ViewId;
  sortKey: SortKey;
  sortDir: SortDir;
}

export type PartialAppSettings = Partial<AppSettings>;

const VALID_LANGUAGES: ReadonlySet<Locale> = new Set(["de", "en"]);
const VALID_VIEWS: ReadonlySet<ViewId> = new Set(["library", "proton", "cleanup", "history"]);
const VALID_SORT_KEYS: ReadonlySet<SortKey> = new Set(["name", "size", "tier", "lastPlayed"]);
const VALID_SORT_DIRS: ReadonlySet<SortDir> = new Set(["asc", "desc"]);

function isOneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>): value is T {
  return typeof value === "string" && (allowed as ReadonlySet<string>).has(value);
}

/** Parst gespeichertes JSON und übernimmt nur vorhandene gültige Felder.
 *  Leerstring, defektes JSON oder Nicht-Objekt werfen, damit `initAppSettings`
 *  den Defekt protokolliert und Defaults stehen lässt. */
export function parseSettings(raw: string): PartialAppSettings {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("invalid settings root: expected JSON object");
  }
  const result: PartialAppSettings = {};
  if (isOneOf(parsed.language, VALID_LANGUAGES)) result.language = parsed.language;
  if (isOneOf(parsed.view, VALID_VIEWS)) result.view = parsed.view;
  if (isOneOf(parsed.sortKey, VALID_SORT_KEYS)) result.sortKey = parsed.sortKey;
  if (isOneOf(parsed.sortDir, VALID_SORT_DIRS)) result.sortDir = parsed.sortDir;
  return result;
}

/** Serialisiert alle vier Felder in fester Reihenfolge. */
export function serializeSettings(settings: AppSettings): string {
  return JSON.stringify(
    {
      language: settings.language,
      view: settings.view,
      sortKey: settings.sortKey,
      sortDir: settings.sortDir,
    },
    null,
    2,
  );
}

/** Lädt persistierte UI-Einstellungen vor dem Mount (fail-open, Geist von INV-2):
 *  überschreibt nur gültige Felder und wirft nie. Bei fehlender Datei (`null`)
 *  bleiben Defaults still stehen. */
export async function initAppSettings(pinia: Pinia): Promise<void> {
  try {
    const raw = await ports.settings.load();
    if (raw === null) return;
    const parsed = parseSettings(raw);
    if (parsed.language !== undefined) {
      setLocale(parsed.language);
    }
    if (parsed.view !== undefined) {
      useUiStore(pinia).go(parsed.view);
    }
    if (parsed.sortKey !== undefined || parsed.sortDir !== undefined) {
      useLibraryStore(pinia).restoreSort(parsed.sortKey, parsed.sortDir);
    }
  } catch (err) {
    logError("Einstellungen konnten nicht geladen werden", err);
  }
}
