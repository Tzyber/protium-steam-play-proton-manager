import { ManifestParseError } from "./errors.js";
import { errText } from "./errtext.js";
import { NUMERIC_RE, parseSafeAppId } from "./types.js";
import { asString, getKeyInsensitive, parseVdf } from "./vdf.js";
import { tokenizeVdf } from "./vdfpatch.js";

interface ManifestData {
  appId: number;
  name: string;
  /** Größe aus `SizeOnDisk` im Steam-Appmanifest; fehlend oder ungültig = unbekannt. */
  sizeBytes?: number;
  /** Installationsordner aus `installdir`; fehlend oder unsicher = unbekannt. */
  installdir?: string;
}

/** roher skalarenwert des letzten passenden feldes direkt unter `AppState`.
 *  laufen über den gemeinsamen tokenizer (K-02); rohform bleibt erhalten, damit
 *  der escaping-vergleich unten die quellsyntax sieht. conditionals zählen wie
 *  für die anderen leser nicht als key/value. */
function rawManifestField(text: string, fieldName: string): string | undefined {
  const { tokens } = tokenizeVdf(text);
  const normalizedFieldName = fieldName.toLowerCase();
  let depth = 0;
  let appStateDepth: number | undefined;
  let pendingKey: string | undefined;
  let fieldValue: string | undefined;

  for (const token of tokens) {
    if (token.kind === "conditional") continue;
    if (token.kind === "open") {
      if (depth === 0 && pendingKey?.toLowerCase() === "appstate") {
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

    if (pendingKey !== undefined) {
      if (
        appStateDepth !== undefined &&
        depth === appStateDepth &&
        pendingKey.toLowerCase() === normalizedFieldName
      ) {
        fieldValue = token.raw;
      }
      pendingKey = undefined;
      continue;
    }
    pendingKey = token.raw;
  }

  return fieldValue;
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
    throw new ManifestParseError(
      "manifest-missing-appstate",
      "appmanifest ohne AppState-block",
      errText(e),
    );
  }
  const app = getKeyInsensitive(root, "AppState");

  if (typeof app !== "object" || app === null) {
    throw new ManifestParseError("manifest-missing-appstate", "appmanifest ohne AppState-block");
  }
  const appIdRaw = asString(getKeyInsensitive(app, "appid"));
  if (appIdRaw === undefined) {
    throw new ManifestParseError("manifest-invalid-appid", "appmanifest ohne gültige appid");
  }
  const appId = parseSafeAppId(appIdRaw);
  if (appId === null) {
    throw new ManifestParseError("manifest-invalid-appid", "appmanifest ohne gültige appid");
  }

  const name = asString(getKeyInsensitive(app, "name")) ?? `app ${appId}`;
  const sizeBytes = parseManifestSize(rawManifestField(text, "SizeOnDisk"));
  const installdir = parseManifestInstallDir(rawManifestField(text, "installdir"));

  return { appId, name, sizeBytes, installdir };
}
