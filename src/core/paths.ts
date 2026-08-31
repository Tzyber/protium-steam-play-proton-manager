// Diese Datei konstruiert alle Steam-Pfade. Die Environment-Wurzeln selbst
// werden ausschließlich im Rust-Backend entdeckt und als Snapshot geliefert.

function join(...parts: string[]): string {
  const joined = parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter(Boolean)
    .join("/");
  if (joined.split("/").some((seg) => seg === "..")) {
    throw new Error(`joinPath: ".." segment rejected for security`);
  }
  return joined;
}

export const paths = {
  libraryFoldersVdf: (root: string) => join(root, "steamapps", "libraryfolders.vdf"),
  configVdf: (root: string) => join(root, "config", "config.vdf"), // mapping liegt in der root
  loginusersVdf: (root: string) => join(root, "config", "loginusers.vdf"),
  compatToolsDir: (root: string) => join(root, "compatibilitytools.d"),
  compatToolVdfIn: (baseDir: string, toolDir: string) =>
    join(baseDir, toolDir, "compatibilitytool.vdf"),
  userdataDir: (root: string) => join(root, "userdata"),
  localConfigVdf: (root: string, userId: string) =>
    join(root, "userdata", userId, "config", "localconfig.vdf"),
  shortcutsVdf: (root: string, userId: string) =>
    join(root, "userdata", userId, "config", "shortcuts.vdf"),
  libraryAppsDir: (libraryPath: string) => join(libraryPath, "steamapps"),
  gameInstallPath: (libraryPath: string, installdir: string) => {
    if (
      typeof installdir !== "string" ||
      installdir.length === 0 ||
      installdir === "." ||
      installdir === ".." ||
      installdir.includes("/") ||
      installdir.includes("\\") ||
      installdir.includes("\0")
    ) {
      throw new Error("gameInstallPath: unsafe installdir");
    }
    return join(libraryPath, "steamapps", "common", installdir);
  },
  compatdataDir: (libraryPath: string) => join(libraryPath, "steamapps", "compatdata"),
  shadercacheDir: (libraryPath: string) => join(libraryPath, "steamapps", "shadercache"),
  trashDir: (libraryPath: string) => join(libraryPath, "steamapps", ".protium-trash"),
  compatdataPath: (libraryPath: string, appId: number | string) =>
    join(libraryPath, "steamapps", "compatdata", String(appId)),
  shadercachePath: (libraryPath: string, appId: number | string) =>
    join(libraryPath, "steamapps", "shadercache", String(appId)),
  headerImageUrl: (appId: number) =>
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
  // hash-unterordner, zentral in der root (nicht pro library)
  libraryCacheAppDir: (root: string, appId: number) =>
    join(root, "appcache", "librarycache", String(appId)),
};

export const LOCAL_HEADER_FILENAME = "library_header.jpg";

export { join as joinPath };

// distro-/paket-tools (z. B. proton-cachyos); steam durchsucht diese zusätzlich.
// spiegel zu SYSTEM_COMPAT_DIRS in src-tauri/src/commands/scope.rs
// beide zusammen pflegen (drift = distro-protonen verschwinden aus der UI).
export const SYSTEM_COMPAT_DIRS = [
  "/usr/share/steam/compatibilitytools.d",
  "/usr/local/share/steam/compatibilitytools.d",
] as const;
