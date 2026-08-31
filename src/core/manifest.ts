import { NUMERIC_RE, parseSafeAppId } from "./types.js";
import { asString, getKeyInsensitive, parseVdf } from "./vdf.js";

interface ManifestData {
  appId: number;
  name: string;
  /** Größe aus `SizeOnDisk` im Steam-Appmanifest; fehlend oder ungültig = unbekannt. */
  sizeBytes?: number;
  /** Installationsordner aus `installdir`; fehlend oder unsicher = unbekannt. */
  installdir?: string;
}

type RawManifestToken = { kind: "scalar"; value: string } | { kind: "open" } | { kind: "close" };

interface RawManifestTokenResult {
  token: RawManifestToken;
  next: number;
}

function readRawManifestToken(text: string, start: number): RawManifestTokenResult | undefined {
  let cursor = start;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character !== undefined && character.trim() === "") {
      cursor += 1;
      continue;
    }
    if (character === "/" && text[cursor + 1] === "/") {
      const end = text.indexOf("\n", cursor + 2);
      if (end === -1) return undefined;
      cursor = end + 1;
      continue;
    }
    if (character === "/" && text[cursor + 1] === "*") {
      const end = text.indexOf("*/", cursor + 2);
      if (end === -1) return undefined;
      cursor = end + 2;
      continue;
    }
    break;
  }

  if (cursor >= text.length) return undefined;
  const character = text[cursor];
  if (character === "{") return { token: { kind: "open" }, next: cursor + 1 };
  if (character === "}") return { token: { kind: "close" }, next: cursor + 1 };
  if (character === '"') {
    const valueStart = cursor + 1;
    cursor = valueStart;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor] === '"') {
        return {
          token: { kind: "scalar", value: text.slice(valueStart, cursor) },
          next: cursor + 1,
        };
      }
      cursor += 1;
    }
    return undefined;
  }

  const valueStart = cursor;
  while (cursor < text.length) {
    const current = text[cursor];
    if (
      current === undefined ||
      current.trim() === "" ||
      current === '"' ||
      current === "{" ||
      current === "}" ||
      (current === "/" && (text[cursor + 1] === "/" || text[cursor + 1] === "*"))
    ) {
      break;
    }
    cursor += 1;
  }
  if (valueStart === cursor) return undefined;
  return {
    token: { kind: "scalar", value: text.slice(valueStart, cursor) },
    next: cursor,
  };
}

function rawManifestField(text: string, fieldName: string): RawManifestToken | undefined {
  let cursor = 0;
  let depth = 0;
  let appStateDepth: number | undefined;
  let pendingKey: Extract<RawManifestToken, { kind: "scalar" }> | undefined;
  let fieldToken: RawManifestToken | undefined;
  const normalizedFieldName = fieldName.toLowerCase();

  while (cursor < text.length) {
    const result = readRawManifestToken(text, cursor);
    if (!result) return fieldToken;
    cursor = result.next;
    const token = result.token;

    if (token.kind === "open") {
      if (depth === 0 && pendingKey?.value.toLowerCase() === "appstate") {
        appStateDepth = depth + 1;
      }
      pendingKey = undefined;
      depth += 1;
      continue;
    }
    if (token.kind === "close") {
      depth = Math.max(0, depth - 1);
      pendingKey = undefined;
      if (appStateDepth !== undefined && depth < appStateDepth) appStateDepth = undefined;
      continue;
    }

    if (pendingKey) {
      if (
        appStateDepth !== undefined &&
        depth === appStateDepth &&
        pendingKey.value.toLowerCase() === normalizedFieldName
      ) {
        fieldToken = token;
      }
      pendingKey = undefined;
      continue;
    }
    pendingKey = token;
  }

  return fieldToken;
}

function parseManifestSize(raw: RawManifestToken | undefined): number | undefined {
  if (raw?.kind !== "scalar") return undefined;
  const value = raw.value.trim();

  // Der Parser normalisiert unquoted Dezimal- und Exponentwerte zu Zahlen.
  // Die Rohsyntax bleibt deshalb die Autorität für diesen einzelnen Wert.
  if (!NUMERIC_RE.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}

function parseManifestInstallDir(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value === "." || value === "..") {
    return undefined;
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return undefined;
  return value;
}

// Wirft bei defektem Inhalt oder fehlender App-ID; der Scan meldet eine Warnung.
export function parseManifest(text: string): ManifestData {
  const root = parseVdf(text);
  const app = getKeyInsensitive(root, "AppState");
  if (typeof app !== "object" || app === null) {
    throw new Error("appmanifest ohne AppState-block");
  }
  const appIdRaw = asString(getKeyInsensitive(app, "appid"));
  if (appIdRaw === undefined) throw new Error("appmanifest ohne gültige appid");
  const appId = parseSafeAppId(appIdRaw);
  if (appId === null) throw new Error("appmanifest ohne gültige appid");

  const name = asString(getKeyInsensitive(app, "name")) ?? `app ${appId}`;
  const sizeBytes = parseManifestSize(rawManifestField(text, "SizeOnDisk"));
  const rawInstalldir = rawManifestField(text, "installdir");
  const installdir = parseManifestInstallDir(
    rawInstalldir?.kind === "scalar" ? rawInstalldir.value : undefined,
  );

  return { appId, name, sizeBytes, installdir };
}
