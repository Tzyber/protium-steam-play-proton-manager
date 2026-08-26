import type { ScanCoverage, ScanResult } from "../types.js";

export function deriveScanCoverage(result: ScanResult): ScanCoverage {
  const knownLibraries = new Set(result.libraries);
  const unavailableLibraries = new Set(result.skippedLibraries.map((library) => library.path));
  for (const path of unavailableLibraries) knownLibraries.add(path);

  const libraries = {
    total: knownLibraries.size,
    read: knownLibraries.size - unavailableLibraries.size,
    unavailable: unavailableLibraries.size,
  };
  const manifests = result.manifestCounts;
  const tools = result.compatToolCounts;
  const incomplete =
    libraries.unavailable > 0 ||
    result.compatConfigStatus === "unreadable" ||
    result.launchConfigStatus === "unreadable" ||
    manifests.failed > 0 ||
    tools.failed > 0;
  const limited =
    result.compatConfigStatus === "missing" || result.launchConfigStatus === "missing";

  return {
    state: incomplete ? "incomplete" : limited ? "limited" : "complete",
    libraries,
    compatConfig: result.compatConfigStatus,
    launchConfig: result.launchConfigStatus,
    manifests: { read: manifests.read, failed: manifests.failed },
    tools: { read: tools.read, failed: tools.failed },
  };
}
