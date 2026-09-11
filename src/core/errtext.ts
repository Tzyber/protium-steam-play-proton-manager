/** rust-commands rejecten mit einem rohen string (kein Error-objekt) →
 *  `(e as Error).message` wäre dann `undefined` und die echte ursache weg. */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** erkennung des "keine steam-installation"-fehlers aus dem backend
 *  (discover_steam_environment). der text ist über die sprachgrenze stabil,
 *  aber die stelle soll zentral bleiben statt per includes gestreut. */
export function isSteamNotFound(e: unknown): boolean {
  return errText(e).includes("steam installation not found");
}

/** ablehnung des write-gates (delete_ops): steam läuft, löschen verweigert.
 *  für das löschen braucht es einen eigenen text, `errors.steamRunning`
 *  beschreibt den schreibfall. */
export function isSteamRunning(e: unknown): boolean {
  return errText(e).includes("steam is running");
}

/** ablehnung von install_ge_proton: der zielordner existiert schon.
 *  der text ist über die sprachgrenze stabil, die erkennung bleibt zentral. */
export function isToolAlreadyExists(e: unknown): boolean {
  return errText(e).includes("ToolAlreadyExists");
}
