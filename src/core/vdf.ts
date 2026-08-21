// Wrapper um `@node-steam/vdf`: Ein Austausch der Bibliothek betrifft nur diese Datei.
import { parse } from "@node-steam/vdf";

export type VdfValue = string | number | VdfNode;
export interface VdfNode {
  [key: string]: VdfValue;
}

export function parseVdf(text: string): VdfNode {
  // keys vor parse neutralisieren: die lib weist ungefiltert zu und würde
  // "__proto__" als prototype-mutation behandeln (globale pollution).
  const safe = text.replace(DANGEROUS_KEY_RE, '"__x_$1__"');
  return sanitize(parse(safe));
}

// keys stehen in der zeilenbasierten lib allein auf einer zeile
const DANGEROUS_KEY_RE = /^\s*"(__proto__|constructor|prototype)"\s*$/gm;

// die lib baut plain objects; ein key "__proto__" oder "constructor" würde
// das prototype-objekt mutieren (getKeyInsensitive nutzt `in`). deep-copy auf
// null-prototype-objects macht alle keys zu eigenen properties.
function sanitize(v: unknown): VdfNode {
  if (typeof v !== "object" || v === null) return {};
  const out: VdfNode = Object.create(null);
  for (const [k, val] of Object.entries(v)) {
    out[k] = typeof val === "object" && val !== null ? sanitize(val) : (val as VdfValue);
  }
  return out;
}

function isNode(v: VdfValue | undefined): v is VdfNode {
  return typeof v === "object" && v !== null;
}

// steam schreibt keys mal groß, mal klein (Valve/valve).
export function getKeyInsensitive(node: VdfNode, key: string): VdfValue | undefined {
  if (key in node) return node[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(node)) {
    if (k.toLowerCase() === lower) return node[k];
  }
  return undefined;
}

// case-insensitiv, undefined statt werfen
export function getPath(root: VdfNode, ...keys: string[]): VdfValue | undefined {
  let cur: VdfValue | undefined = root;
  for (const k of keys) {
    if (!isNode(cur)) return undefined;
    cur = getKeyInsensitive(cur, k);
  }
  return cur;
}

export function asNode(v: VdfValue | undefined): VdfNode | undefined {
  return isNode(v) ? v : undefined;
}

export function asString(v: VdfValue | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

// lib liefert teils number, teils string
export function asInt(v: VdfValue | undefined): number | undefined {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}
