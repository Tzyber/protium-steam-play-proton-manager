import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { paths } from "../../../src/core/paths.js";
import type { Ports } from "../../../src/core/ports.js";
import { resolveLocalHeader } from "../../../src/core/scan/cover.js";
import { nodeFs } from "../../support/fakeSteam";

const roots: string[] = [];

function steamRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "protium-cover-"));
  roots.push(root);
  return root;
}

function hashDir(root: string, appId: number, hash: string): string {
  const dir = join(paths.libraryCacheAppDir(root, appId), hash);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveLocalHeader", () => {
  it("findet das cover im hash-unterordner des librarycache", async () => {
    const root = steamRoot();
    const dir = hashDir(root, 620, "abc123hash");
    writeFileSync(join(dir, "library_header.jpg"), "JPEGDATA");

    const header = await resolveLocalHeader(nodeFs(), root, 620);

    expect(header).toBe(
      join(root, "appcache", "librarycache", "620", "abc123hash", "library_header.jpg"),
    );
  });

  it("findet das cover auch neben einem hash-ordner ohne cover", async () => {
    const root = steamRoot();
    hashDir(root, 620, "leer");
    const dir = hashDir(root, 620, "voll");
    writeFileSync(join(dir, "library_header.jpg"), "JPEGDATA");

    const header = await resolveLocalHeader(nodeFs(), root, 620);

    expect(header).toBe(
      join(root, "appcache", "librarycache", "620", "voll", "library_header.jpg"),
    );
  });

  it("liefert null ohne cache-verzeichnis (INV-2: keine ausnahme)", async () => {
    const root = steamRoot();
    expect(await resolveLocalHeader(nodeFs(), root, 620)).toBeNull();
  });

  it("liefert null, wenn kein hash-ordner ein cover traegt", async () => {
    const root = steamRoot();
    hashDir(root, 620, "ohne-cover");
    writeFileSync(join(paths.libraryCacheAppDir(root, 620), "anderes.jpg"), "x");

    expect(await resolveLocalHeader(nodeFs(), root, 620)).toBeNull();
  });

  it("zaehlt ein cover direkt im app-verzeichnis nicht", async () => {
    // der hash-unterordner ist pflicht: die datei daneben stammt nicht aus dem
    // steam-download und ist damit kein belegter lokaler header.
    const root = steamRoot();
    mkdirSync(paths.libraryCacheAppDir(root, 620), { recursive: true });
    writeFileSync(join(paths.libraryCacheAppDir(root, 620), "library_header.jpg"), "JPEGDATA");

    expect(await resolveLocalHeader(nodeFs(), root, 620)).toBeNull();
  });

  it("behandelt einen defekten cache wie einen fehlenden", async () => {
    const root = steamRoot();
    mkdirSync(paths.libraryCacheAppDir(root, 620), { recursive: true });
    const brokenFs: Ports["fs"] = {
      ...nodeFs(),
      readDir: async () => {
        throw new Error("EIO: kaputter cache");
      },
    };

    expect(await resolveLocalHeader(brokenFs, root, 620)).toBeNull();
  });
});
