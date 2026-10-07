// Tabelle statt Liste: kanonische Quelle für Filter und Dropdown.
// (availableBuiltinProtons filtert die tabelle nach den app-ids, die ein App-Manifest haben).

import type { BuiltinProton } from "./types.js";

type BlockCategory =
  | "proton-builtin" // valve-eigene proton-builds, eigene steam-app
  | "runtime" // steam linux runtime container
  | "redistributable"; // steamworks common redistributables

interface BlockEntry {
  appId: number;
  category: BlockCategory;
  /** interner compat-tool-name im mapping. proton-builtin und wählbare runtimes. */
  toolName?: string;
  /** weitere mapping-namen, die steam für dieselbe runtime annimmt. */
  toolAliases?: readonly string[];
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
  // wählbare runtimes; mapping-namen und `aliases` aus appinfo.vdf (app 891390,
  // extended/compat_tools), geprüft 2026-10-07.
  {
    appId: 1070560,
    category: "runtime",
    toolName: "steamlinuxruntime",
    toolAliases: ["native", "scout", "SteamLinuxRuntime_scout"],
    label: "Steam Linux Runtime 1.0 (scout)",
  },
  {
    appId: 1391110,
    category: "runtime",
    toolName: "steamlinuxruntime_soldier",
    toolAliases: ["soldier"],
    label: "Steam Linux Runtime 2.0 (soldier)",
  },
  {
    appId: 1628350,
    category: "runtime",
    toolName: "steamlinuxruntime_sniper",
    toolAliases: ["sniper"],
    label: "Steam Linux Runtime 3.0 (sniper)",
  },
  {
    appId: 4183110,
    category: "runtime",
    toolName: "steamlinuxruntime_4",
    toolAliases: ["steamrt4", "steamrt4-any"],
    label: "Steam Linux Runtime 4.0",
  },
  {
    appId: 4690330,
    category: "runtime",
    toolName: "legacysteamruntime",
    toolAliases: ["scout_legacy", "legacy_steam_runtime"],
    label: "Legacy Steam Runtime",
  },
  // redistributables
  { appId: 228980, category: "redistributable", label: "Steamworks Common Redistributables" },
];

const BLOCKED_IDS = new Set(BLOCKLIST.map((e) => e.appId));
// mutationsbereich: BLOCKLIST_LOGIC_RANGE in stryker.config.mjs bei edits mitziehen.
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
type BlockReason = "id" | "name-heuristic" | null;

export function blockReason(appId: number, name: string): BlockReason {
  if (BLOCKED_IDS.has(appId)) return "id";
  if (NAME_PREFIXES.some((p) => name.startsWith(p))) return "name-heuristic";
  return null;
}

/** die built-in protons, deren steam-app ein vorhandenes App-Manifest im scan hat
 *  (der aufrufer übergibt die blocklisteten app-ids aus `scanGames`; K-08). */
export function availableBuiltinProtons(manifestAppIds: ReadonlySet<number>): BuiltinProton[] {
  return BLOCKLIST.filter(
    (e) => e.category === "proton-builtin" && manifestAppIds.has(e.appId),
  ).map((e) => ({ internalName: e.toolName as string, displayName: e.label }));
}

/** wählbare runtimes, deren manifest im scan liegt: jeder exakte mapping-name
 *  (toolName und aliasse) → label. kein präfix-raten auf "steamlinuxruntime". */
export function availableRuntimes(manifestAppIds: ReadonlySet<number>): Map<string, string> {
  const runtimes = new Map<string, string>();
  for (const entry of BLOCKLIST) {
    if (entry.category !== "runtime" || entry.toolName === undefined) continue;
    if (!manifestAppIds.has(entry.appId)) continue;
    for (const name of [entry.toolName, ...(entry.toolAliases ?? [])]) {
      runtimes.set(name, entry.label);
    }
  }
  return runtimes;
}

/** mapping-namen, deren präsenz nur ein app-manifest belegt: builtin-protons
 *  und wählbare runtimes samt aliassen. */
export function isManifestToolName(name: string): boolean {
  return BLOCKLIST.some((e) => e.toolName === name || (e.toolAliases ?? []).includes(name));
}
