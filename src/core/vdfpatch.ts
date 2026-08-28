// chirurgischer VDF-string-patch: ändert nur den ziel-wert, der rest der datei bleibt
// byte-für-byte erhalten. grund: voll-serialize mit @node-steam/vdf escaped nicht
// (`"`/`\` zerstören die datei still) und sortiert numerische keys (appIds) um
// Vollständiges Serialisieren würde Dateien deshalb still beschädigen.

export class VdfPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VdfPatchError";
  }
}

interface Token {
  kind: "string" | "open" | "close";
  value: string; // für string: unescaped inhalt (ohne quotes)
  start: number; // roh-start inkl. quotes
  end: number; // roh-ende (exkl.)
}

interface Entry {
  key: Token;
  value: Token;
  /** token-index-range des block-inhalts (ohne die braces selbst). */
  block?: { from: number; to: number };
}

// valve escaped beim schreiben nur `"` und `\`; andere `\x`-folgen bleiben literal.
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

function escapeValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function quote(v: string): string {
  return `"${escapeValue(v)}"`;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "/" && text.charAt(i + 1) === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i++;
      continue;
    }
    if (c === "/" && text.charAt(i + 1) === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new VdfPatchError("unterminierter block-kommentar");
      i = end + 2;
      continue;
    }
    if (c === "{" || c === "}") {
      tokens.push({ kind: c === "{" ? "open" : "close", value: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let raw = "";
      while (i < text.length && text.charAt(i) !== '"') {
        if (text.charAt(i) === "\\" && i + 1 < text.length) {
          raw += text.charAt(i) + text.charAt(i + 1);
          i += 2;
        } else {
          raw += text.charAt(i);
          i++;
        }
      }
      if (i >= text.length) throw new VdfPatchError("unterminierter string");
      i++; // closing quote
      tokens.push({ kind: "string", value: unescapeRaw(raw), start, end: i });
      continue;
    }
    // bare token: unquoted key/value (alte dateien) oder [conditional]-marker
    const start = i;
    while (i < text.length && !' \t\r\n"{}'.includes(text.charAt(i))) i++;
    tokens.push({ kind: "string", value: text.slice(start, i), start, end: i });
  }
  return tokens;
}

function tokenAt(tokens: Token[], idx: number): Token {
  const t = tokens[idx];
  if (!t) throw new VdfPatchError(`interner indexfehler bei token ${idx}`);
  return t;
}

// direkte einträge eines token-range (ein block-inhalt bzw. top-level).
// wirft bei strukturbruch, lieber vor dem schreiben sterben als halb patchen.
function scanEntries(tokens: Token[], from: number, to: number): Entry[] {
  const entries: Entry[] = [];
  let i = from;
  while (i < to) {
    const t = tokenAt(tokens, i);
    if (t.kind === "string" && t.value.startsWith("[")) {
      i++; // [conditional]-marker nach wert/block: gehört zum vorigen eintrag
      continue;
    }
    if (t.kind !== "string") {
      throw new VdfPatchError(`unerwartetes "${t.value}" (offset ${t.start})`);
    }
    if (i + 1 >= to) throw new VdfPatchError(`key "${t.value}" ohne wert`);
    const next = tokenAt(tokens, i + 1);
    if (next.kind === "open") {
      let depth = 1;
      let j = i + 2;
      while (j < to && depth > 0) {
        const tj = tokenAt(tokens, j);
        if (tj.kind === "open") depth++;
        else if (tj.kind === "close") depth--;
        j++;
      }
      if (depth !== 0) throw new VdfPatchError(`unbalancierte klammern bei "${t.value}"`);
      entries.push({ key: t, value: next, block: { from: i + 2, to: j - 1 } });
      i = j;
      continue;
    }
    if (next.kind === "close") throw new VdfPatchError(`key "${t.value}" ohne wert`);
    entries.push({ key: t, value: next });
    i += 2;
  }
  return entries;
}

function findEntry(tokens: Token[], from: number, to: number, key: string): Entry | undefined {
  const lower = key.toLowerCase(); // steam schreibt keys mal groß, mal klein
  return scanEntries(tokens, from, to).find((e) => e.key.value.toLowerCase() === lower);
}

function splice(text: string, start: number, end: number, insert: string): string {
  return text.slice(0, start) + insert + text.slice(end);
}

// rendert einen fehlenden pfad komplett (verschachtelte blöcke), im steam-stil (tabs).
function renderEntries(keys: readonly string[], value: string, indent: string): string {
  const key = keys[0];
  if (key === undefined) throw new VdfPatchError("interner fehler: leerer restpfad");
  const head = `${indent}${quote(key)}`;
  if (keys.length === 1) return `${head}\t\t${quote(value)}\n`;
  return `${head}\n${indent}{\n${renderEntries(keys.slice(1), value, `${indent}\t`)}${indent}}\n`;
}

// einfügepunkt am scope-ende: vor der zeile der schließenden klammer bzw. ans dateiende.
function insertionPoint(
  text: string,
  tokens: Token[],
  closeIdx: number,
): { pos: number; prefix: string; indent: string } {
  if (closeIdx >= tokens.length) {
    // top-level scope
    const prefix = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    return { pos: text.length, prefix, indent: "" };
  }
  const close = tokenAt(tokens, closeIdx);
  const lineStart = text.lastIndexOf("\n", close.start - 1) + 1;
  const closingIndent = text.slice(lineStart, close.start);
  if (!/^[ \t]*$/.test(closingIndent)) {
    // steam schreibt `}` immer auf eine eigene zeile; alles andere ist verdächtig
    throw new VdfPatchError("schließende klammer nicht auf eigener zeile, abbruch");
  }
  return { pos: lineStart, prefix: "", indent: `${closingIndent}\t` };
}

function setInScope(
  text: string,
  tokens: Token[],
  from: number,
  to: number,
  keys: readonly string[],
  value: string,
): string {
  const key = keys[0];
  if (key === undefined) throw new VdfPatchError("interner fehler: leerer restpfad");
  const entry = findEntry(tokens, from, to, key);
  if (entry) {
    if (keys.length === 1) {
      if (entry.block) throw new VdfPatchError(`"${key}" ist ein block, kein wert`);
      if (entry.value.value === value) return text; // no-op → byte-identisch (akzeptanzkriterium)
      return splice(text, entry.value.start, entry.value.end, quote(value));
    }
    if (!entry.block) throw new VdfPatchError(`"${key}" ist ein wert, kein block`);
    return setInScope(text, tokens, entry.block.from, entry.block.to, keys.slice(1), value);
  }
  const { pos, prefix, indent } = insertionPoint(text, tokens, to);
  return splice(text, pos, pos, prefix + renderEntries(keys, value, indent));
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

/**
 * setzt den skalaren wert am pfad: ersetzt nur die value-span, legt fehlende
 * keys/blöcke an, no-op liefert den originaltext. wirft VdfPatchError bei
 * strukturbruch, die datei wird dabei nie angerührt (reine string-funktion).
 */
export function setVdfValue(text: string, path: readonly string[], value: string): string {
  if (path.length === 0) throw new VdfPatchError("leerer pfad");
  if (/\r|\n/.test(value)) throw new VdfPatchError("wert darf keine zeilenumbrüche enthalten");
  const tokens = tokenize(text);
  return setInScope(text, tokens, 0, tokens.length, path, value);
}

function removeInScope(
  text: string,
  tokens: Token[],
  from: number,
  to: number,
  keys: readonly string[],
): string {
  const key = keys[0];
  if (key === undefined) return text;
  const entry = findEntry(tokens, from, to, key);
  if (!entry) return text;

  if (keys.length > 1) {
    if (!entry.block) throw new VdfPatchError(`"${key}" ist ein wert, kein block`);
    return removeInScope(text, tokens, entry.block.from, entry.block.to, keys.slice(1));
  }

  let end = entry.value.end;
  if (entry.block) {
    const closeToken = tokenAt(tokens, entry.block.to);
    end = closeToken.end;
  }

  // präfix-fraß-schutz: bei nicht-zeilenformatierter datei (kein \n vor dem
  // key) wäre lineStart = 0 und der splice fräße den gesamten präfix bis zum
  // block-ende. wirf nur, wenn zwischen zeilenbeginn und key nicht-nur-
  // whitespace liegt (indent-tabs sind legitim, echter content ist es nicht);
  // ein key bei offset 0 bleibt ebenfalls legitim.
  const rawLineStart = text.lastIndexOf("\n", entry.key.start - 1) + 1;
  const between = text.slice(rawLineStart, entry.key.start);
  if (/[^ \t]/.test(between)) {
    throw new VdfPatchError(`"${key}" beginnt nicht auf eigener zeile, strukturbruch`);
  }
  // ab zeilenbeginn entfernen (inkl. indent): der indent gehört zur entfernten
  // zeile, ein whitespace-rest würde vom rust-patchpfad (vdf_patch.rs) nicht
  // hinterlassen und die golden-fixture würde die abweichung melden.
  const lineStart = rawLineStart;
  let trailEnd = end;
  while (trailEnd < text.length && " \t\r".includes(text.charAt(trailEnd))) trailEnd++;
  if (trailEnd < text.length && text.charAt(trailEnd) === "\n") trailEnd++;

  return splice(text, lineStart, trailEnd, "");
}

/** entfernt den key+block/scalar am pfad. no-op wenn der pfad nicht existiert.
 *  wirft VdfPatchError bei strukturbruch. */
export function removeVdfEntry(text: string, path: readonly string[]): string {
  if (path.length === 0) throw new VdfPatchError("leerer pfad");
  const tokens = tokenize(text);
  return removeInScope(text, tokens, 0, tokens.length, path);
}
