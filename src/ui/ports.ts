// Composition-Root der UI (P10a/FR-2): die einzige Stelle der Oberfläche, die
// den Tauri-Adapter kennt. UI-Module importieren `ports` und Typen von hier.
import { tauriPorts } from "../core/adapters/tauri";

export const ports = tauriPorts;
export type { ConfigBackupEntry } from "../core/ports";
