import { errText } from "./errtext.js";
import { paths } from "./paths.js";
import type { DirEntry, FileSystem } from "./ports.js";
import { NUMERIC_RE } from "./types.js";

export const SHORTCUT_ID_THRESHOLD = 2_147_483_648; // 2^31

export type ShortcutResult =
  | { status: "none" }
  | { status: "ok"; ids: Set<number> }
  | { status: "unreadable"; paths: string[]; detail?: string };

// ---- binär-VDF-minimalparser (nur appid-extraktion) ----
// format: TYPE-KEY-VALUE (typ-byte VOR dem key-string)
// typen nach kanonischer Valve-binary-VDF-tabelle (ValveKeyValue/SteamKit2,
// wstring-layout nach VDC-wiki); 0x09 ist ein wiki-only-compiled-typ,
// 0x0A/0x0B nur mit VBKV-magic-header, shortcuts.vdf hat keinen → alle
// drei default-throw. echte dateien nutzen nur 0x00/0x01/0x02/0x08, aber
// die tabelle muss stimmen: werte nicht raten.

const td = new TextDecoder();

class BinVdfError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BinVdfError";
  }
}

/** liest ein byte an `pos`. wirft, statt `undefined` weiterzugeben
 *  der parser bricht bei strukturbruch ab, er rät nicht. */
function byteAt(buf: Uint8Array, pos: number): number {
  const b = buf[pos];
  if (b === undefined) throw new BinVdfError("truncated: read past end of buffer");
  return b;
}

function readCString(buf: Uint8Array, pos: number): { str: string; next: number } {
  const end = buf.indexOf(0, pos);
  if (end === -1) throw new BinVdfError("unterminated string");
  return { str: td.decode(buf.slice(pos, end)), next: end + 1 };
}

function readU32(buf: Uint8Array, pos: number): { value: number; next: number } {
  if (pos + 4 > buf.length) throw new BinVdfError("truncated uint32");
  const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
  return { value: dv.getUint32(0, true), next: pos + 4 };
}

/**
 * überspringt den wert ab `pos` (type-byte wurde bereits konsumiert).
 * rekursiv für type 0x00 (MAP). TYPE-KEY-VALUE-ordnung.
 */
function skipBinaryValue(buf: Uint8Array, pos: number, type: number): number {
  switch (type) {
    case 0x00:
      // map-body ohne regeln: alles überspringen, dieselbe iteration wie
      // walkMapBody, damit die zwei map-body-schleifen nicht driften können
      return walkMapBody(
        buf,
        pos,
        () => "skip",
        () => {},
      );
    case 0x01:
      return readCString(buf, pos).next;
    case 0x02:
    case 0x03:
    case 0x04:
      return pos + 4;
    case 0x05: {
      // WSTRING: u16-LE char-count (ohne null-terminator) + count × UTF-16LE
      if (pos + 2 > buf.length) throw new BinVdfError("truncated wstring");
      const count = new DataView(buf.buffer, buf.byteOffset + pos, 2).getUint16(0, true);
      if (pos + 2 + count * 2 > buf.length) throw new BinVdfError("truncated wstring");
      return pos + 2 + count * 2;
    }
    case 0x06:
      return pos + 4;
    case 0x07:
      return pos + 8;
    default:
      throw new BinVdfError(`unknown type 0x${type.toString(16)}`);
  }
}

/** was der walker mit einem eintrag tut. */
type WalkKind = "skip" | "extract" | "appid";

/** regelwerk pro ebene: entscheidet anhand von (typ, key), wie der wert behandelt wird. */
type WalkKindFn = (type: number, key: string) => WalkKind;

/** root-ebene: nur maps mit numerischem key sind shortcut-einträge. */
const rootKind: WalkKindFn = (type, key) =>
  type === 0x00 && NUMERIC_RE.test(key) ? "extract" : "skip";

/** eintrags-ebene: nur "appid" mit int32 zählt, case-insensitive, wie Valve schreibt. */
const entryKind: WalkKindFn = (type, key) =>
  key.toLowerCase() === "appid" && type === 0x02 ? "appid" : "skip";

/**
 * walkt einen MAP-body (TYPE-KEY-VALUE). `pos` zeigt auf das erste
 * child-typ-byte. "extract" steigt in einen MAP-wert ab, dort gilt das
 * eintrags-regelwerk. "appid" liest einen u32 und meldet ihn über onEntry.
 */
function walkMapBody(
  buf: Uint8Array,
  pos: number,
  kindOf: WalkKindFn,
  onEntry: (appId: number) => void,
): number {
  while (pos < buf.length) {
    if (buf[pos] === 0x08) return pos + 1; // MAP-ende
    const type = byteAt(buf, pos);
    pos++;
    const key = readCString(buf, pos);
    pos = key.next;

    switch (kindOf(type, key.str)) {
      case "extract":
        pos = walkMapBody(buf, pos, entryKind, onEntry);
        break;
      case "appid": {
        const { value, next } = readU32(buf, pos);
        if (value > 0) onEntry(value); // appid 0 gibt es nicht, nie melden
        pos = next;
        break;
      }
      default:
        pos = skipBinaryValue(buf, pos, type);
    }
  }
  throw new BinVdfError("unterminated map body");
}

/**
 * extrahiert appIds aus binärem shortcuts.vdf.
 * wirft BinVdfError bei strukturbruch, caller entscheidet "unreadable".
 * @internal, nur intern + für tests exportiert; produktion ruft readAllShortcutAppIds.
 */
function parseBinaryShortcutIds(buf: Uint8Array): Set<number> {
  const ids = new Set<number>();
  if (buf.length === 0 || buf[0] !== 0x00) throw new BinVdfError("missing magic byte");

  let pos = 1;
  const root = readCString(buf, pos);
  pos = root.next;
  if (root.str.toLowerCase() !== "shortcuts")
    throw new BinVdfError(`unexpected root key: ${root.str}`);

  // root-body: TYPE-KEY-VALUE kinder. nur 0x00 (MAP) mit numerischem key interessiert uns.
  walkMapBody(buf, pos, rootKind, (appId) => ids.add(appId));
  return ids;
}

// ---- filesystem-integration ----

export async function readAllShortcutAppIds(
  fs: FileSystem,
  steamRoot: string,
): Promise<ShortcutResult> {
  const ids = new Set<number>();
  const unreadable: string[] = [];
  let anyExists = false;

  const dir = paths.userdataDir(steamRoot);
  let dirExists: boolean;
  try {
    dirExists = await fs.exists(dir);
  } catch (e) {
    return { status: "unreadable", paths: [], detail: errText(e) };
  }
  if (!dirExists) return { status: "none" };

  let entries: DirEntry[];
  try {
    entries = await fs.readDir(dir);
  } catch (e) {
    return { status: "unreadable", paths: [], detail: errText(e) };
  }

  for (const entry of entries) {
    if (!entry.isDirectory || !NUMERIC_RE.test(entry.name)) continue;
    const scPath = paths.shortcutsVdf(steamRoot, entry.name);
    if (!(await fs.exists(scPath))) continue;

    anyExists = true;
    try {
      const buf = await fs.readFile(scPath);
      const shortcutIds = parseBinaryShortcutIds(buf);
      for (const id of shortcutIds) ids.add(id);
    } catch {
      unreadable.push(scPath);
    }
  }

  if (unreadable.length > 0) return { status: "unreadable", paths: unreadable };
  if (!anyExists) return { status: "none" };
  return { status: "ok", ids };
}

export { BinVdfError, parseBinaryShortcutIds };
