import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeCompatTool, writeCompatTool } from "../../src/core/compatwrite.js";
import { getVdfValue } from "../../src/core/vdfpatch.js";
import { fakeSystem } from "../support/fakeSteam.js";

const tmp = () => mkdtemp(join(tmpdir(), "protium-compatwrite-"));

const CONFIG_VDF = `"InstallConfigStore"
{
  \t"Software"
  \t{
    \t\t"Valve"
    \t\t{
      \t\t\t"Steam"
      \t\t\t{
        \t\t\t\t"CompatToolMapping"
        \t\t\t\t{
          \t\t\t\t\t"0"
          \t\t\t\t\t{
            \t\t\t\t\t\t"name"\t\t"proton-cachyos-slr"
          \t\t\t\t\t}
          \t\t\t\t\t"620"
          \t\t\t\t\t{
            \t\t\t\t\t\t"name"\t\t"GE-Proton9-27"
          \t\t\t\t\t}
        \t\t\t\t}
      \t\t\t}
    \t\t}
  \t}
}
`;

const C_PATH = ["InstallConfigStore", "Software", "Valve", "Steam", "CompatToolMapping"];

async function setupSteam(dir: string): Promise<string> {
  const root = join(dir, ".steam");
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "config.vdf"), CONFIG_VDF, "utf8");
  return root;
}

describe("writeCompatTool", () => {
  it("setzt name, config und priority im mapping", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const configPath = join(root, "config", "config.vdf");

    const result = await writeCompatTool({ system: fakeSystem() }, root, 730, "custom-proton-99");

    expect(result).toBe("written");
    const text = await readFile(configPath, "utf8");
    expect(getVdfValue(text, [...C_PATH, "730", "name"])).toBe("custom-proton-99");
    expect(getVdfValue(text, [...C_PATH, "730", "config"])).toBe("");
    expect(getVdfValue(text, [...C_PATH, "730", "priority"])).toBe("250");
  });

  it("no-op bei unverändertem tool → kein write, kein backup", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const backupDir = join(root, "backups");
    const configPath = join(root, "config", "config.vdf");
    const original = await readFile(configPath, "utf8");

    const result = await writeCompatTool({ system: fakeSystem() }, root, 620, "GE-Proton9-27");

    expect(result).toBe("unchanged");
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readdir(backupDir).catch(() => [])).toEqual([]);
  });

  it("ändert ein bestehendes tool → setzt config + priority zusätzlich", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const configPath = join(root, "config", "config.vdf");

    const result = await writeCompatTool({ system: fakeSystem() }, root, 620, "OtherTool");

    expect(result).toBe("written");
    const text = await readFile(configPath, "utf8");
    expect(getVdfValue(text, [...C_PATH, "620", "name"])).toBe("OtherTool");
    expect(getVdfValue(text, [...C_PATH, "620", "config"])).toBe("");
    expect(getVdfValue(text, [...C_PATH, "620", "priority"])).toBe("250");
    expect(getVdfValue(text, [...C_PATH, "0", "name"])).toBe("proton-cachyos-slr");
  });

  it("tool-wechsel setzt vorhandene config/priority BEWUSST auf steam-default zurück", async () => {
    const dir = await tmp();
    const root = join(dir, ".steam");
    await mkdir(join(root, "config"), { recursive: true });
    const withExtras = `"InstallConfigStore"
    {
      \t"Software"
      \t{
        \t\t"Valve"
        \t\t{
          \t\t\t"Steam"
          \t\t\t{
            \t\t\t\t"CompatToolMapping"
            \t\t\t\t{
              \t\t\t\t\t"620"
              \t\t\t\t\t{
                \t\t\t\t\t\t"name"\t\t"GE-Proton9-27"
                \t\t\t\t\t\t"config"\t\t"noesync"
                \t\t\t\t\t\t"priority"\t\t"90"
              \t\t\t\t\t}
            \t\t\t\t}
          \t\t\t}
        \t\t}
      \t}
    }
    `;
    const configPath = join(root, "config", "config.vdf");
    await writeFile(configPath, withExtras, "utf8");

    await writeCompatTool({ system: fakeSystem() }, root, 620, "NewTool");

    const text = await readFile(configPath, "utf8");
    expect(getVdfValue(text, [...C_PATH, "620", "name"])).toBe("NewTool");
    expect(getVdfValue(text, [...C_PATH, "620", "config"])).toBe("");
    expect(getVdfValue(text, [...C_PATH, "620", "priority"])).toBe("250");
  });

  it("write → remove → block vollständig weg", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);

    await writeCompatTool({ system: fakeSystem() }, root, 730, "tmp");
    const result = await removeCompatTool({ system: fakeSystem() }, root, 730);

    expect(result).toBe("written");
    const text = await readFile(join(root, "config", "config.vdf"), "utf8");
    expect(getVdfValue(text, [...C_PATH, "730", "name"])).toBeUndefined();
    expect(getVdfValue(text, [...C_PATH, "620", "name"])).toBe("GE-Proton9-27");
  });

  it("write-gate: blockt bei laufendem steam", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const configPath = join(root, "config", "config.vdf");
    const original = await readFile(configPath, "utf8");
    const steamSystem = { ...fakeSystem(), isProcessRunning: async () => true };

    await expect(writeCompatTool({ system: steamSystem }, root, 730, "foo")).rejects.toThrow(
      "steam is running",
    );
    expect(await readFile(configPath, "utf8")).toBe(original);
  });
});

describe("removeCompatTool", () => {
  it("entfernt den appId-block aus dem mapping", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const configPath = join(root, "config", "config.vdf");

    const result = await removeCompatTool({ system: fakeSystem() }, root, 620);

    expect(result).toBe("written");
    const text = await readFile(configPath, "utf8");
    expect(getVdfValue(text, [...C_PATH, "620", "name"])).toBeUndefined();
    expect(getVdfValue(text, [...C_PATH, "0", "name"])).toBe("proton-cachyos-slr");
  });

  it("no-op wenn kein mapping existiert", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const backupDir = join(root, "backups");
    const configPath = join(root, "config", "config.vdf");
    const original = await readFile(configPath, "utf8");

    const result = await removeCompatTool({ system: fakeSystem() }, root, 999);

    expect(result).toBe("unchanged");
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readdir(backupDir).catch(() => [])).toEqual([]);
  });
});
