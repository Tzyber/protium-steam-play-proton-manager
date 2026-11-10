import type { EnvironmentSnapshot } from "../ports.js";
import type { ScanWarning, SkippedLibrary } from "../types.js";

/** übersetzt den backend-snapshot: fehlgeschlagene discovery bleibt sichtbar.
 *  `path-missing` ist belegte abwesenheit, `scope-failed`/`read-failed` sind
 *  zugriffs- oder strukturschäden; das cleanup behandelt nur den ersten fall
 *  nach nutzerfreigabe als ignorierbar. der grund kommt bereits normalisiert
 *  aus der wire-grenze des adapters (`asSkipReason`), hier wird nicht geraten. */
export function readLibraryList(environment: EnvironmentSnapshot): {
  libraries: string[];
  warnings: ScanWarning[];
  skippedLibraries: SkippedLibrary[];
} {
  const libraries = [...environment.libraries];
  const read = new Set(libraries);
  const skippedLibraries: SkippedLibrary[] = [];
  const warnings: ScanWarning[] = [];
  const seen = new Set<string>();
  for (const unavailable of environment.unavailableLibraries) {
    // ein pfad, der zugleich gelesen wurde, ist kein ausfall; doppelte
    // discovery-einträge erzeugen genau eine warnung. die steam-wurzel ist die
    // ausnahme: auf ihr steht der sentinel eines unbekannten snapshots, der den
    // ganzen scan meint — der read-filter darf ihn nicht verschlucken, sonst
    // meldet die coverage wieder „vollständig" (INV-2).
    if (seen.has(unavailable.path)) continue;
    if (unavailable.path !== environment.steamRoot && read.has(unavailable.path)) continue;
    seen.add(unavailable.path);
    const { path, reason } = unavailable;
    skippedLibraries.push({ path, reason });
    warnings.push({
      type: "library",
      path,
      reason,
      detail: `library "${path}" unavailable during discovery: ${reason}`,
    });
  }
  return { libraries, warnings, skippedLibraries };
}
