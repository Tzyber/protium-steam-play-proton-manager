import { ManifestParseError } from "./errors.js";
import { errText } from "./errtext.js";
import { NUMERIC_RE, parseSafeAppId } from "./guards.js";
import { getVdfValue, isBlock } from "./vdfRead.js";

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

  // Die Rohsyntax bleibt die Autorität für diesen einzelnen Wert (keine Exponent-/Dezimal-Coercion).
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
  let hasAppState: boolean;
  let appIdRaw: string | undefined;
  let nameRaw: string | undefined;
  let sizeRaw: string | undefined;
  let installdirRaw: string | undefined;
  try {
    hasAppState = isBlock(text, ["AppState"]);
    if (hasAppState) {
      appIdRaw = getVdfValue(text, ["AppState", "appid"]);
      nameRaw = getVdfValue(text, ["AppState", "name"]);
      sizeRaw = getVdfValue(text, ["AppState", "SizeOnDisk"]);
      installdirRaw = getVdfValue(text, ["AppState", "installdir"]);
    }
  } catch (e) {
    throw new ManifestParseError("manifest-missing-appstate", errText(e));
  }

  if (!hasAppState) {
    throw new ManifestParseError("manifest-missing-appstate");
  }
  if (appIdRaw === undefined) {
    throw new ManifestParseError("manifest-invalid-appid");
  }
  const appId = parseSafeAppId(appIdRaw);
  if (appId === null) {
    throw new ManifestParseError("manifest-invalid-appid");
  }

  const name = nameRaw === undefined ? `app ${appId}` : nameRaw;
  const sizeBytes = parseManifestSize(sizeRaw);
  const installdir = parseManifestInstallDir(installdirRaw);

  return { appId, name, sizeBytes, installdir };
}
