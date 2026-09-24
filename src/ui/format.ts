// Belegte Null ist eine Messung; formatBytes(0) steht für „leer oder ungültig".
export function formatKnownBytes(bytes: number): string {
  return bytes === 0 ? "0 B" : formatBytes(bytes);
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "…";
  if (!bytes || bytes < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Anzeigetext einer größe aus dem bericht. Fehlt der wert oder ist er
 *  unbrauchbar, steht der platzhalter (INV-2: „nicht gemessen" statt „0 B").
 *  `measured` steht für eine belegte messung: dort ist die 0 ein gültiger wert
 *  („0 B") und nicht das „-", das leer/ungültig bedeutet. */
export function sizeText(
  sizeBytes: number | undefined,
  options: { missing?: string; measured?: boolean } = {},
): string {
  const { missing = "…", measured = false } = options;
  if (sizeBytes === undefined || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return missing;
  return measured ? formatKnownBytes(sizeBytes) : formatBytes(sizeBytes);
}

/** letztes pfadsegment; ein pfad ohne "/" bleibt unverändert. Für knappe
 *  anzeigen (Library-name, Papierkorb-eintrag), nicht für sicherheitsprüfungen. */
export function pathBasename(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}
