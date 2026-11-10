import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// P10a/FR-2: die UI spricht nur über die Composition-Root mit dem Adapter.
// Auflösung über den dateistandort statt über das arbeitsverzeichnis (T-11).
const repo = resolve(import.meta.dirname, "../..");
const ADAPTER = "core/adapters/tauri";
const COMPOSITION_ROOT = "src/ui/ports.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(join(repo, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|vue)$/.test(entry.name))
    .map((entry) => relative(repo, join(entry.parentPath, entry.name)));
}

describe("UI-Grenze zum Tauri-Adapter", () => {
  it("kennt den Adapter nur in src/ui/ports.ts", () => {
    const files = sourceFiles("src/ui");
    // Positivkontrolle: der scan sieht die dateien und findet den import an
    // der erlaubten stelle; ohne sie wäre eine leere trefferliste wertlos.
    expect(files).toContain(COMPOSITION_ROOT);
    expect(readFileSync(join(repo, COMPOSITION_ROOT), "utf8")).toContain(ADAPTER);

    const offenders = files
      .filter((file) => file !== COMPOSITION_ROOT)
      .filter((file) => readFileSync(join(repo, file), "utf8").includes(ADAPTER));
    expect(offenders).toEqual([]);
  });

  it("hält auch main.ts aus dem Adapter heraus", () => {
    expect(sourceFiles("src")).toContain("src/main.ts");
    expect(readFileSync(join(repo, "src/main.ts"), "utf8")).not.toContain(ADAPTER);
  });
});
