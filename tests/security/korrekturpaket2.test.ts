import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(join(repo, root))) {
    const path = join(repo, root, entry);
    if (statSync(path).isDirectory()) result.push(...sourceFiles(join(root, entry)));
    else if (/\.(rs|ts|vue)$/.test(entry)) result.push(path);
  }
  return result;
}

describe("korrekturpaket 2 static bypass contract", () => {
  it("hält Capability und Asset-Konfiguration frei von Environment-Grants", () => {
    const capability = readFileSync(join(repo, "src-tauri/capabilities/default.json"), "utf8");
    const config = readFileSync(join(repo, "src-tauri/tauri.conf.json"), "utf8");
    const cargo = readFileSync(join(repo, "src-tauri/Cargo.toml"), "utf8");
    const scopePaths = [...capability.matchAll(/"path"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);

    expect(scopePaths.join("\n")).not.toMatch(/steam|\.steam|flatpak|snap|library/i);
    expect(config).not.toMatch(/assetProtocol|asset\.localhost|asset:/);
    expect(cargo).not.toContain("protocol-asset");
  });

  it("hält Frontend und Commands frei von alten Bypass-Schnittstellen", () => {
    const frontendFiles = [...sourceFiles("src/core"), ...sourceFiles("src/ui")];
    for (const path of frontendFiles) {
      const text = readFileSync(path, "utf8");
      const label = relative(repo, path);
      expect(text, label).not.toMatch(/convertFileSrc|allow_library_scope|allow_directory/);
      if (path !== join(repo, "src/core/adapters/tauri.ts")) {
        expect(text, label).not.toContain("@tauri-apps/plugin-fs");
      }
    }

    const rustFiles = sourceFiles("src-tauri/src");
    for (const path of rustFiles) {
      const text = readFileSync(path, "utf8");
      expect(text, relative(repo, path)).not.toMatch(/allow_library_scope|allow_directory/);
    }
  });
});
