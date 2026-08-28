// Tabelle statt Liste: kanonische Quelle für Filter und Dropdown.
// (availableBuiltinProtons filtert hier nach `installedAppIds`).

export type BlockCategory =
  | "proton-builtin" // valve-eigene proton-builds, eigene steam-app
  | "runtime" // steam linux runtime container
  | "redistributable"; // steamworks common redistributables

export interface BlockEntry {
  appId: number;
  category: BlockCategory;
  /** nur für proton-builtin: interner compat-tool-name im mapping. */
  toolName?: string;
  label: string;
}

// appids steamdb-verifiziert; interne toolnamen folgen dem muster proton_<major>.
export const BLOCKLIST: readonly BlockEntry[] = [
  // valve proton-builds (compat tool, kein spiel)
  { appId: 4628710, category: "proton-builtin", toolName: "proton_11", label: "Proton 11.0" },
  {
    appId: 4628740,
    category: "proton-builtin",
    toolName: "proton_11",
    label: "Proton 11.0 (ARM64)",
  },
  { appId: 3658110, category: "proton-builtin", toolName: "proton_10", label: "Proton 10.0" },
  {
    appId: 1493710,
    category: "proton-builtin",
    toolName: "proton_experimental",
    label: "Proton Experimental",
  },
  { appId: 2805730, category: "proton-builtin", toolName: "proton_9", label: "Proton 9.0" },
  { appId: 2348590, category: "proton-builtin", toolName: "proton_8", label: "Proton 8.0" },
  { appId: 1887720, category: "proton-builtin", toolName: "proton_7", label: "Proton 7.0" },
  { appId: 1580130, category: "proton-builtin", toolName: "proton_63", label: "Proton 6.3" },
  { appId: 1420170, category: "proton-builtin", toolName: "proton_513", label: "Proton 5.13" },
  { appId: 1245040, category: "proton-builtin", toolName: "proton_5", label: "Proton 5.0" },
  { appId: 2180100, category: "proton-builtin", toolName: "proton_hotfix", label: "Proton Hotfix" },
  // valve-runtimes / hilfstools (kein spiel, nicht als compat-tool wählbar)
  { appId: 2230260, category: "runtime", label: "Proton Next" },
  { appId: 1826330, category: "runtime", label: "Proton EasyAntiCheat Runtime" },
  { appId: 1161040, category: "runtime", label: "Proton BattlEye Runtime" },
  { appId: 3086180, category: "runtime", label: "Proton Voice Files" },
  // steam linux runtime container
  { appId: 1070560, category: "runtime", label: "Steam Linux Runtime 1.0 (scout)" },
  { appId: 1391110, category: "runtime", label: "Steam Linux Runtime 2.0 (soldier)" },
  { appId: 1628350, category: "runtime", label: "Steam Linux Runtime 3.0 (sniper)" },
  // redistributables
  { appId: 228980, category: "redistributable", label: "Steamworks Common Redistributables" },
];

const BLOCKED_IDS = new Set(BLOCKLIST.map((e) => e.appId));

// namens-heuristik als zweite verteidigungslinie für nicht gelistete builds.
const NAME_PREFIXES = [
  "Proton ",
  "Steam Linux Runtime",
  "Steamworks Common",
  "Steamworks Shared",
] as const;

/** Warum eine App blocklistet wird: "id" = exakte Tabelle (gewissheit) oder
 *  "name-heuristic" = nur namens-präfix (unsicherheit). Nur die exakte ID
 *  darf ein spiel still ausblenden; der präfix-treffer wird gemeldet, nie
 *  als gewissheit behandelt (keine string-heuristik als fachlicher fakt). */
export type BlockReason = "id" | "name-heuristic" | null;

export function blockReason(appId: number, name: string): BlockReason {
  if (BLOCKED_IDS.has(appId)) return "id";
  if (NAME_PREFIXES.some((p) => name.startsWith(p))) return "name-heuristic";
  return null;
}

export function isBlocked(appId: number, name: string): boolean {
  return blockReason(appId, name) !== null;
}

/** die built-in protons, deren steam-app im scan als installiert erkannt wurde. */
export function availableBuiltinProtons(
  installedAppIds: ReadonlySet<number>,
): { internalName: string; displayName: string }[] {
  return BLOCKLIST.filter(
    (e) => e.category === "proton-builtin" && installedAppIds.has(e.appId),
  ).map((e) => ({ internalName: e.toolName as string, displayName: e.label }));
}
