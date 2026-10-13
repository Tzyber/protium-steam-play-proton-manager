// bytegenauer VDF-leser für den string-patch-pfad (getVdfValue; das patchen
// selbst lebt in rust, vdf_patch.rs). der tokenizer liegt in vdfTokenizer.ts.

import { errText } from "./errtext.js";
import { tokenizeVdf, type VdfToken } from "./vdfTokenizer.js";

/** strukturbruch im VDF. der export dient nur den tests: produktiv wird der
 *  fehler nie per `instanceof` gefangen, sondern über `errText` klassifiziert (K-13). */
export class VdfPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VdfPatchError";
  }
}

interface Entry {
  key: VdfToken;
  value: VdfToken;
  /** token-index-range des block-inhalts (ohne die braces selbst). */
  block?: { from: number; to: number };
}

// vdfRead ist der bytegenaue leser und meldet einen unterminierten string
// bzw. blockkommentar als fehler, statt wie manifest/vdf roh abzubrechen.
function tokenize(text: string): VdfToken[] {
  const { tokens, unterminated } = tokenizeVdf(text);
  if (unterminated === "string") throw new VdfPatchError("unterminierter string");
  if (unterminated === "block-comment") throw new VdfPatchError("unterminierter block-kommentar");
  return tokens;
}

function tokenAt(tokens: VdfToken[], idx: number): VdfToken {
  const t = tokens[idx];
  if (!t) throw new VdfPatchError(`interner indexfehler bei token ${idx}`);
  return t;
}

// direkte einträge eines token-range (ein block-inhalt bzw. top-level).
// wirft bei strukturbruch, statt eine unvollständige Struktur zu liefern.
function scanEntries(tokens: VdfToken[], from: number, to: number): Entry[] {
  const entries: Entry[] = [];
  let i = from;
  while (i < to) {
    const t = tokenAt(tokens, i);
    if (t.kind === "conditional") {
      i++; // [conditional]-marker nach wert/block: gehört zum vorigen eintrag
      continue;
    }
    if (t.kind !== "string") {
      throw new VdfPatchError(`unerwartetes "${t.value}" (offset ${t.start})`);
    }
    // marker zwischen key und wert werden wie in `rawVdfField` (vdf.ts) ausgelassen
    // (dort `token.kind === "conditional" continue`): der marker zählt nie als
    // wert. `key [cond] value` paart damit key→value, `key [cond]` ohne echten
    // wert bleibt strukturbruch wie `key` allein (N-01). steam schreibt marker
    // nach dem wert, die fälle sind degeneriert.
    let valueIdx = i + 1;
    while (valueIdx < to && tokenAt(tokens, valueIdx).kind === "conditional") valueIdx++;
    if (valueIdx >= to) throw new VdfPatchError(`key "${t.value}" ohne wert`);
    const next = tokenAt(tokens, valueIdx);
    if (next.kind === "open") {
      let depth = 1;
      let j = valueIdx + 1;
      while (j < to && depth > 0) {
        const tj = tokenAt(tokens, j);
        if (tj.kind === "open") depth++;
        else if (tj.kind === "close") depth--;
        j++;
      }
      if (depth !== 0) throw new VdfPatchError(`unbalancierte klammern bei "${t.value}"`);
      entries.push({ key: t, value: next, block: { from: valueIdx + 1, to: j - 1 } });
      i = j;
      continue;
    }
    if (next.kind === "close") throw new VdfPatchError(`key "${t.value}" ohne wert`);
    entries.push({ key: t, value: next });
    i = valueIdx + 1;
  }
  return entries;
}

function findEntry(tokens: VdfToken[], from: number, to: number, key: string): Entry | undefined {
  const lower = key.toLowerCase(); // steam schreibt keys mal groß, mal klein
  return scanEntries(tokens, from, to).find((e) => e.key.value.toLowerCase() === lower);
}

/** wert am pfad lesen (unescaped, case-insensitive navigation). undefined wenn nicht da. */
export function getVdfValue(text: string, path: readonly string[]): string | undefined {
  const tokens = tokenize(text);
  let from = 0;
  let to = tokens.length;
  for (let depth = 0; depth < path.length; depth++) {
    const key = path[depth];
    if (key === undefined) return undefined;
    const entry = findEntry(tokens, from, to, key);
    if (!entry) return undefined;
    if (depth === path.length - 1) return entry.block ? undefined : entry.value.value;
    if (!entry.block) return undefined;
    from = entry.block.from;
    to = entry.block.to;
  }
  return undefined;
}

/** alle direkten kind-blöcke am pfad in EINEM tokenize-lauf lesen:
 *  blockKey → (angefragter leafKey → wert). leere map, wenn der pfad fehlt.
 *  nur defekte kind-blöcke werden übersprungen und als erster fehler gemeldet,
 *  damit der scan wie bisher degradiert. ein strukturbruch außerhalb der
 *  kind-blöcke (pfadnavigation oder kind-ebene selbst) wirft dagegen, weil
 *  dort kein einzelner block zum überspringen bleibt; den wirf fängt der
 *  aufrufer und degradiert dort (INV-2, N-8). */
export function getVdfChildFieldValues(
  text: string,
  path: readonly string[],
  leafKeys: readonly string[],
): { values: Map<string, Map<string, string>>; firstError: string | null } {
  const tokens = tokenize(text);
  const values = new Map<string, Map<string, string>>();
  let from = 0;
  let to = tokens.length;
  for (let depth = 0; depth < path.length; depth++) {
    const key = path[depth];
    if (key === undefined) return { values, firstError: null };
    const entry = findEntry(tokens, from, to, key);
    const block = entry?.block;
    if (!block) return { values, firstError: null };
    from = block.from;
    to = block.to;
  }
  let firstError: string | null = null;
  // gesehene app-keys werden unabhängig vom treffer gemerkt: die
  // first-match-semantik von `getVdfValue` und des rust-writers gilt auch,
  // wenn der erste block keines der angefragten felder enthält. der
  // schlüsselvergleich läuft wie `findEntry` case-insensitiv.
  const seen = new Set<string>();
  for (const child of scanEntries(tokens, from, to)) {
    if (!child.block) continue;
    const key = child.key.value.toLowerCase();
    // vor dem parse gemerkt: auch ein defekter erster block belegt den key,
    // sonst lieferte ein späteres duplikat die werte.
    const first = !seen.has(key);
    seen.add(key);
    try {
      const fields = new Map<string, string>();
      for (const leafKey of leafKeys) {
        const entry = findEntry(tokens, child.block.from, child.block.to, leafKey);
        if (entry && !entry.block) fields.set(leafKey, entry.value.value);
      }
      // duplikate werden weiter geparst, damit ihr fehler gemeldet wird
      if (!first) continue;
      // block ohne einen der leafs bleibt draußen, sonst ändert der wrapper sein verhalten
      if (fields.size > 0) values.set(child.key.value, fields);
    } catch (e) {
      if (firstError === null) firstError = errText(e);
    }
  }
  return { values, firstError };
}
