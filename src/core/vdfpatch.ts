// doppelfunktion der datei: bytegenauer VDF-leser für den string-patch-pfad
// (getVdfValue; das patchen selbst lebt in rust, vdf_patch.rs) und gemeinsamer
// text-vdf-tokenizer (K-02) für den vdf.ts-pre-pass und manifest.ts.

import { errText } from "./errtext.js";

/** strukturbruch im VDF. der export dient nur den tests: produktiv wird der
 *  fehler nie per `instanceof` gefangen, sondern über `errText` klassifiziert (K-13). */
export class VdfPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VdfPatchError";
  }
}

/** Signifikante VDF-tokens; trivia (whitespace, zeilen- und blockkommentar)
 *  liegt in den lücken zwischen zwei tokens und wird bei bedarf mit
 *  `text.slice(prev.end, token.start)` rekonstruiert. */
type VdfTokenKind = "string" | "open" | "close" | "conditional";

interface VdfToken {
  kind: VdfTokenKind;
  /** roh-inhalt ohne quotes; escapes (`\"`, `\\`, sonstige `\x`) bleiben
   *  erhalten. autorität für rohe key-/manifest-vergleiche. */
  raw: string;
  /** valve-entschärfter string (`\"`→`"`, `\\`→`\`, sonst literal); bei
   *  open/close/conditional identisch zu `raw`. */
  value: string;
  /** offset des token-anfangs im text (inkl. öffnendem quote). */
  start: number;
  /** offset hinter dem token-ende. */
  end: number;
  /** true, wenn der token in quotes geschrieben war. */
  quoted: boolean;
}

interface VdfTokenizeResult {
  tokens: VdfToken[];
  /** gesetzt, wenn der text mitten in einem token endet (offener string oder
   *  offenes blockkommentar). die betroffene restfolge fehlt in `tokens`. */
  unterminated: "string" | "block-comment" | undefined;
}

/** Gemeinsamer Text-VDF-Tokenizer (K-02): ersetzt die drei zuvor unabhängigen
 *  lexer in `vdfpatch.ts`, `manifest.ts` und `vdf.ts`. bewusst nicht-werfend,
 *  weil die aufrufer sich beim abbruch unterscheiden: `vdfpatch.ts` wirft bei
 *  einem unterminierten token, `manifest.ts`/`vdf.ts` brechen ab und übernehmen
 *  den rest roh. die entscheidungen bei den zuvor abweichenden fällen stehen
 *  jeweils an der stelle. */
export function tokenizeVdf(text: string): VdfTokenizeResult {
  const tokens: VdfToken[] = [];
  let unterminated: VdfTokenizeResult["unterminated"];
  let cursor = 0;

  while (cursor < text.length) {
    const character = text[cursor];

    if (isVdfWhitespace(character)) {
      cursor += 1;
      continue;
    }

    if (character === "/" && text[cursor + 1] === "/") {
      const newline = text.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? text.length : newline + 1;
      continue;
    }

    if (character === "/" && text[cursor + 1] === "*") {
      const close = text.indexOf("*/", cursor + 2);
      if (close === -1) {
        unterminated = "block-comment";
        cursor = text.length;
        break;
      }
      cursor = close + 2;
      continue;
    }

    if (character === "{") {
      tokens.push({
        kind: "open",
        raw: "{",
        value: "{",
        start: cursor,
        end: cursor + 1,
        quoted: false,
      });
      cursor += 1;
      continue;
    }

    if (character === "}") {
      tokens.push({
        kind: "close",
        raw: "}",
        value: "}",
        start: cursor,
        end: cursor + 1,
        quoted: false,
      });
      cursor += 1;
      continue;
    }

    if (character === "[") {
      // steam-conditional `[...]` hängt am vorigen wert und ist kein
      // key-/value-token; würde er zählen, kippte die key-erwartung und ein
      // gefährlicher block-key liefe ungefiltert durch (R1). ein token statt
      // mehrerer bare-tokens hält auch `[$WIN32 || $OSX64]` zusammen; die
      // vorfassung in `vdfpatch.ts` zerlegte solche marker, was hier bewusst
      // vereinheitlicht wird. ende ist `]` oder das zeilenende.
      //
      // WARUM vorwärtsscan statt zwei `indexOf` (A-01): beide suchen liefen ab
      // dem cursor bis ans textende, wenn das gesuchte zeichen fehlt. ohne
      // umbruch kostete damit jeder marker den rest des textes ⇒ O(n²). der
      // scan hier verbraucht genau die zeichen des tokens, der cursor springt
      // danach darüber; die gesamtlaufzeit bleibt linear.
      let end = cursor + 1;
      for (;;) {
        const current = text[end];
        if (current === undefined || current === "]" || current === "\n") break;
        end += 1;
      }
      if (text[end] === "]") end += 1;
      const raw = text.slice(cursor, end);
      tokens.push({ kind: "conditional", raw, value: raw, start: cursor, end, quoted: false });
      cursor = end;
      continue;
    }

    if (character === '"') {
      const start = cursor;
      const contentStart = cursor + 1;
      cursor = contentStart;
      let closed = false;
      while (cursor < text.length) {
        const current = text[cursor];
        if (current === "\\") {
          cursor += 2;
          continue;
        }
        if (current === '"') {
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) {
        unterminated = "string";
        cursor = text.length;
        break;
      }
      const raw = text.slice(contentStart, cursor);
      tokens.push({
        kind: "string",
        raw,
        value: unescapeRaw(raw),
        start,
        end: cursor + 1,
        quoted: true,
      });
      cursor += 1;
      continue;
    }

    // bare token: unquoted key/value (alte dateien). bricht zusätzlich am
    // kommentaranfang ab, damit `value//rest` kein token wird; zwei der drei
    // vorfassungen und die geparste lib tun das, `vdfpatch.ts` tat es zuvor
    // nicht (bewusste vereinheitlichung, K-02).
    const start = cursor;
    while (cursor < text.length) {
      const current = text[cursor];
      if (
        current === undefined ||
        isVdfWhitespace(current) ||
        current === '"' ||
        current === "{" ||
        current === "}" ||
        (current === "/" && (text[cursor + 1] === "/" || text[cursor + 1] === "*"))
      ) {
        break;
      }
      cursor += 1;
    }
    const raw = text.slice(start, cursor);
    tokens.push({ kind: "string", raw, value: raw, start, end: cursor, quoted: false });
    // ein `/*` mitten im bare-token ist wertmüll, kein blockkommentar: der wert
    // bricht wie bei `http://x` → `http:` am kommentaranfang ab und der tote
    // rest endet am zeilenende, auch ohne `*/`. sonst würde ein unterminierter
    // blockkommentar im wert die ganze datei verschlucken und als lexikalisch
    // defekt markieren (N-5). echte blockkommentare stehen nach einem trenner
    // und laufen wie bisher bis `*/`.
    if (text[cursor] === "/" && text[cursor + 1] === "*") {
      const newline = text.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? text.length : newline + 1;
    }
  }

  return { tokens, unterminated };
}

// valve-whitespace ist mehr als ` \t\r\n`: die lib nutzt `trim`, deshalb gilt
// jede von `trim` als leer erkannte einzelstelle als trenner (union der drei
// vorfassungen, die sich hier unterschieden).
function isVdfWhitespace(character: string | undefined): boolean {
  return character !== undefined && character.trim() === "";
}

// valve escaped nur `"` und `\`; andere `\x`-folgen bleiben literal.
function unescapeRaw(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const next = raw.charAt(i + 1);
    if (raw.charAt(i) === "\\" && (next === '"' || next === "\\")) {
      out += next;
      i++;
    } else {
      out += raw.charAt(i);
    }
  }
  return out;
}

interface Entry {
  key: VdfToken;
  value: VdfToken;
  /** token-index-range des block-inhalts (ohne die braces selbst). */
  block?: { from: number; to: number };
}

// vdfpatch ist der bytegenaue leser und meldet einen unterminierten string
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
    // marker zwischen key und wert werden wie in `manifest.ts` ausgelassen
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
    try {
      const fields = new Map<string, string>();
      for (const leafKey of leafKeys) {
        const entry = findEntry(tokens, child.block.from, child.block.to, leafKey);
        if (entry && !entry.block) fields.set(leafKey, entry.value.value);
      }
      // die prüfung liegt hinter dem parse: ein defekter doppelter block wird
      // weiterhin gemeldet, trägt aber keine werte bei.
      if (seen.has(key)) continue;
      seen.add(key);
      // block ohne einen der leafs bleibt draußen, sonst ändert der wrapper sein verhalten
      if (fields.size > 0) values.set(child.key.value, fields);
    } catch (e) {
      if (firstError === null) firstError = errText(e);
    }
  }
  return { values, firstError };
}
