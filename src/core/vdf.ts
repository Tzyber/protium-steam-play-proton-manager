// Wrapper um `@node-steam/vdf`: Ein Austausch der Bibliothek betrifft nur diese Datei.
import { parse } from "@node-steam/vdf";
import { tokenizeVdf } from "./vdfpatch.js";

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
  //
  // Der Vorabtest spart das Containment für die weit überwiegende Zahl der
  // Dateien: steht keiner der Namen im Text, kann kein Block-Key ein geteiltes
  // Objekt füllen. Gemessen kostet das Containment 0,05 ms pro Parse, der
  // Vorabtest 0,0001 ms, und ein Scan parst hunderte Manifeste.
  const guarded = GUARDED_PATTERN.test(text) ? snapshotGuarded() : undefined;
  try {
    return sanitize(parse(neutralizeDangerousBlockKeys(text)));
  } finally {
    if (guarded !== undefined) restoreGuarded(guarded);
  }
}

type GuardedSnapshot = readonly (readonly [object, PropertyDescriptorMap])[];

function snapshotGuarded(): GuardedSnapshot {
  return guardedObjects().map(
    (target) => [target, Object.getOwnPropertyDescriptors(target)] as const,
  );
}

function restoreGuarded(snapshot: GuardedSnapshot): void {
  for (const [target, descriptors] of snapshot) {
    restoreProperties(target, descriptors);
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

/** Block-Keys, die nicht den geparsten Knoten füllen, sondern ein geteiltes
 *  Objekt: `__proto__` und `constructor` sind eigene Namen von
 *  `Object.prototype`, `prototype` hängt an jedem Funktionsobjekt, und
 *  `toString` und Verwandte zeigen über die Prototypkette ebenfalls dorthin. */
const GUARDED_BLOCK_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);

/** Ein Durchlauf über den Text entscheidet, ob das Containment nötig ist. Die
 *  Namen bestehen nur aus Wortzeichen, das Muster braucht keine Maskierung. */
const GUARDED_PATTERN = new RegExp([...GUARDED_BLOCK_KEYS].join("|"));

function neutralizeDangerousBlockKeys(text: string): string {
  const { tokens } = tokenizeVdf(text);
  const output: string[] = [];
  let cursor = 0;
  let expectsKey = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    // trivia (whitespace, kommentare) liegt zwischen den tokens und wird roh
    // übernommen, damit der pre-pass den text außerhalb der keys nicht umformt.
    if (token.start > cursor) output.push(text.slice(cursor, token.start));

    if (token.kind === "string") {
      // unquotierte keys sind in VDF erlaubt und damit derselbe vektor wie
      // quotierte (R1). der nächste signifikante token ist der nächste
      // listen-eintrag, weil trivia nicht als token geführt wird.
      const isBlockKey =
        expectsKey && GUARDED_BLOCK_KEYS.has(token.raw) && tokens[index + 1]?.kind === "open";
      if (isBlockKey) {
        output.push(token.quoted ? `"__x_${token.raw}__"` : `__x_${token.raw}__`);
      } else {
        output.push(text.slice(token.start, token.end));
      }
      expectsKey = !expectsKey;
    } else {
      output.push(text.slice(token.start, token.end));
      // klammern setzen den key-zustand zurück; ein conditional hängt am
      // vorigen wert und zählt nicht, deshalb dort kein flip (R1).
      if (token.kind === "open" || token.kind === "close") expectsKey = true;
    }
    cursor = token.end;
  }

  // offener string oder offenes blockkommentar: die restfolge fehlt in `tokens`
  // und wird roh angehängt, damit der pre-pass nichts verliert.
  if (cursor < text.length) output.push(text.slice(cursor));
  return output.join("");
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
