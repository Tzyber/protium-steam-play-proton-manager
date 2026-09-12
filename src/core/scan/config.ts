import { type CompatToolMapping, parseCompatToolMapping } from "../compatTools.js";
import { errText } from "../errtext.js";
import { findActiveUser, isLocalConfigParseable } from "../localconfig.js";
import { paths } from "../paths.js";
import type { Ports } from "../ports.js";
import type { CompatConfigStatus, LaunchConfigStatus, ScanWarning } from "../types.js";

export async function readCompatMapping(
  fs: Ports["fs"],
  steamRoot: string,
): Promise<{
  mapping: CompatToolMapping;
  compatConfigStatus: CompatConfigStatus;
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
        detail: "config.vdf missing, compat tools marked 'unknown'",
      });
    }
  } catch (e) {
    compatConfigStatus = "unreadable";
    warnings.push({
      type: "compat-config",
      reason: "unreadable",
      detail: `config.vdf not readable: ${errText(e)}`,
    });
  }
  return {
    mapping,
    compatConfigStatus,
    warnings,
  };
}

/** die eine INV-2-warnung für eine strukturell defekte localconfig. Zwei
 *  stellen erzeugen sie: die vorab-probe hier (defekt auf den ebenen des
 *  abgefragten pfads) und `scanGames` pro spiel (defekt unterhalb eines
 *  spiel-blocks, `scan/local.ts` reicht ihn hoch). Beide müssen denselben text
 *  und denselben grund tragen. */
export function localConfigBrokenWarning(detail: string, steamUserId: string | null): ScanWarning {
  return {
    type: "launch-config",
    reason: "unreadable",
    steamUserId: steamUserId ?? undefined,
    detail: `localconfig.vdf structurally broken: ${detail}`,
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
      detail: "no steam account with localconfig.vdf found, launch options unknown",
    });
  } else if (activeUser.status === "unreadable") {
    launchConfigStatus = "unreadable";
    warnings.push({
      type: "launch-config",
      reason: "unreadable",
      detail: `account discovery not readable: ${activeUser.detail}`,
    });
  } else {
    steamUserId = activeUser.userId;
    if (activeUser.selection === "ambiguous") {
      launchConfigStatus = "ambiguous";
      warnings.push({
        type: "launch-config",
        reason: "selection-ambiguous",
        steamUserId: activeUser.userId,
        detail: `multiple steam accounts found, loginusers.vdf ambiguous, using ${activeUser.userId}`,
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
        detail: `localconfig.vdf not readable: ${errText(e)}`,
      });
    }
    // lexikalische parsefehler sind von aussen nicht sichtbar: `readTextFile`
    // gelingt, erst der strukturelle zugriff wirft. solche defekte treffen die
    // ganze datei und degradieren den status scan-weit, die spiele bleiben
    // lesbar (INV-2). strukturelle defekte unterhalb eines spiel-pfads fängt
    // `scanGames` pro spiel ab.
    const parseError = localConfigText !== null ? isLocalConfigParseable(localConfigText) : null;
    if (parseError) {
      launchConfigStatus = "unreadable";
      localConfigText = null;
      warnings.push(localConfigBrokenWarning(parseError.detail, activeUser.userId));
    }
  }
  return { steamUserId, localConfigText, launchConfigStatus, warnings };
}
