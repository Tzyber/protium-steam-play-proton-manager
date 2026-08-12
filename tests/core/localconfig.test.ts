import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SteamRunningError } from "../../src/core/configwrite.js";
import {
  findActiveUser,
  readLaunchOptions,
  writeLaunchOptions,
} from "../../src/core/localconfig.js";
import { paths } from "../../src/core/paths.js";
import { getVdfValue } from "../../src/core/vdfpatch.js";
import { buildFakeSteam, fakeSystem, nodeFs } from "../support/fakeSteam.js";

describe("findActiveUser", () => {
  it("findet den einzigen account mit localconfig.vdf", async () => {
    const { root, userId } = await buildFakeSteam();
    const found = await findActiveUser(nodeFs(), root);
    expect(found?.userId).toBe(userId);
    expect(found?.warning).toBeUndefined();
  });

  it("null ohne userdata-verzeichnis", async () => {
    const leer = await mkdtemp(join(tmpdir(), "protium-nouser-"));
    expect(await findActiveUser(nodeFs(), leer)).toBeNull();
  });

  it("bei mehreren accounts entscheidet loginusers.vdf (MostRecent)", async () => {
    const { root, userId } = await buildFakeSteam();
    // zweiter account MIT localconfig, loginusers zeigt weiter auf userId
    await mkdir(join(root, "userdata", "222222222", "config"), { recursive: true });
    await writeFile(
      join(root, "userdata", "222222222", "config", "localconfig.vdf"),
      `"UserLocalConfigStore"\n{\n}\n`,
      "utf8",
    );
    const found = await findActiveUser(nodeFs(), root);
    expect(found?.userId).toBe(userId);
  });

  it("fallback ohne loginusers.vdf: numerisch kleinster account, nicht lexikographisch", async () => {
    // lexikographisch läge "10" vor "2", das wäre der falsche account.
    const root = await mkdtemp(join(tmpdir(), "protium-multiuser-"));
    for (const id of ["10", "2"]) {
      await mkdir(join(root, "userdata", id, "config"), { recursive: true });
      await writeFile(
        join(root, "userdata", id, "config", "localconfig.vdf"),
        `"UserLocalConfigStore"\n{\n}\n`,
        "utf8",
      );
    }
    const found = await findActiveUser(nodeFs(), root);
    expect(found?.userId).toBe("2");
    expect(found?.warning).toBeTruthy();
  });
});

describe("writeLaunchOptions", () => {
  it("setzt startoptionen: appId-block wird angelegt, backup da, nachbar unberührt", async () => {
    const { root, userId } = await buildFakeSteam();
    const fs = nodeFs();
    const backupDir = join(root, "backups-test");

    const r = await writeLaunchOptions(
      { fs, system: fakeSystem() },
      root,
      userId,
      730,
      "MANGOHUD=1 %command%",
      backupDir,
    );
    expect(r).toBe("written");

    const text = await readFile(paths.localConfigVdf(root, userId), "utf8");
    expect(readLaunchOptions(text, 730)).toBe("MANGOHUD=1 %command%");
    expect(readLaunchOptions(text, 620)).toBe("gamemoderun %command%"); // nachbar unberührt

    // backup enthält den ALTSTAND (730 noch ohne optionen)
    const backups = await readdir(backupDir);
    expect(backups).toHaveLength(1);
    const backupFile = backups[0];
    if (!backupFile) throw new Error("backup fehlt");
    const backupText = await readFile(join(backupDir, backupFile), "utf8");
    expect(readLaunchOptions(backupText, 730)).toBeUndefined();
    expect(readLaunchOptions(backupText, 620)).toBe("gamemoderun %command%");
  });

  it("no-op → unchanged: kein write, kein backup", async () => {
    const { root, userId } = await buildFakeSteam();
    const fs = nodeFs();
    const backupDir = join(root, "backups-test");

    const r = await writeLaunchOptions(
      { fs, system: fakeSystem() },
      root,
      userId,
      620,
      "gamemoderun %command%",
      backupDir,
    );
    expect(r).toBe("unchanged");
    expect(await fs.exists(backupDir)).toBe(false);
  });

  it("steam läuft → SteamRunningError, datei unangetastet", async () => {
    const { root, userId } = await buildFakeSteam();
    const fs = nodeFs();
    const system = { ...fakeSystem(), isProcessRunning: async () => true };
    const before = await readFile(paths.localConfigVdf(root, userId), "utf8");

    await expect(
      writeLaunchOptions({ fs, system }, root, userId, 620, "x", join(root, "backups-test")),
    ).rejects.toBeInstanceOf(SteamRunningError);
    expect(await readFile(paths.localConfigVdf(root, userId), "utf8")).toBe(before);
  });
});

// sicherheit: die volle kette landet in einer für steam wohlgeformten datei
it("geschriebene datei parst mit @node-steam/vdf und enthält den wert", async () => {
  const { root, userId } = await buildFakeSteam();
  const fs = nodeFs();
  await writeLaunchOptions(
    { fs, system: fakeSystem() },
    root,
    userId,
    620,
    'MANGOHUD_CONFIG="fps" %command%',
    join(root, "backups-test"),
  );
  const text = await readFile(paths.localConfigVdf(root, userId), "utf8");
  expect(
    getVdfValue(text, [
      "UserLocalConfigStore",
      "Software",
      "Valve",
      "Steam",
      "Apps",
      "620",
      "LaunchOptions",
    ]),
  ).toBe('MANGOHUD_CONFIG="fps" %command%');
});
