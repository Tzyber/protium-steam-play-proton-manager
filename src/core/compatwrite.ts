// config.vdf, compat-tool-mapping schreiben/entfernen (phase 4, schritt 5).
import { writeSteamFile } from "./configwrite.js";
import { paths } from "./paths.js";
import type { FileSystem, System } from "./ports.js";
import { getVdfValue, removeVdfEntry, setVdfValue } from "./vdfpatch.js";

const COMPAT_MAPPING = ["InstallConfigStore", "Software", "Valve", "Steam", "CompatToolMapping"];

function appIdPath(appId: number): string[] {
  return [...COMPAT_MAPPING, String(appId)];
}

export type CompatWriteResult = "unchanged" | "written";

/**
 * setzt das compat-tool eines spiels in config.vdf.
 * schreibt name + config("") + priority("250"), so legt steam den block auch an.
 * ACHTUNG bewusst: bei einem tool-WECHSEL werden vorhandene config/priority auf den
 * steam-default zurückgesetzt. eine tool-spezifische config (z. b. "noesync") gilt nur
 * fürs alte tool und wäre fürs neue falsch → default ist die sichere wahl.
 */
export async function writeCompatTool(
  ports: { fs: FileSystem; system: System },
  steamRoot: string,
  appId: number,
  internalName: string,
  backupDir: string,
): Promise<CompatWriteResult> {
  const path = paths.configVdf(steamRoot);
  const text = await ports.fs.readTextFile(path);

  if (getVdfValue(text, [...appIdPath(appId), "name"]) === internalName) return "unchanged";

  let patched = setVdfValue(text, [...appIdPath(appId), "name"], internalName);
  patched = setVdfValue(patched, [...appIdPath(appId), "config"], "");
  patched = setVdfValue(patched, [...appIdPath(appId), "priority"], "250");

  await writeSteamFile(ports.system, path, patched, backupDir, text);
  return "written";
}

/** hebt das mapping auf → spiel fällt auf den globalen default zurück. */
export async function removeCompatTool(
  ports: { fs: FileSystem; system: System },
  steamRoot: string,
  appId: number,
  backupDir: string,
): Promise<CompatWriteResult> {
  const path = paths.configVdf(steamRoot);
  const text = await ports.fs.readTextFile(path);

  if (getVdfValue(text, [...appIdPath(appId), "name"]) === undefined) return "unchanged";

  const patched = removeVdfEntry(text, appIdPath(appId));
  await writeSteamFile(ports.system, path, patched, backupDir, text);
  return "written";
}
