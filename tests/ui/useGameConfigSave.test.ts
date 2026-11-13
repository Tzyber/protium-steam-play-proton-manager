// Audit 1.1: der compat-entwurf hing allein am appId-watch; eine externe
// änderung bei gleicher appId kam nicht an. geprüft direkt am composable.

import { describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { WriteResult } from "../../src/core/ports";
import type { Game } from "../../src/core/types";
import { useGameConfigSave } from "../../src/ui/composables/useGameConfigSave";
import { game as makeGame } from "../support/factories";

function setup(initial: Game) {
  const game = ref<Game | null>(initial);
  const saveLaunchOptions = vi.fn<(appId: number, value: string) => Promise<WriteResult>>(
    async () => "written",
  );
  const saveCompatTool = vi.fn<(appId: number, tool: string | null) => Promise<WriteResult>>(
    async () => "written",
  );
  const subject = useGameConfigSave(game, { saveLaunchOptions, saveCompatTool });
  return { game, saveLaunchOptions, saveCompatTool, ...subject };
}

/** Das spiel-objekt, wie es ein rescan liefert: gleiche appId, neue rohdaten. */
function rescan(appId: number, compatTool: string, launchOptions = ""): Game {
  return makeGame({ appId, compatTool, launchOptions });
}

describe("useGameConfigSave, compat-auswahl", () => {
  it("übernimmt beim ersten Sync den Backend-Wert und ist nicht dirty", () => {
    const fallback = setup(rescan(42, "default"));
    expect(fallback.compatSelected.value).toBe("__default__");
    expect(fallback.compatDirty.value).toBe(false);

    const tool = setup(rescan(42, "GE-Proton9-27"));
    expect(tool.compatSelected.value).toBe("GE-Proton9-27");
    expect(tool.compatDirty.value).toBe(false);
  });

  it("folgt einem extern geänderten compatTool bei gleicher appId", async () => {
    const { game, compatSelected, compatDirty } = setup(rescan(42, "tool-a"));
    expect(compatSelected.value).toBe("tool-a");

    game.value = rescan(42, "tool-b");
    await nextTick();

    expect(compatSelected.value).toBe("tool-b");
    expect(compatDirty.value).toBe(false);
  });

  it("behält eine eigene wahl über einen rescan hinweg und bleibt dirty", async () => {
    const { game, compatSelected, compatDirty } = setup(rescan(42, "tool-a"));

    compatSelected.value = "tool-b";
    expect(compatSelected.value).toBe("tool-b");
    expect(compatDirty.value).toBe(true);

    game.value = rescan(42, "tool-c");
    await nextTick();

    // die wahl gehört dem nutzer, ein rescan darf sie nicht überschreiben
    expect(compatSelected.value).toBe("tool-b");
    expect(compatDirty.value).toBe(true);
  });

  it("externer gleichlauf verwirft den entwurf", async () => {
    const { game, compatSelected, compatDirty } = setup(rescan(42, "tool-a"));

    compatSelected.value = "tool-b";
    expect(compatDirty.value).toBe(true);

    // das backend zieht extern auf den entwurfswert nach: der entwurf ist erledigt
    game.value = rescan(42, "tool-b");
    await nextTick();

    expect(compatSelected.value).toBe("tool-b");
    expect(compatDirty.value).toBe(false);

    // ohne entwurf kommt auch die nächste externe änderung wieder an
    game.value = rescan(42, "tool-c");
    await nextTick();

    expect(compatSelected.value).toBe("tool-c");
    expect(compatDirty.value).toBe(false);
  });

  it("setzt die wahl bei einem appId-wechsel zurück", async () => {
    const { game, compatSelected, compatDirty, compatState } = setup(rescan(42, "tool-a"));

    compatSelected.value = "tool-b";
    expect(compatDirty.value).toBe(true);

    game.value = rescan(43, "tool-c");
    await nextTick();

    expect(compatSelected.value).toBe("tool-c");
    expect(compatDirty.value).toBe(false);
    expect(compatState.value).toEqual({ kind: "idle" });
  });

  it("lässt nach einem gespeicherten wert wieder externe änderungen durch", async () => {
    const { game, saveCompatTool, compatSelected, compatDirty, compatState, saveCompat } = setup(
      rescan(42, "tool-a"),
    );
    // der erfolgreiche write kommt über den scan zurück: das spiel-objekt trägt
    // danach den geschriebenen tool-namen.
    saveCompatTool.mockImplementationOnce(async (_appId, tool) => {
      game.value = rescan(42, tool ?? "default");
      return "written";
    });

    compatSelected.value = "tool-b";
    expect(compatDirty.value).toBe(true);
    await saveCompat();

    expect(saveCompatTool).toHaveBeenCalledExactlyOnceWith(42, "tool-b");
    expect(compatState.value).toEqual({ kind: "saved" });

    // ein späterer externer wechsel muss wieder ankommen (touched zurückgesetzt)
    game.value = rescan(42, "tool-c");
    await nextTick();

    expect(compatSelected.value).toBe("tool-c");
    expect(compatDirty.value).toBe(false);
  });

  it("nach dem zurückwählen des backend-werts folgen externe änderungen", async () => {
    const { game, saveCompatTool, compatSelected, compatDirty, saveCompat } = setup(
      rescan(42, "tool-a"),
    );

    // zurück auf den backend-wert: kein entwurf mehr, das feld folgt wieder dem backend
    compatSelected.value = "tool-a";
    game.value = rescan(42, "tool-c");
    await nextTick();

    expect(compatSelected.value).toBe("tool-c");
    expect(compatDirty.value).toBe(false);
    await saveCompat();
    expect(saveCompatTool).not.toHaveBeenCalled();
  });

  it("behält die wahl, wenn der snapshot den geschriebenen wert nicht trägt", async () => {
    const { compatSelected, compatDirty, compatState, saveCompat } = setup(rescan(42, "tool-a"));

    compatSelected.value = "tool-b";
    await saveCompat();

    expect(compatState.value).toEqual({ kind: "saved" });
    expect(compatSelected.value).toBe("tool-b");
    expect(compatDirty.value).toBe(true);
  });

  it("unchanged lässt den entwurf stehen", async () => {
    const { saveCompatTool, compatSelected, compatDirty, compatState, saveCompat } = setup(
      rescan(42, "tool-a"),
    );
    saveCompatTool.mockResolvedValueOnce("unchanged");

    compatSelected.value = "tool-b";
    await saveCompat();

    // nichts geschrieben: der entwurf bleibt, sonst wäre der wunsch des nutzers weg
    expect(compatState.value.kind).toBe("idle");
    expect(compatSelected.value).toBe("tool-b");
    expect(compatDirty.value).toBe(true);
  });

  it("behandelt einen leeren backend-wert wie den platzhalter", () => {
    expect(setup(rescan(42, "")).compatSelected.value).toBe("__default__");
  });

  it("behält die wahl und den fehler, wenn der write scheitert", async () => {
    const { saveCompatTool, compatSelected, compatState, saveCompat } = setup(rescan(42, "tool-a"));
    saveCompatTool.mockRejectedValueOnce("steam-running");

    compatSelected.value = "tool-b";
    await saveCompat();

    expect(compatState.value).toMatchObject({ kind: "error" });
    expect(compatSelected.value).toBe("tool-b");
  });

  it("speichern des platzhalters schreibt null", async () => {
    const { saveCompatTool, compatSelected, saveCompat } = setup(rescan(42, "tool-a"));

    compatSelected.value = "__default__";
    await saveCompat();

    expect(saveCompatTool).toHaveBeenCalledExactlyOnceWith(42, null);
  });

  it("speichert nichts, wenn die wahl dem Backend-Wert entspricht", async () => {
    const { saveCompatTool, compatSelected, compatDirty, saveCompat } = setup(rescan(42, "tool-a"));

    compatSelected.value = "tool-a";
    await saveCompat();

    expect(compatDirty.value).toBe(false);
    expect(saveCompatTool).not.toHaveBeenCalled();
  });
});

describe("useGameConfigSave, launchOptions (P4F1)", () => {
  it("folgt extern geänderten launchOptions bei gleicher appId, wenn kein entwurf aktiv ist", async () => {
    const { game, launchInput, launchDirty } = setup(rescan(42, "default", "-novid"));
    expect(launchInput.value).toBe("-novid");
    expect(launchDirty.value).toBe(false);

    game.value = rescan(42, "default", "gamemoderun %command%");
    await nextTick();

    expect(launchInput.value).toBe("gamemoderun %command%");
    expect(launchDirty.value).toBe(false);
  });

  it("behält einen eigenen entwurf über einen rescan hinweg und bleibt dirty", async () => {
    const { game, launchInput, launchDirty } = setup(rescan(42, "default", "-novid"));

    launchInput.value = "-novid -console";
    expect(launchDirty.value).toBe(true);

    game.value = rescan(42, "default", "--anderer-wert");
    await nextTick();

    expect(launchInput.value).toBe("-novid -console");
    expect(launchDirty.value).toBe(true);
  });

  it("verwirft den entwurf bei externem gleichlauf oder zurück-tippen des backend-werts", async () => {
    const { game, launchInput, launchDirty } = setup(rescan(42, "default", "-novid"));

    launchInput.value = "mangohud %command%";
    expect(launchDirty.value).toBe(true);

    // backend zieht extern auf den entwurfswert nach
    game.value = rescan(42, "default", "mangohud %command%");
    await nextTick();

    expect(launchInput.value).toBe("mangohud %command%");
    expect(launchDirty.value).toBe(false);

    // ohne entwurf kommt die nächste externe änderung an
    game.value = rescan(42, "default", "-fullscreen");
    await nextTick();
    expect(launchInput.value).toBe("-fullscreen");
    expect(launchDirty.value).toBe(false);

    // zurück auf den aktuellen backend-wert getippt -> kein entwurf mehr
    launchInput.value = "-custom";
    expect(launchDirty.value).toBe(true);
    launchInput.value = "-fullscreen";
    expect(launchDirty.value).toBe(false);

    game.value = rescan(42, "default", "-w 1280");
    await nextTick();
    expect(launchInput.value).toBe("-w 1280");
  });

  it("setzt den launchOptions-entwurf bei einem appId-wechsel zurück", async () => {
    const { game, launchInput, launchDirty, launchState } = setup(rescan(42, "default", "-novid"));

    launchInput.value = "eigener entwurf";
    expect(launchDirty.value).toBe(true);

    game.value = rescan(43, "default", "-console");
    await nextTick();

    expect(launchInput.value).toBe("-console");
    expect(launchDirty.value).toBe(false);
    expect(launchState.value).toEqual({ kind: "idle" });
  });
});
