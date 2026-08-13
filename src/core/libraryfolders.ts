import { NUMERIC_RE } from "./types.js";
import { asNode, asString, getKeyInsensitive, getPath, parseVdf } from "./vdf.js";

// libraryfolders.vdf: "libraryfolders" → "<index>" → { path }. index-0 ist die root selbst.
export function parseLibraryFolders(text: string): string[] {
  const root = parseVdf(text);
  const container =
    asNode(getKeyInsensitive(root, "libraryfolders")) ??
    asNode(getKeyInsensitive(root, "LibraryFolders"));
  if (!container) return [];

  const out: string[] = [];
  for (const key of Object.keys(container)) {
    if (!NUMERIC_RE.test(key)) continue; // nur numerische indizes
    const path = asString(getPath(container, key, "path"));
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}
