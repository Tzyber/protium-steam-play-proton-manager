import { copyFile, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paths } from "../../src/core/paths.js";
import { readAllShortcutAppIds } from "../../src/core/shortcuts.js";
import { buildFakeSteam, CORRUPT_SHORTCUT_VDF_BINARY, nodeFs } from "../support/fakeSteam";

function fsWithUnreadableUserdata(base: ReturnType<typeof nodeFs>): ReturnType<typeof nodeFs> {
  return {
    ...base,
    readDir: (path: string) => {
      if (path.endsWith("/userdata") || path.includes("/userdata/")) {
        throw new Error("EACCES: permission denied");
      }
      return base.readDir(path);
    },
  };
}

describe("readAllShortcutAppIds", () => {
  it("fixture mit gültigem shortcuts.vdf → status ok mit shortcut-id", async () => {
    const { root } = await buildFakeSteam();
    const result = await readAllShortcutAppIds(nodeFs(), root);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ids.has(3641016077)).toBe(true);
    }
  });

  it("steam-root ohne userdata → status none", async () => {
    const { root } = await buildFakeSteam();
    const base = nodeFs();
    const userdata = join(root, "userdata");
    const fs = {
      ...base,
      exists: async (path: string) => (path === userdata ? false : base.exists(path)),
    };
    const result = await readAllShortcutAppIds(fs, root);
    expect(result.status).toBe("none");
  });

  it("userdata/account vorhanden, config fehlt → status none", async () => {
    const { root, userId } = await buildFakeSteam();
    await rm(join(root, "userdata", userId, "config"), { recursive: true, force: true });

    const result = await readAllShortcutAppIds(nodeFs(), root);

    expect(result.status).toBe("none");
  });

  it("config vorhanden, shortcuts.vdf fehlt → status none", async () => {
    const { root, userId } = await buildFakeSteam();
    await rm(join(root, "userdata", userId, "config", "shortcuts.vdf"), { force: true });

    const result = await readAllShortcutAppIds(nodeFs(), root);

    expect(result.status).toBe("none");
  });

  it("über-limit große shortcuts.vdf → status unreadable statt oom (M4.3)", async () => {
    // 16-MiB-cap: eine 17-MB-shortcuts.vdf darf nicht in den speicher geladen
    // werden, der größen-precheck wirft, die stelle degradiert auf unreadable
    // und folgt damit dem Umgang mit korrupten Dateien.
    const { root, userId } = await buildFakeSteam();
    const scPath = join(root, "userdata", userId, "config", "shortcuts.vdf");
    await writeFile(scPath, Buffer.alloc(17 * 1024 * 1024, 0));

    const result = await readAllShortcutAppIds(nodeFs(), root);

    expect(result.status).toBe("unreadable");
  });

  it("der erste fehlschlag bestimmt das detail (4.12)", async () => {
    const { root, userId } = await buildFakeSteam();
    await mkdir(join(root, "userdata", "222", "config"), { recursive: true });
    const base = nodeFs();
    let configReads = 0;
    const fs = {
      ...base,
      readDir: (path: string) => {
        if (/\/userdata\/\d+$/.test(path)) {
          configReads += 1;
          throw new Error(
            configReads === 1 ? "blocked: first" : "unreadable: second",
          );
        }
        return base.readDir(path);
      },
    };

    const result = await readAllShortcutAppIds(fs, root);

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.detail).toBe("blocked");
    }
    expect(userId).toBeTruthy();
  });

  it("korruptes shortcuts.vdf → status unreadable", async () => {
    const { root, userId } = await buildFakeSteam();
    const fs = nodeFs();
    const dir = `${root}/userdata/${userId}/config`;
    // write corrupt over the valid one
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${dir}/shortcuts.vdf`, CORRUPT_SHORTCUT_VDF_BINARY);

    const result = await readAllShortcutAppIds(fs, root);
    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.paths.length).toBeGreaterThan(0);
    }
  });

  it("unlesbares userdata → status unreadable mit klassifiziertem detail", async () => {
    const { root } = await buildFakeSteam();
    const fs = fsWithUnreadableUserdata(nodeFs());

    const result = await readAllShortcutAppIds(fs, root);
    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.paths).toEqual([]);
      // V1: der detailwert ist ein kanonischer code, kein roher backendsatz
      expect(result.detail).toBe("unknown");
      expect(result.detail).not.toContain("permission denied");
    }
  });

  it("gibt einen bekannten fehlercode als detail weiter", async () => {
    const { root } = await buildFakeSteam();
    const inner = nodeFs();
    const fs = {
      ...inner,
      exists: async () => {
        throw "unreadable: userdata";
      },
    };

    const result = await readAllShortcutAppIds(fs, root);
    if (result.status !== "unreadable") throw new Error("status unreadable erwartet");
    expect(result.detail).toBe("unreadable");
  });

  // 4.12: der account-readDir-fehler lief bisher in ein nacktes `catch {}`,
  // das detail des ergebnisses blieb leer. der code muss mit.
  it("account-readDir mit codiertem fehler → detail ist der code", async () => {
    const { root, userId } = await buildFakeSteam();
    const inner = nodeFs();
    const account = paths.userdataAccountDir(root, userId);
    const fs = {
      ...inner,
      readDir: async (path: string) => {
        if (path === account) throw "unreadable: account nicht lesbar";
        return inner.readDir(path);
      },
    };

    await expect(readAllShortcutAppIds(fs, root)).resolves.toEqual({
      status: "unreadable",
      paths: [paths.shortcutsVdf(root, userId)],
      detail: "unreadable",
    });
  });

  it("exists-wurf am shortcut-pfad → status unreadable, kein reject", async () => {
    const { root, userId } = await buildFakeSteam();
    const base = nodeFs();
    const scPath = paths.shortcutsVdf(root, userId);
    const fs = {
      ...base,
      exists: async (path: string) => {
        if (path === scPath) throw new Error("EACCES: permission denied");
        return base.exists(path);
      },
    };

    await expect(readAllShortcutAppIds(fs, root)).resolves.toEqual({
      status: "unreadable",
      paths: [scPath],
      // der rohe satz wird nicht weitergegeben, nur der klassifizierte code
      detail: "unknown",
    });
  });

  // parität zu delete_usage.rs mit echten symlinks: rust lehnt jeden
  // symlink unter userdata und einen symlinkten config-ordner ab.
  it.each(["424242", "anonymous"])(
    "symlink-eintrag %s unter userdata → status unreadable, auch mit shortcuts dahinter",
    async (name) => {
      const { home, root, userId } = await buildFakeSteam();
      const target = join(home, "elsewhere");
      await mkdir(join(target, "config"), { recursive: true });
      await copyFile(paths.shortcutsVdf(root, userId), join(target, "config", "shortcuts.vdf"));
      await symlink(target, join(paths.userdataDir(root), name), "dir");

      await expect(readAllShortcutAppIds(nodeFs(), root)).resolves.toEqual({
        status: "unreadable",
        paths: [paths.shortcutsVdf(root, name)],
      });
    },
  );

  it("symlinkter config-ordner → status unreadable, nicht ok", async () => {
    const { home, root, userId } = await buildFakeSteam();
    const config = join(paths.userdataAccountDir(root, userId), "config");
    const target = join(home, "elsewhere-config");
    await rename(config, target);
    await symlink(target, config, "dir");

    await expect(readAllShortcutAppIds(nodeFs(), root)).resolves.toEqual({
      status: "unreadable",
      paths: [paths.shortcutsVdf(root, userId)],
    });
  });

  it("config als datei statt ordner → status unreadable wie rust (O_DIRECTORY)", async () => {
    const { root, userId } = await buildFakeSteam();
    const config = join(paths.userdataAccountDir(root, userId), "config");
    await rm(config, { recursive: true, force: true });
    await writeFile(config, "kein ordner");

    await expect(readAllShortcutAppIds(nodeFs(), root)).resolves.toEqual({
      status: "unreadable",
      paths: [paths.shortcutsVdf(root, userId)],
    });
  });
});
