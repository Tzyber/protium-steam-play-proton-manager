import type { EnvironmentSnapshot } from "../ports.js";
import type { ScanWarning, SkippedLibrary } from "../types.js";

/** übersetzt den backend-snapshot: fehlgeschlagene discovery bleibt sichtbar.
 *  `path-missing` ist belegte abwesenheit, `scope-failed`/`read-failed` sind
 *  zugriffs- oder strukturschäden; das cleanup behandelt nur den ersten fall
 *  nach nutzerfreigabe als ignorierbar. */
export function readLibraryList(environment: EnvironmentSnapshot): {
  libraries: string[];
  warnings: ScanWarning[];
  skippedLibraries: SkippedLibrary[];
} {
  const libraries = [...environment.libraries];
  const read = new Set(libraries);
  const skippedLibraries: SkippedLibrary[] = [];
  const warnings: ScanWarning[] = [];
  // ein snapshot ohne das feld kann die discovery-fehler nicht mehr belegen
  // (z. b. versionsversatz): der scan degradiert sichtbar statt zu werfen
  // (INV-2), und der unbekannte zustand blockiert das cleanup wie ein
  // zugriffsfehler.
  const unavailableList = environment.unavailableLibraries;
  if (!Array.isArray(unavailableList)) {
    warnings.push({
      type: "library",
      path: environment.steamRoot,
      reason: "unverified",
      detail: "the backend snapshot does not report unavailable libraries",
    });
    // platzhalter für den ganzen scan: coverage soll unvollständig melden und
    // das cleanup blockieren, ohne eine konkrete library zu benennen.
    skippedLibraries.push({ path: environment.steamRoot, reason: "unverified" });
    return { libraries, warnings, skippedLibraries };
  }
  const seen = new Set<string>();
  for (const unavailable of unavailableList) {
    // ein pfad, der zugleich gelesen wurde, ist kein ausfall; doppelte
    // discovery-einträge erzeugen genau eine warnung.
    if (read.has(unavailable.path) || seen.has(unavailable.path)) continue;
    seen.add(unavailable.path);
    skippedLibraries.push({ path: unavailable.path, reason: unavailable.reason });
    warnings.push({
      type: "library",
      path: unavailable.path,
      reason: unavailable.reason,
      detail: `library "${unavailable.path}" unavailable during discovery: ${unavailable.reason}`,
    });
  }
  return { libraries, warnings, skippedLibraries };
}
