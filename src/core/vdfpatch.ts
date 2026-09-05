// minimaler VDF-reader: navigiert ohne voll-serialisierung durch Steam-Dateien.

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
// wirft bei strukturbruch, statt eine unvollständige Struktur zu liefern.
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
