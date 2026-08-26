import { type CompatToolMapping, parseCompatToolMapping } from "../compat.js";
import { errText } from "../errtext.js";
import { findActiveUser } from "../localconfig.js";
import { paths } from "../paths.js";
import type { Ports } from "../ports.js";
import type { CompatConfigStatus, LaunchConfigStatus, ScanWarning } from "../types.js";

export async function readCompatMapping(
  fs: Ports["fs"],
  steamRoot: string,
): Promise<{
  mapping: CompatToolMapping;
  compatConfigStatus: CompatConfigStatus;
  /** rückwärtskompatible Ableitung für bestehende Core-Aufrufer. */
  mappingUsable: boolean;
  warnings: ScanWarning[];
}> {
  const warnings: ScanWarning[] = [];
  let mapping: CompatToolMapping = new Map();
  let compatConfigStatus: CompatConfigStatus = "available";
  try {
    const configPath = paths.configVdf(steamRoot);
    if (await fs.exists(configPath)) {
      mapping = parseCompatToolMapping(await fs.readTextFile(configPath));
    } else {
      compatConfigStatus = "missing";
      warnings.push({
        type: "compat-config",
        reason: "missing",
        detail: "config.vdf fehlt → compat-tools als 'unknown' markiert",
      });
    }
  } catch (e) {
    compatConfigStatus = "unreadable";
    warnings.push({
      type: "compat-config",
      reason: "unreadable",
      detail: `config.vdf nicht lesbar: ${errText(e)}`,
    });
  }
  return {
    mapping,
    compatConfigStatus,
    mappingUsable: compatConfigStatus === "available",
    warnings,
  };
}

export async function readLaunchConfig(
  fs: Ports["fs"],
  steamRoot: string,
): Promise<{
  steamUserId: string | null;
  localConfigText: string | null;
  launchConfigStatus: LaunchConfigStatus;
  warnings: ScanWarning[];
}> {
  const warnings: ScanWarning[] = [];
  let steamUserId: string | null = null;
  let localConfigText: string | null = null;
  let launchConfigStatus: LaunchConfigStatus = "available";
  const activeUser = await findActiveUser(fs, steamRoot);
  if (activeUser.status === "missing") {
    launchConfigStatus = "missing";
    warnings.push({
      type: "launch-config",
      reason: "missing",
      detail: "kein steam-account mit localconfig.vdf gefunden → startoptionen unbekannt",
    });
  } else if (activeUser.status === "unreadable") {
    launchConfigStatus = "unreadable";
    warnings.push({
      type: "launch-config",
      reason: "unreadable",
      detail: `accountsuche nicht lesbar: ${activeUser.detail}`,
    });
  } else {
    steamUserId = activeUser.userId;
    if (activeUser.selection === "ambiguous") {
      launchConfigStatus = "ambiguous";
      warnings.push({
        type: "launch-config",
        reason: "selection-ambiguous",
        steamUserId: activeUser.userId,
        detail: `mehrere steam-accounts gefunden, loginusers.vdf nicht eindeutig → nehme ${activeUser.userId}`,
      });
    }
    try {
      localConfigText = await fs.readTextFile(paths.localConfigVdf(steamRoot, activeUser.userId));
    } catch (e) {
      launchConfigStatus = "unreadable";
      warnings.push({
        type: "launch-config",
        reason: "unreadable",
        steamUserId: activeUser.userId,
        detail: `localconfig.vdf nicht lesbar: ${errText(e)}`,
      });
    }
  }
  return { steamUserId, localConfigText, launchConfigStatus, warnings };
}
