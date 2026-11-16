import * as fs from "node:fs";
import * as path from "node:path";

export function resolveRepoRoot(dir: string = import.meta.dirname): string {
  const candidate = path.resolve(dir, "../..");
  // Stryker kopiert den Workspace nach .stryker-tmp/sandbox-* und instrumentiert
  // dort die Quelldateien; readRepoFile muss die uninstrumentierte Datei lesen.
  return path.basename(path.dirname(candidate)) === ".stryker-tmp"
    ? path.resolve(candidate, "../..")
    : candidate;
}

const root = resolveRepoRoot();
const cache = new Map<string, string>();

export function readRepoFile(file: string): string {
  return fs.readFileSync(path.join(root, file), "utf-8");
}

export function tokenValues(): Map<string, string> {
  if (cache.size === 0) {
    for (const match of readRepoFile("src/ui/tokens.css").matchAll(
      /(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g,
    )) {
      if (match[1] && match[2]) cache.set(match[1], match[2]);
    }
  }
  return cache;
}

export function tokenValue(name: string): string | undefined {
  return tokenValues().get(name);
}
