import { type CompatToolMapping, parseCompatToolMapping } from "../compat.js";
import { errText } from "../errtext.js";
import { findActiveUser } from "../localconfig.js";
import { paths } from "../paths.js";
import type { Ports } from "../ports.js";

export async function readCompatMapping(
  fs: Ports["fs"],
  steamRoot: string,
): Promise<{ mapping: CompatToolMapping; mappingUsable: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  let mapping: CompatToolMapping = new Map();
  let mappingUsable = true;
  try {
    const configPath = paths.configVdf(steamRoot);
    if (await fs.exists(configPath)) {
      mapping = parseCompatToolMapping(await fs.readTextFile(configPath));
    } else {
      mappingUsable = false;
      warnings.push("config.vdf fehlt → compat-tools als 'unknown' markiert");
    }
  } catch (e) {
    mappingUsable = false;
    warnings.push(`config.vdf nicht lesbar: ${errText(e)}`);
  }
  return { mapping, mappingUsable, warnings };
}

export async function readLaunchConfig(
  fs: Ports["fs"],
  steamRoot: string,
): Promise<{ steamUserId: string | null; localConfigText: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  let steamUserId: string | null = null;
  let localConfigText: string | null = null;
  const activeUser = await findActiveUser(fs, steamRoot);
  if (!activeUser) {
    warnings.push("kein steam-account mit localconfig.vdf gefunden → startoptionen unbekannt");
  } else {
    steamUserId = activeUser.userId;
    if (activeUser.warning) warnings.push(activeUser.warning);
    try {
      localConfigText = await fs.readTextFile(paths.localConfigVdf(steamRoot, activeUser.userId));
    } catch (e) {
      warnings.push(`localconfig.vdf nicht lesbar: ${errText(e)}`);
    }
  }
  return { steamUserId, localConfigText, warnings };
}
