// Wrapper um `@node-steam/vdf`: Ein Austausch der Bibliothek betrifft nur diese Datei.
import { parse } from "@node-steam/vdf";

export type VdfValue = string | number | VdfNode;
export interface VdfNode {
  [key: string]: VdfValue;
}

export function parseVdf(text: string): VdfNode {
  // keys vor parse neutralisieren: die lib weist ungefiltert zu und würde
  // "__proto__" als prototype-mutation behandeln (globale pollution).
  const safe = neutralizeDangerousBlockKeys(text);
  return sanitize(parse(safe));
}

const DANGEROUS_BLOCK_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function neutralizeDangerousBlockKeys(text: string): string {
  const output: string[] = [];
  let cursor = 0;
  let expectsKey = true;

  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"') {
      const end = quotedTokenEnd(text, cursor);
      if (end === undefined) {
        output.push(text.slice(cursor));
        break;
      }
      const value = text.slice(cursor + 1, end);
      const isBlockKey =
        expectsKey && DANGEROUS_BLOCK_KEYS.has(value) && nextRelevantToken(text, end + 1) === "{";
      output.push(isBlockKey ? `"__x_${value}__"` : text.slice(cursor, end + 1));
      expectsKey = !expectsKey;
      cursor = end + 1;
      continue;
    }

    if (character === "/" && text[cursor + 1] === "/") {
      const end = text.indexOf("\n", cursor + 2);
      if (end === -1) {
        output.push(text.slice(cursor));
        break;
      }
      output.push(text.slice(cursor, end));
      cursor = end;
      continue;
    }

    if (character === "/" && text[cursor + 1] === "*") {
      const end = text.indexOf("*/", cursor + 2);
      if (end === -1) {
        output.push(text.slice(cursor));
        break;
      }
      output.push(text.slice(cursor, end + 2));
      cursor = end + 2;
      continue;
    }

    if (character === "{" || character === "}") {
      output.push(character);
      expectsKey = true;
      cursor += 1;
      continue;
    }

    if (isWhitespace(character)) {
      output.push(character);
      cursor += 1;
      continue;
    }

    const end = bareTokenEnd(text, cursor);
    output.push(text.slice(cursor, end));
    expectsKey = !expectsKey;
    cursor = end;
  }

  return output.join("");
}

function quotedTokenEnd(text: string, start: number): number | undefined {
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (text[cursor] === '"') return cursor;
  }
  return undefined;
}

function nextRelevantToken(text: string, start: number): string | undefined {
  let cursor = start;
  while (cursor < text.length) {
    if (isWhitespace(text[cursor])) {
      cursor += 1;
      continue;
    }
    if (text[cursor] === "/" && text[cursor + 1] === "/") {
      const end = text.indexOf("\n", cursor + 2);
      if (end === -1) return undefined;
      cursor = end + 1;
      continue;
    }
    if (text[cursor] === "/" && text[cursor + 1] === "*") {
      const end = text.indexOf("*/", cursor + 2);
      if (end === -1) return undefined;
      cursor = end + 2;
      continue;
    }
    return text[cursor];
  }
  return undefined;
}

function bareTokenEnd(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length) {
    const character = text[cursor];
    if (isWhitespace(character) || character === '"' || character === "{" || character === "}") {
      break;
    }
    if (character === "/" && (text[cursor + 1] === "/" || text[cursor + 1] === "*")) {
      break;
    }
    cursor += 1;
  }
  return cursor;
}

function isWhitespace(character: string | undefined): character is string {
  return character !== undefined && character.trim() === "";
}

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
