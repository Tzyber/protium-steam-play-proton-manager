import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSizeLimit, MAX_FILE_BYTES, nodeFs } from "./fakeSteam.js";

describe("ensureSizeLimit (M4.3, größen-cap für reads)", () => {
  it("unter dem limit → kein throw", () => {
    expect(() => ensureSizeLimit(1024)).not.toThrow();
    expect(() => ensureSizeLimit(MAX_FILE_BYTES)).not.toThrow();
  });

  it("über dem limit → wirft", () => {
    expect(() => ensureSizeLimit(MAX_FILE_BYTES + 1)).toThrow(/zu groß/);
  });
});

describe("nodeFs().exists (INV-2: nur belegte abwesenheit ist 'existiert nicht')", () => {
  /** frisches temp-verzeichnis, das der test wieder aufräumt */
  async function tempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "protium-exists-"));
  }

  it("meldet einen nachweislich fehlenden pfad als 'existiert nicht'", async () => {
    const dir = await tempDir();
    try {
      expect(await nodeFs().exists(join(dir, "fehlt"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reicht ELOOP aus einem symlink-loop weiter statt 'existiert nicht' zu melden", async () => {
    // N5: der rethrow-zweig in `exists` ist die stelle, an der ein ELOOP nicht
    // als „pfad fehlt“ durchrutschen darf. lstat auf den loop-symlink selbst
    // gelingt (er existiert), erst ein pfad DURCH den loop scheitert mit ELOOP.
    const dir = await tempDir();
    const a = join(dir, "a");
    const b = join(dir, "b");
    await symlink(b, a);
    await symlink(a, b);
    try {
      expect(await nodeFs().exists(a)).toBe(true);
      await expect(nodeFs().exists(join(a, "x"))).rejects.toMatchObject({ code: "ELOOP" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
