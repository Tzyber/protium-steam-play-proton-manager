// Speicherzustand und die beiden Schreibvorgänge des Drawers (Startoptionen,
// Compat-Tool). Die Abläufe waren bis auf das Feld wortgleich; `runSave` hält
// die gemeinsame Klammer aus Auftrags-Gültigkeit und Entwurfs-Vergleich.

import { computed, type Ref, ref, watch } from "vue";
import { parseError } from "../core/errtext";
import type { WriteResult } from "../core/ports";
import type { Game } from "../core/types";
import { formatError } from "./formatError";
import { useLatestRequest } from "./useLatestRequest";

/** Status eines Speichervorgangs: bekannte Schlagworte ODER die Fehlermeldung.
 *  Als tagged union, damit `stateError` nicht aus einem freien string raten muss. */
export type SaveState =
  | { kind: "idle" | "saving" | "saved" }
  | { kind: "error"; message: string; uncertain: boolean };

/** `uncertain` unterscheidet den Fall "möglicherweise geschrieben" (Code
 *  write-may-have-applied) vom belegten "nichts verändert": der Garantiesatz
 *  darf dort nicht stehen (SECURITY.md). */
function errorState(e: unknown): SaveState {
  return {
    kind: "error",
    message: formatError(e),
    uncertain: parseError(e).code === "write-may-have-applied",
  };
}

/** Der Teil des Config-Stores, den dieser Baustein braucht. */
interface GameConfigWriter {
  saveLaunchOptions(appId: number, value: string): Promise<WriteResult>;
  saveCompatTool(appId: number, internalName: string | null): Promise<WriteResult>;
}

interface SaveRun {
  state: Ref<SaveState>;
  request: ReturnType<typeof useLatestRequest>;
  /** Entwurf zum Startzeitpunkt; weicht er inzwischen ab, verfällt die Antwort. */
  draft: () => string;
  write: (submitted: string) => Promise<WriteResult>;
}

/** Gemeinsame Klammer beider Schreibvorgänge. Der Aufrufer prüft vorher, dass
 *  kein Lauf offen ist (dann darf der Entwurf nicht mehr angetastet werden);
 *  hier gilt nur noch: die Antwort zählt allein, wenn Auftrag und Entwurf noch
 *  aktuell sind. Ein abweichender Entwurf beendet den Status trotzdem, sonst
 *  bliebe der Knopf dauerhaft gesperrt. */
async function runSave(run: SaveRun): Promise<void> {
  const token = run.request.begin();
  const submitted = run.draft();
  const stillMatches = (): boolean =>
    run.request.matchesValue(token, () => run.draft() === submitted);
  run.state.value = { kind: "saving" };
  try {
    const result = await run.write(submitted);
    if (!run.request.matches(token)) return;
    if (!stillMatches()) {
      run.state.value = { kind: "idle" };
      return;
    }
    run.state.value = result === "written" ? { kind: "saved" } : { kind: "idle" };
  } catch (e) {
    if (!stillMatches()) return;
    run.state.value = errorState(e);
  }
}

export function useGameConfigSave(game: Readonly<Ref<Game | null>>, config: GameConfigWriter) {
  const launchInput = ref("");
  const launchState = ref<SaveState>({ kind: "idle" });
  const launchDirty = computed(() => launchInput.value !== (game.value?.launchOptions ?? ""));
  const launchRequest = useLatestRequest(() => game.value);

  const compatSelected = ref("__default__");
  const compatState = ref<SaveState>({ kind: "idle" });
  const compatRequest = useLatestRequest(() => game.value);
  const compatDirty = computed(() => {
    const current = game.value?.compatTool ?? "default";
    const expected = current === "default" ? "__default__" : current;
    return compatSelected.value !== expected;
  });

  // Ein echter Spielwechsel (andere appId) verwirft den Entwurf. Ein Rescan
  // tauscht dagegen das Spiel-Objekt bei gleicher appId aus; dann gehört der
  // halb getippte Entwurf weiter dem Nutzer (U-15).
  watch(
    () => game.value?.appId ?? null,
    () => {
      launchInput.value = game.value?.launchOptions ?? "";
      launchState.value = { kind: "idle" };
    },
    { immediate: true },
  );
  watch(launchInput, () => {
    if (launchState.value.kind === "saved") launchState.value = { kind: "idle" };
  });

  watch(
    () => game.value?.appId ?? null,
    () => {
      const tool = game.value?.compatTool;
      compatSelected.value = tool && tool !== "default" ? tool : "__default__";
      compatState.value = { kind: "idle" };
    },
    { immediate: true },
  );
  watch(compatSelected, () => {
    if (compatState.value.kind === "saved") compatState.value = { kind: "idle" };
  });

  async function saveLaunch(): Promise<void> {
    const g = game.value;
    if (!g || launchState.value.kind === "saving") return;
    // dirty-vergleich und gespeicherter wert laufen beide getrimmt, sonst bliebe
    // der save-button nach dem speichern von " foo " fälschlich aktiv.
    launchInput.value = launchInput.value.trim();
    if (!launchDirty.value) return;
    await runSave({
      state: launchState,
      request: launchRequest,
      draft: () => launchInput.value,
      write: (submitted) => config.saveLaunchOptions(g.appId, submitted),
    });
  }

  async function saveCompat(): Promise<void> {
    const g = game.value;
    if (!g || compatState.value.kind === "saving" || !compatDirty.value) return;
    await runSave({
      state: compatState,
      request: compatRequest,
      draft: () => compatSelected.value,
      write: (submitted) =>
        config.saveCompatTool(g.appId, submitted === "__default__" ? null : submitted),
    });
  }

  return {
    launchInput,
    launchState,
    launchDirty,
    saveLaunch,
    compatSelected,
    compatState,
    compatDirty,
    saveCompat,
  };
}
