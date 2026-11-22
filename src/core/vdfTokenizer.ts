// gemeinsamer text-vdf-tokenizer (K-02) für `vdfRead.ts` (bytegenauer leser
// im string-patch-pfad). das patchen selbst lebt in rust, vdf_patch.rs.

/** Signifikante VDF-tokens; trivia (whitespace, zeilen- und blockkommentar)
 *  liegt in den lücken zwischen zwei tokens und wird bei bedarf mit
 *  `text.slice(prev.end, token.start)` rekonstruiert. */
type VdfTokenKind = "string" | "open" | "close" | "conditional";

export interface VdfToken {
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
  /** gesetzt, wenn der text den token- oder tiefen-cap überschreitet (P12a).
   *  der betroffene rest fehlt in `tokens`; die aufrufer behandeln das wie
   *  `unterminated` (rest roh) oder brechen mit `vdf-limit` ab. */
  limitExceeded: "tokens" | "depth" | undefined;
}

/** P12a: tiefen-cap. Steam-Dateien liegen bei wenigen Ebenen. */
const MAX_DEPTH = 256;

/** Gemeinsamer Text-VDF-Tokenizer (K-02): ersetzt die zuvor unabhängigen
 *  Lexer (`vdfpatch.ts`/`manifest.ts`). Bewusst nicht-werfend, weil `vdfRead.ts`
 *  unter anderem kaputte Teilblöcke separat klassifiziert und Fehler erst dort
 *  ausgelöst werden. */
export function tokenizeVdf(text: string): VdfTokenizeResult {
  // P12a: ein token braucht mindestens ein zeichen, deshalb liegt der cap bei
  // der halben textlänge plus kopfraum. er deckelt die arbeit eines
  // token-dichten stroms ("{}"), ohne legitime dateien zu treffen.
  // `text.length` zählt UTF-16-code-einheiten, das rust-pendant (`tokenize` in
  // vdf_patch.rs) bytes: bei nicht-ASCII-text liegt der cap hier tiefer, TS ist
  // damit strenger, nie laxer.
  const maxTokens = Math.floor(text.length / 2) + 16;
  const tokens: VdfToken[] = [];
  let unterminated: VdfTokenizeResult["unterminated"];
  let limitExceeded: VdfTokenizeResult["limitExceeded"];
  let depth = 0;
  let cursor = 0;

  const pushToken = (token: VdfToken): void => {
    tokens.push(token);
    if (tokens.length > maxTokens) limitExceeded = "tokens";
  };

  // die bedingung beendet den walk, sobald ein cap greift; der rest des textes
  // bleibt damit roh (wie bei `unterminated`).
  while (cursor < text.length && limitExceeded === undefined) {
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
      depth += 1;
      if (depth > MAX_DEPTH) {
        limitExceeded = "depth";
        break;
      }
      pushToken({
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
      // ein `}` ohne offene klammer zählt nicht negativ: die tiefe ist eine
      // schranke gegen verschachtelung, keine bilanzprüfung.
      depth = Math.max(0, depth - 1);
      pushToken({
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
      pushToken({ kind: "conditional", raw, value: raw, start: cursor, end, quoted: false });
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
      pushToken({
        kind: "string",
        raw,
        value: unescapeVdfRaw(raw),
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
    pushToken({ kind: "string", raw, value: raw, start, end: cursor, quoted: false });
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

  return { tokens, unterminated, limitExceeded };
}

// valve-whitespace ist mehr als ` \t\r\n`: die lib nutzt `trim`, deshalb gilt
// jede von `trim` als leer erkannte einzelstelle als trenner (union der drei
// vorfassungen, die sich hier unterschieden).
function isVdfWhitespace(character: string | undefined): boolean {
  return character !== undefined && character.trim() === "";
}

// valve escaped nur `"` und `\`; andere `\x`-folgen bleiben literal.
export function unescapeVdfRaw(raw: string): string {
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
