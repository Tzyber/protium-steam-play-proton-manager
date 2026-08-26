import type { EnvironmentSnapshot } from "../ports.js";
import type { ScanWarning, SkippedLibrary } from "../types.js";

export function readLibraryList(environment: EnvironmentSnapshot): {
  libraries: string[];
  warnings: ScanWarning[];
  skippedLibraries: SkippedLibrary[];
} {
  return {
    libraries: [...environment.libraries],
    warnings: [],
    skippedLibraries: [],
  };
}
