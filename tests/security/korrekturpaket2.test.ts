import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Auflösung über den dateistandort statt über das arbeitsverzeichnis (T-11).
const repo = resolve(import.meta.dirname, "../..");

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(join(repo, root))) {
    const path = join(repo, root, entry);
    if (statSync(path).isDirectory()) result.push(...sourceFiles(join(root, entry)));
    else if (/\.(rs|ts|vue)$/.test(entry)) result.push(path);
  }
  return result;
}

describe("statisch belegter bypass-vertrag der tauri-konfiguration", () => {
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

  it("pinnt die fs-Positivlisten und die string-permissions exakt", () => {
    const capability = JSON.parse(
      readFileSync(join(repo, "src-tauri/capabilities/default.json"), "utf8"),
    ) as {
      permissions: (string | { identifier: string; allow?: { path?: string }[] })[];
    };

    function allowPaths(identifier: string): string[] {
      const entry = capability.permissions.find(
        (permission) => typeof permission !== "string" && permission.identifier === identifier,
      );
      if (typeof entry === "string" || entry === undefined) {
        throw new Error(`${identifier} fehlt in der capability`);
      }
      return (entry.allow ?? []).map((rule) => rule.path ?? "");
    }

    expect(allowPaths("fs:scope")).toEqual(["$APPCACHE", "$APPCACHE/**"]);
    expect(allowPaths("fs:allow-write-text-file")).toEqual(["$APPCACHE/**"]);
    expect(allowPaths("fs:allow-mkdir")).toEqual(["$APPCACHE/**"]);

    // die vierte objekt-permission http:default wird in
    // github-capability.test.ts exakt gepinnt; hier zählt die string-menge
    // (objekt-permissions herausgefiltert).
    const stringPermissions = capability.permissions
      .filter((permission): permission is string => typeof permission === "string")
      .sort();
    expect(stringPermissions).toEqual([
      "core:default",
      "core:event:default",
      "core:path:default",
      "core:window:allow-show",
      "fs:allow-exists",
      "fs:allow-read-text-file",
    ]);

    // die vollständige menge: eine neu hinzugefügte objekt-permission (z. b.
    // ein weiteres fs:allow-* mit fremdem pfad) fällt hier auf, nicht erst bei
    // der nächsten sichtprüfung.
    const identifiers = capability.permissions
      .map((permission) => (typeof permission === "string" ? permission : permission.identifier))
      .sort();
    expect(identifiers).toEqual([
      "core:default",
      "core:event:default",
      "core:path:default",
      "core:window:allow-show",
      "fs:allow-exists",
      "fs:allow-mkdir",
      "fs:allow-read-text-file",
      "fs:allow-write-text-file",
      "fs:scope",
      "http:default",
    ]);
  });
});
