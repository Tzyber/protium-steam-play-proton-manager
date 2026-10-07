import { ManifestParseError } from "./errors.js";
import { errText } from "./errtext.js";
import { NUMERIC_RE, parseSafeAppId } from "./types.js";
import { getKeyInsensitive, parseVdf, rawVdfField, unescapeVdfRaw } from "./vdf.js";

interface ManifestData {
  appId: number;
  name: string;
  /** Größe aus `SizeOnDisk` im Steam-Appmanifest; fehlend oder ungültig = unbekannt. */
  sizeBytes?: number;
  /** Installationsordner aus `installdir`; fehlend oder unsicher = unbekannt. */
  installdir?: string;
}

function parseManifestSize(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();

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
  let root: ReturnType<typeof parseVdf>;
  try {
    root = parseVdf(text);
  } catch (e) {
    throw new ManifestParseError("manifest-missing-appstate", errText(e));
  }
  const app = getKeyInsensitive(root, "AppState");

  if (typeof app !== "object" || app === null) {
    throw new ManifestParseError("manifest-missing-appstate");
  }
  // Rohwert, nicht der typisierte Bibliothekswert: `"0x2A"` darf nicht 42 werden,
  // `"007"` und `"true"` bleiben im Namen Strings (A-15). Die Grenze selbst ist
  // weiter `parseSafeAppId` (Ziffern plus 1..u32::MAX), keine zweite Prüfung.
  const appIdRaw = rawVdfField(text, ["AppState", "appid"]);
  if (appIdRaw === undefined) {
    throw new ManifestParseError("manifest-invalid-appid");
  }
  const appId = parseSafeAppId(appIdRaw);
  if (appId === null) {
    throw new ManifestParseError("manifest-invalid-appid");
  }

  const nameRaw = rawVdfField(text, ["AppState", "name"]);
  const name = nameRaw === undefined ? `app ${appId}` : unescapeVdfRaw(nameRaw);
  const sizeBytes = parseManifestSize(rawVdfField(text, ["AppState", "SizeOnDisk"]));
  const installdir = parseManifestInstallDir(rawVdfField(text, ["AppState", "installdir"]));

  return { appId, name, sizeBytes, installdir };
}
