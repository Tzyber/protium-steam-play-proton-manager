// INV-1 write-gate für steam-dateien. M3.1: die sicherung selbst (steam-läuft-
// check → backup → atomarer temp+rename) liegt im rust-command
// `write_steam_file`; diese schicht baut nur den backup-pfad und reicht den
// gelesenen originalstand (TOCTOU-basis) durch. der steam-check hier bleibt
// als UX-schicht (SteamRunningError mit übersetzbarer meldung), rust prüft
// zusätzlich und lehnt sonst ab.
import { joinPath } from "./paths.js";
import type { System } from "./ports.js";

export class SteamRunningError extends Error {
  constructor() {
    super(
      "steam läuft gerade, die änderung würde beim beenden überschrieben. bitte steam erst beenden.",
    );
    this.name = "SteamRunningError";
  }
}

/**
 * schreibt `content` nach `path` mit write-gate (INV-1).
 * der steam-check ist doppelt wichtig: steam schreibt vdf-dateien beim beenden zurück
 * → ein write bei laufendem steam würde still revertiert.
 * `backupText`: der vor dem patch gelesene originalstand, so haben backup und patch
 * dieselbe basis (backup-TOCTOU vermieden).
 */
export async function writeSteamFile(
  system: System,
  path: string,
  content: string,
  backupDir: string,
  backupText: string,
): Promise<void> {
  // "steam" matcht per substring auch steamwebhelper, im zweifel lieber blockieren (sichere richtung)
  if (await system.isProcessRunning("steam")) throw new SteamRunningError();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.split("/").pop() ?? "steam-datei";
  const backup = joinPath(backupDir, `${base}.${stamp}`);
  await system.writeSteamConfigFile(path, backupText, content, backup);
}
