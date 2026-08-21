import { parseSafeAppId } from "./types.js";
import { asInt, asString, getKeyInsensitive, parseVdf } from "./vdf.js";

interface ManifestData {
  appId: number;
  name: string;
  sizeBytes: number;
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
  const sizeBytes = asInt(getKeyInsensitive(app, "SizeOnDisk")) ?? 0;

  return { appId, name, sizeBytes };
}
