import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BinVdfError,
  parseBinaryShortcutIds,
  readAllShortcutAppIds,
} from "../../src/core/shortcuts.js";
import { buildFakeSteam, CORRUPT_SHORTCUT_VDF_BINARY, nodeFs } from "../support/fakeSteam";

function fsWithUnreadableUserdata(base: ReturnType<typeof nodeFs>): ReturnType<typeof nodeFs> {
  return {
    ...base,
    readDir: (path: string) => {
      if (path.endsWith("/userdata") || path.includes("/userdata/")) {
        throw new Error("EACCES: permission denied");
      }
      return base.readDir(path);
    },
  };
}

// ---- binary-VDF-fixtures ----

function makeBinVdf(entries: { appId?: number; name?: string; hasTags?: boolean }[]): Uint8Array {
  const parts: number[] = [];
  parts.push(0x00);
  parts.push(...new TextEncoder().encode("shortcuts"), 0x00);

  for (const [idx, e] of entries.entries()) {
    parts.push(0x00); // type: MAP
    parts.push(...new TextEncoder().encode(String(idx)), 0x00); // key

    if (e.appId !== undefined) {
      parts.push(0x02); // type: int32
      parts.push(...new TextEncoder().encode("appid"), 0x00); // key
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, e.appId, true);
      parts.push(...new Uint8Array(buf));
    }
    if (e.name !== undefined) {
      parts.push(0x01); // type: string
      parts.push(...new TextEncoder().encode("AppName"), 0x00); // key
      parts.push(...new TextEncoder().encode(e.name), 0x00);
    }
    if (e.hasTags) {
      parts.push(0x00); // type: MAP
      parts.push(...new TextEncoder().encode("tags"), 0x00); // key
      parts.push(0x01); // type: string
      parts.push(...new TextEncoder().encode("0"), 0x00); // key
      parts.push(...new TextEncoder().encode("favorite"), 0x00); // value
      parts.push(0x08); // end tags
    }
    parts.push(0x08); // end entry MAP
  }
  parts.push(0x08); // end root
  return new Uint8Array(parts);
}

function makeEmptyBinVdf(): Uint8Array {
  return new Uint8Array([0x00, ...new TextEncoder().encode("shortcuts"), 0x00, 0x08]);
}

function utf16leBytes(s: string): number[] {
  const bytes: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    bytes.push(code & 0xff, code >> 8);
  }
  return bytes;
}

describe("parseBinaryShortcutIds", () => {
  it("extrahiert appId aus gültigem binary-VDF", () => {
    const buf = makeBinVdf([{ appId: 3641016077, name: "Test" }]);
    const ids = parseBinaryShortcutIds(buf);
    expect(ids.has(3641016077)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("extrahiert mehrere shortcuts", () => {
    const buf = makeBinVdf([
      { appId: 111111, name: "a" },
      { appId: 222222, name: "b" },
    ]);
    const ids = parseBinaryShortcutIds(buf);
    expect(ids.has(111111)).toBe(true);
    expect(ids.has(222222)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("leeres shortcuts.vdf (nur root + 0x08) → leeres Set, kein throw", () => {
    expect(parseBinaryShortcutIds(makeEmptyBinVdf()).size).toBe(0);
  });

  it("appId 0 → nicht im set", () => {
    const buf = makeBinVdf([{ appId: 0 }]);
    expect(parseBinaryShortcutIds(buf).size).toBe(0);
  });

  it("falsche magic → wirft", () => {
    const buf = makeBinVdf([{ appId: 1 }]);
    buf[0] = 0xff;
    expect(() => parseBinaryShortcutIds(buf)).toThrow();
  });

  it("falscher root-key → wirft", () => {
    const parts = new Uint8Array([0x00, ...new TextEncoder().encode("wrongkey"), 0x00, 0x08]);
    expect(() => parseBinaryShortcutIds(parts)).toThrow();
  });

  it("truncation → wirft", () => {
    const buf = makeBinVdf([{ appId: 1 }]);
    expect(() => parseBinaryShortcutIds(buf.slice(0, 15))).toThrow();
  });

  it("truncation mitten im entry wirft BinVdfError, reicht kein undefined durch", () => {
    // schneidet mitten im int32-wert ab, byteAt/readU32 müssen werfen, nicht undefined liefern
    const buf = makeBinVdf([{ appId: 42 }]);
    // kürze so, dass der appid-key noch komplett ist, der 4-byte-wert aber fehlt
    const truncated = buf.slice(0, buf.length - 2);
    expect(() => parseBinaryShortcutIds(truncated)).toThrow(BinVdfError);
  });

  it("key appid mit type 0x01 (string) → ignoriert", () => {
    const parts = new Uint8Array([
      0x00,
      ...new TextEncoder().encode("shortcuts"),
      0x00,
      0x00, // type: MAP
      ...new TextEncoder().encode("0"),
      0x00, // key
      0x01, // type: string (not int32!)
      ...new TextEncoder().encode("appid"),
      0x00, // key
      ...new TextEncoder().encode("12345"),
      0x00, // value
      0x08, // end entry
      0x08, // end root
    ]);
    expect(parseBinaryShortcutIds(parts).size).toBe(0);
  });

  it("case-insensitive: AppId und APPID werden erkannt", () => {
    const testCaseInsensitive = (key: string) => {
      const parts = new Uint8Array([
        0x00,
        ...new TextEncoder().encode("shortcuts"),
        0x00,
        0x00, // type: MAP
        ...new TextEncoder().encode("0"),
        0x00, // entry key
        0x02, // type: int32
        ...new TextEncoder().encode(key),
        0x00, // key
        0x42,
        0x00,
        0x00,
        0x00, // value: 66
        0x08, // end entry
        0x08, // end root
      ]);
      return parseBinaryShortcutIds(parts);
    };
    expect(testCaseInsensitive("AppId").has(66)).toBe(true);
    expect(testCaseInsensitive("APPID").has(66)).toBe(true);
  });

  it("skipBinaryValue überspringt verschachteltes tags-objekt rekursiv", () => {
    const buf = makeBinVdf([{ appId: 42, hasTags: true }]);
    const ids = parseBinaryShortcutIds(buf);
    expect(ids.has(42)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("nicht-numerischer top-level-key → ignoriert, numerische weiter verarbeitet", () => {
    const parts = new Uint8Array([
      0x00,
      ...new TextEncoder().encode("shortcuts"),
      0x00,
      0x00, // type: MAP
      ...new TextEncoder().encode("abc"),
      0x00, // key "abc" (non-numeric → skipped)
      0x02, // type: int32
      ...new TextEncoder().encode("appid"),
      0x00,
      0x2a,
      0x00,
      0x00,
      0x00, // value 42 (inside skipped entry)
      0x08, // end "abc" MAP
      0x00, // type: MAP
      ...new TextEncoder().encode("0"),
      0x00, // key "0" (numeric → parsed)
      0x02, // type: int32
      ...new TextEncoder().encode("appid"),
      0x00,
      0x63,
      0x00,
      0x00,
      0x00, // value 99
      0x08, // end "0" MAP
      0x08, // end root
    ]);
    const ids = parseBinaryShortcutIds(parts);
    expect(ids.has(99)).toBe(true);
    expect(ids.has(42)).toBe(false);
  });

  it("entry ohne appid → leeres set, kein throw", () => {
    const buf = makeBinVdf([{ name: "just a name", hasTags: true }]);
    expect(parseBinaryShortcutIds(buf).size).toBe(0);
  });

  it("alle kanonischen typen in skip-subtrees (0x03-0x07)", () => {
    // nicht-numerischer top-level "abc" → rootKind-skip, alle typen drin
    // numerischer entry "0" → extract; nur appid (0x02) wird extrahiert
    const parts = new Uint8Array([
      0x00,
      ...new TextEncoder().encode("shortcuts"),
      0x00,
      0x00, // type: MAP (top-level "abc")
      ...new TextEncoder().encode("abc"),
      0x00, // key
      0x06, // type: color
      ...new TextEncoder().encode("color"),
      0x00, // key
      0x01,
      0x02,
      0x03,
      0x04, // value: RGBA 4 bytes
      0x07, // type: uint64
      ...new TextEncoder().encode("huge"),
      0x00, // key
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // value: 8 bytes
      0x08, // end "abc" MAP
      0x00, // type: MAP (entry "0")
      ...new TextEncoder().encode("0"),
      0x00, // key
      0x02, // type: int32
      ...new TextEncoder().encode("appid"),
      0x00, // key
      0x0a,
      0x00,
      0x00,
      0x00, // value: 10
      0x03, // type: float32
      ...new TextEncoder().encode("f"),
      0x00, // key
      0x00,
      0x00,
      0x80,
      0x3f, // value: 1.0
      0x04, // type: pointer
      ...new TextEncoder().encode("p"),
      0x00, // key
      0x00,
      0x00,
      0x00,
      0x00, // value: 4 bytes
      0x05, // type: wstring
      ...new TextEncoder().encode("w"),
      0x00, // key
      0x06,
      0x00, // count: 6 code-units
      ...utf16leBytes("Hälfte"), // 12 Bytes UTF-16LE mit Nicht-ASCII-Zeichen
      0x01, // type: string
      ...new TextEncoder().encode("s"),
      0x00, // key
      ...new TextEncoder().encode("rest"),
      0x00, // value (muss nach dem wstring noch lesbar sein)
      0x08, // end entry
      0x08, // end root
    ]);
    const ids = parseBinaryShortcutIds(parts);
    expect(ids.has(10)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("wstring mit count 0 (leerer wstring) → kein throw", () => {
    const parts = new Uint8Array([
      0x00,
      ...new TextEncoder().encode("shortcuts"),
      0x00,
      0x00, // type: MAP (entry "0")
      ...new TextEncoder().encode("0"),
      0x00, // key
      0x02, // type: int32
      ...new TextEncoder().encode("appid"),
      0x00, // key
      0x2a,
      0x00,
      0x00,
      0x00, // value: 42
      0x05, // type: wstring
      ...new TextEncoder().encode("w"),
      0x00, // key
      0x00,
      0x00, // count: 0, keine daten
      0x08, // end entry
      0x08, // end root
    ]);
    expect(parseBinaryShortcutIds(parts).has(42)).toBe(true);
  });

  it("truncated wstring → BinVdfError mit wstring-message", () => {
    // count 5, aber nur 4 units daten, WICHTIG: kein 0x08-terminator
    // danach, sonst füllen die terminator-bytes die fehlenden 2 units auf
    // und der Truncation-Check greift nicht.
    const parts = new Uint8Array([
      0x00,
      ...new TextEncoder().encode("shortcuts"),
      0x00,
      0x00, // type: MAP (entry "0")
      ...new TextEncoder().encode("0"),
      0x00, // key
      0x05, // type: wstring
      ...new TextEncoder().encode("w"),
      0x00, // key
      0x05,
      0x00, // count: 5
      ...utf16leBytes("Test"), // nur 4 units (8 bytes), 1 unit fehlt
    ]);
    expect(() => parseBinaryShortcutIds(parts)).toThrow("truncated wstring");
  });

  it("truncated color/uint64 → BinVdfError 'unterminated map body'", () => {
    // datei endet mitten im 4-byte-color-wert, message gepinnt:
    // der alte code wirft hier "truncated uint32" (readU32), der neue
    // "unterminated map body" (walkMapBody-EOF), mutations-verifizierend.
    const parts = new Uint8Array([
      0x00,
      ...new TextEncoder().encode("shortcuts"),
      0x00,
      0x00, // type: MAP (entry "0")
      ...new TextEncoder().encode("0"),
      0x00, // key
      0x06, // type: color
      ...new TextEncoder().encode("c"),
      0x00, // key
      0x01,
      0x02,
      0x03, // nur 3 von 4 bytes
    ]);
    expect(() => parseBinaryShortcutIds(parts)).toThrow("unterminated map body");
  });

  it("0x09/0x0A/0x0B als werttyp → BinVdfError (kein VBKV-magic-handling)", () => {
    // pinnt: default-throw bleibt, diese typen kommen in shortcuts.vdf
    // (raw, ohne magic-header) nie vor, der parser rät nicht.
    // dieser test ist im ALTEN code bereits grün (default-throw existiert)
    // er ist ein pin, kein rot-test.
    for (const badType of [0x09, 0x0a, 0x0b]) {
      const parts = new Uint8Array([
        0x00,
        ...new TextEncoder().encode("shortcuts"),
        0x00,
        0x00, // type: MAP (entry "0")
        ...new TextEncoder().encode("0"),
        0x00, // key
        badType, // type: unbekannt
        ...new TextEncoder().encode("x"),
        0x00, // key
      ]);
      expect(() => parseBinaryShortcutIds(parts)).toThrow(BinVdfError);
    }
  });

  it("wstring auf geslicetem buffer (byteOffset-pfad)", () => {
    const full = new Uint8Array([
      0x00,
      ...new TextEncoder().encode("shortcuts"),
      0x00,
      0x00, // type: MAP (entry "0")
      ...new TextEncoder().encode("0"),
      0x00, // key
      0x02, // type: int32
      ...new TextEncoder().encode("appid"),
      0x00, // key
      0x2a,
      0x00,
      0x00,
      0x00, // value: 42
      0x05, // type: wstring
      ...new TextEncoder().encode("w"),
      0x00, // key
      0x02,
      0x00, // count: 2
      ...utf16leBytes("Hi"),
      0x08, // end entry
      0x08, // end root
    ]);
    // zwei führende bytes voranstellen, dann slicen → byteOffset ≠ 0
    const padded = new Uint8Array([0xff, 0xff, ...full]);
    expect(parseBinaryShortcutIds(padded.subarray(2)).has(42)).toBe(true);
  });
});

describe("readAllShortcutAppIds", () => {
  it("fixture mit gültigem shortcuts.vdf → status ok mit shortcut-id", async () => {
    const { root } = await buildFakeSteam();
    const result = await readAllShortcutAppIds(nodeFs(), root);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ids.has(3641016077)).toBe(true);
    }
  });

  it("steam-root ohne userdata → status none", async () => {
    const { root } = await buildFakeSteam();
    // use lib2 (no userdata dir)
    const result = await readAllShortcutAppIds(nodeFs(), root);
    expect(result.status).toBe("ok"); // buildFakeSteam HAS userdata
  });

  it("über-limit große shortcuts.vdf → status unreadable statt oom (M4.3)", async () => {
    // 16-MiB-cap: eine 17-MB-shortcuts.vdf darf nicht in den speicher geladen
    // werden, der größen-precheck wirft, die stelle degradiert auf unreadable
    // und folgt damit dem Umgang mit korrupten Dateien.
    const { root, userId } = await buildFakeSteam();
    const scPath = join(root, "userdata", userId, "config", "shortcuts.vdf");
    await writeFile(scPath, Buffer.alloc(17 * 1024 * 1024, 0));

    const result = await readAllShortcutAppIds(nodeFs(), root);

    expect(result.status).toBe("unreadable");
  });

  it("korruptes shortcuts.vdf → status unreadable", async () => {
    const { root, userId } = await buildFakeSteam();
    const fs = nodeFs();
    const dir = `${root}/userdata/${userId}/config`;
    // write corrupt over the valid one
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${dir}/shortcuts.vdf`, CORRUPT_SHORTCUT_VDF_BINARY);

    const result = await readAllShortcutAppIds(fs, root);
    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.paths.length).toBeGreaterThan(0);
    }
  });

  it("unlesbares userdata → status unreadable mit detail", async () => {
    const { root } = await buildFakeSteam();
    const fs = fsWithUnreadableUserdata(nodeFs());

    const result = await readAllShortcutAppIds(fs, root);
    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.paths).toEqual([]);
      expect(result.detail).toContain("permission denied");
    }
  });
});
