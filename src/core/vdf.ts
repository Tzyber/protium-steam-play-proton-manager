// Wrapper um `@node-steam/vdf`: Ein Austausch der Bibliothek betrifft nur diese Datei.
import { parse } from "@node-steam/vdf";

export type VdfValue = string | number | VdfNode;
export interface VdfNode {
  [key: string]: VdfValue;
}

/** Neutralisiert gefährliche Block-Keys vor dem Parse und stellt den globalen
 *  Zustand nach dem Parse exakt wieder her. */
export function parseVdf(text: string): VdfNode {
  // Die Bibliothek weist Keys ungefiltert zu und kann dabei `Object.prototype`
  // bzw. `Object` mutieren. Der Pre-Pass fängt die belegten Formen ab, bildet
  // die zeilenweise Grammatik der Bibliothek aber nicht vollständig ab. Deshalb
  // liegt um den Parse zusätzlich ein Containment: der globale Zustand wird
  // vorher festgehalten und danach exakt zurückgesetzt. Der Pre-Pass bleibt die
  // erste Schranke (er verhindert die Mutation im Normalfall), das Containment
  // ist die zweite, die von den Parse-Eigenheiten unabhängig ist.
  const guarded = guardedObjects().map(
    (target) => [target, Object.getOwnPropertyDescriptors(target)] as const,
  );
  try {
    return sanitize(parse(neutralizeDangerousBlockKeys(text)));
  } finally {
    for (const [target, descriptors] of guarded) {
      restoreProperties(target, descriptors);
    }
  }
}

/** Die geteilten Objekte, die ein Parse mutieren kann: `Object.prototype` und
 *  `Object` selbst sowie die darin hängenden Objekte und Funktionen (z. B.
 *  `Object.prototype.toString`). Ein Block-Key, der auf ein geerbtes Mitglied
 *  zeigt, füllt sonst nicht den geparsten Knoten, sondern das geteilte Objekt,
 *  und das Zurücksetzen der Referenz allein würde die Mutation dort nicht
 *  rückgängig machen. */
function guardedObjects(): object[] {
  const targets = new Set<object>([Object.prototype, Object]);
  for (const root of [Object.prototype, Object]) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(root))) {
      const value: unknown = descriptor.value;
      if (typeof value === "object" || typeof value === "function") {
        if (value !== null) targets.add(value);
      }
    }
  }
  return [...targets];
}

/** Setzt genau die eigenen Properties zurück, die vor dem Parse bestanden. */
function restoreProperties(target: object, saved: PropertyDescriptorMap): void {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (!Object.hasOwn(saved, key)) {
      delete (target as Record<string, unknown>)[key];
    }
  }
  for (const [key, descriptor] of Object.entries(saved)) {
    Object.defineProperty(target, key, descriptor);
  }
}

const DANGEROUS_BLOCK_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Zusätzlich alle eigenen Namen von `Object.prototype`: ein Block-Key wie
 *  `"toString"` zeigt über die Prototypkette auf ein geteiltes Objekt. */
const INHERITED_BLOCK_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));

function isGuardedBlockKey(value: string): boolean {
  return DANGEROUS_BLOCK_KEYS.has(value) || INHERITED_BLOCK_KEYS.has(value);
}

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
        expectsKey && isGuardedBlockKey(value) && nextRelevantToken(text, end + 1) === "{";
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

    // Steam-Conditional (`[$WIN32]`) hängt am vorherigen Wert und ist kein
    // Key-/Value-Token. Würde er wie ein Bare-Token zählen, kippte `expectsKey`
    // und der nächste Block-Key liefe ungefiltert durch (R1).
    if (character === "[") {
      const closing = text.indexOf("]", cursor + 1);
      const newline = text.indexOf("\n", cursor + 1);
      const stop = closing !== -1 && (newline === -1 || closing < newline) ? closing + 1 : newline;
      const end = stop === -1 ? text.length : stop;
      output.push(text.slice(cursor, end));
      cursor = end;
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
    // unquotierte Keys sind in VDF erlaubt und damit derselbe vektor wie
    // quotierte (R1).
    const bareValue = text.slice(cursor, end);
    const isBareBlockKey =
      expectsKey && isGuardedBlockKey(bareValue) && nextRelevantToken(text, end) === "{";
    output.push(isBareBlockKey ? `__x_${bareValue}__` : bareValue);
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

// die lib baut plain objects. `sanitize` macht jeden key zu einer eigenen
// property, damit `getKeyInsensitive` (nutzt `in`) nicht in die kette greift.
// Es ist KEIN pollutionsschutz: den leistet allein der pre-pass oben, weil die
// mutation sonst schon während parse() passiert wäre.
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
