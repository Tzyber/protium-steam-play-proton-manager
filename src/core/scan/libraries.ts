import type { EnvironmentSnapshot } from "../ports.js";
import type { SkippedLibrary } from "../types.js";

export function readLibraryList(environment: EnvironmentSnapshot): {
  libraries: string[];
  warnings: string[];
  skippedLibraries: SkippedLibrary[];
} {
  return {
    libraries: [...environment.libraries],
    warnings: [],
    skippedLibraries: [],
  };
}
