import { errText } from "../core/errtext";

export function formatBytes(bytes: number): string {
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

/** rust-commands rejecten mit einem rohen string (kein Error-objekt) → sicher auslesen.
 *  delegiert an errText (core), eine quelle für error→string statt zwei kopien. */
export function errMsg(e: unknown): string {
  return errText(e);
}
