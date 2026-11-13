// Speicherzustand und die beiden Schreibvorgänge des Drawers (Startoptionen,
// Compat-Tool). Die Abläufe waren bis auf das Feld wortgleich; `runSave` hält
// die gemeinsame Klammer aus Auftrags-Gültigkeit und Entwurfs-Vergleich.

import { computed, type Ref, ref, watch } from "vue";
import { parseError } from "../../core/errtext";
import type { WriteResult } from "../../core/ports";
import type { Game } from "../../core/types";
import { formatError } from "../formatError";
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
 *  bliebe der Knopf dauerhaft gesperrt. Jeder Pfad, dem der Zustand noch
 *  gehört, endet in einem Ruhe- oder Fehlerzustand; nur ein überholter Auftrag
 *  (Spielwechsel, jüngeres `begin`) lässt ihn stehen, weil dann ein anderer
 *  Auftrag oder der appId-Reset Eigentümer ist. */
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
    // Ein Fehler bleibt sichtbar (U-02), auch wenn der Entwurf während des
    // Writes weiterlief: der Vorgang ist gescheitert, und ein unsicherer
    // Ausgang (write-may-have-applied) darf nicht verlorengehen. Nur ein
    // überholter Auftrag verwirft die Meldung. (N-2: `stillMatches` ließ den
    // Ladezustand hier dauerhaft stehen.)
    if (!run.request.matches(token)) return;
    run.state.value = errorState(e);
  }
}

/** Shadow-State eines Konfigurationsfelds: `null` bedeutet kein Entwurf, dann
 *  folgt das Feld dem Backend-Stand; ein aktiver Entwurf überlebt Rescans bei
 *  gleicher appId und löst sich erst bei Gleichlauf oder appId-Wechsel auf. */
function useShadowField(game: Readonly<Ref<Game | null>>, readBackend: () => string) {
  // `null` heißt kein entwurf: dann folgt das feld dem backend und eine externe
  // änderung bei gleicher appId kommt an (Audit 1.1 / P4F1).
  const draft = ref<string | null>(null);
  const value = computed<string>({
    get: () => draft.value ?? readBackend(),
    set: (next) => {
      draft.value = next === readBackend() ? null : next;
    },
  });
  const state = ref<SaveState>({ kind: "idle" });
  const request = useLatestRequest(() => game.value);

  // Ein echter Spielwechsel (andere appId) verwirft den Entwurf. Ein Rescan
  // tauscht dagegen das Spiel-Objekt bei gleicher appId aus; dann gehört der
  // halb getippte Entwurf weiter dem Nutzer (U-15).
  watch(
    () => game.value?.appId ?? null,
    () => {
      draft.value = null;
      state.value = { kind: "idle" };
    },
    { immediate: true },
  );
  watch(value, () => {
    if (state.value.kind === "saved") state.value = { kind: "idle" };
  });
  // zieht das backend extern auf den entwurfswert nach (rescan, steam,
  // protonmanager), ist der entwurf erledigt: sonst bliebe der knopf aktiv und
  // der nächste klick schriebe denselben wert erneut durchs write-gate. ein
  // abweichender externer wert lässt den entwurf stehen (U-15).
  watch(readBackend, () => {
    if (draft.value !== null && draft.value === readBackend()) {
      draft.value = null;
    }
  });

  function clearDraftIfSynced(submitted: string): void {
    // erst wenn der snapshot den geschriebenen wert trägt, ist der backend-stand
    // erreicht; sonst bliebe die anzeige auf dem alten wert (Audit 1.1).
    if (state.value.kind === "saved" && readBackend() === submitted) {
      draft.value = null;
    }
  }

  return { draft, value, state, request, clearDraftIfSynced };
}

export function useGameConfigSave(game: Readonly<Ref<Game | null>>, config: GameConfigWriter) {
  function backendLaunchOptions(): string {
    return game.value?.launchOptions ?? "";
  }

  const launch = useShadowField(game, backendLaunchOptions);
  const launchDirty = computed(
    () => launch.draft.value !== null && launch.value.value.trim() !== backendLaunchOptions(),
  );

  /** Backend-wert als auswahl-wert: kein eintrag oder "default" steht für den
   *  leeren platzhalter der SelectBox. */
  function backendCompatTool(): string {
    const tool = game.value?.compatTool;
    return tool && tool !== "default" ? tool : "__default__";
  }

  const compat = useShadowField(game, backendCompatTool);
  const compatDirty = computed(() => compat.draft.value !== null);

  async function saveLaunch(): Promise<void> {
    const g = game.value;
    if (!g || launch.state.value.kind === "saving") return;
    // dirty-vergleich und gespeicherter wert laufen beide getrimmt, sonst bliebe
    // der save-button nach dem speichern von " foo " fälschlich aktiv.
    const submitted = launch.value.value.trim();
    launch.value.value = submitted;
    if (!launchDirty.value) return;
    await runSave({
      state: launch.state,
      request: launch.request,
      draft: () => launch.value.value,
      write: (value) => config.saveLaunchOptions(g.appId, value),
    });
    launch.clearDraftIfSynced(submitted);
  }

  async function saveCompat(): Promise<void> {
    const g = game.value;
    if (!g || compat.state.value.kind === "saving" || !compatDirty.value) return;
    const submitted = compat.value.value;
    await runSave({
      state: compat.state,
      request: compat.request,
      draft: () => compat.value.value,
      write: (value) => config.saveCompatTool(g.appId, value === "__default__" ? null : value),
    });
    compat.clearDraftIfSynced(submitted);
  }

  return {
    launchInput: launch.value,
    launchState: launch.state,
    launchDirty,
    saveLaunch,
    compatSelected: compat.value,
    compatState: compat.state,
    compatDirty,
    saveCompat,
  };
}
