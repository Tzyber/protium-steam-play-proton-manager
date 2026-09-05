import { describe, expect, it } from "vitest";
import { analyzeLaunchOptions } from "../../src/core/launchHints.js";

describe("analyzeLaunchOptions", () => {
  it.each([
    ["gamemoderun ohne marker", "gamemoderun", ["gamemode-missing-command"]],
    ["gamemoderun mit argument", "gamemoderun --foo", ["gamemode-missing-command"]],
    ["gamemoderun mit equals-argument", "gamemoderun --foo=bar", ["gamemode-missing-command"]],
    ["gamemoderun mit marker", "gamemoderun %command%", []],
    ["gamemoderun mit marker und tab", "gamemoderun\t%command%", []],
    ["mangohud ohne marker", "mangohud", []],
    ["absoluter wrapperpfad", "/usr/bin/gamemoderun %command%", []],
    ["gamemoderun hinter assignment ohne marker", "X=1 gamemoderun", []],
    ["assignment vor marker", "A=1 %command%", []],
    ["assignment nach marker", "%command% A=1", ["assignment-after-command"]],
    ["equals-option nach marker", "%command% --foo=bar", []],
    ["env ohne assignment", "env %command%", []],
    ["env mit assignment nach marker", "env %command% A=1", ["assignment-after-command"]],
    ["env mit assignment vor marker", "env A=1 %command%", []],
    ["env option", "env -u X %command%", []],
    ["mehrfaches assignment nach marker", "%command% A=1 A=2", ["assignment-after-command"]],
  ])("%s", (_label, draft, expected) => {
    expect(analyzeLaunchOptions(draft)).toEqual(expected);
  });

  it.each([
    ["direkt vor marker", "PROTON_LOG=1 %command%"],
    ["über env vor marker", "env PROTON_LOG=1 %command%"],
    ["assignmentgruppe, env und gamemoderun", "A=1 env PROTON_LOG=1 gamemoderun %command%"],
    ["gamemoderun vor marker", "PROTON_LOG=1 gamemoderun %command%"],
  ])("erkennt aktiviertes Proton-Logging: %s", (_label, draft) => {
    expect(analyzeLaunchOptions(draft)).toEqual(["proton-log-enabled"]);
  });

  it.each([
    ["nullwert", "PROTON_LOG=0 %command%"],
    ["führende null", "PROTON_LOG=01 %command%"],
    ["wahrheitswort", "PROTON_LOG=true %command%"],
    ["ähnlicher name", "PROTON_LOG_LEVEL=1 %command%"],
    ["kleinschreibung", "proton_log=1 %command%"],
    ["hinter marker", "%command% PROTON_LOG=1"],
    ["hinter gamemoderun ohne marker", "gamemoderun PROTON_LOG=1"],
  ])("aktiviert Logging nicht: %s", (_label, draft) => {
    expect(analyzeLaunchOptions(draft)).toEqual(
      draft === "%command% PROTON_LOG=1"
        ? ["assignment-after-command"]
        : draft === "gamemoderun PROTON_LOG=1"
          ? ["gamemode-missing-command"]
          : [],
    );
  });

  it("liefert Hinweise in fester Reihenfolge und ohne Duplikate", () => {
    expect(analyzeLaunchOptions("PROTON_LOG=1 gamemoderun %command% A=1 A=2")).toEqual([
      "assignment-after-command",
      "proton-log-enabled",
    ]);
  });

  it.each([
    ["doppelte Variable in führender Gruppe", "A=1 A=2 %command%"],
    ["doppelte Variable über env-Gruppen", "A=1 env A=2 %command%"],
    ["doppeltes Proton-Logging-Assignment", "PROTON_LOG=1 PROTON_LOG=0 %command%"],
    ["doppeltes Proton-Logging-Assignment über env", "env PROTON_LOG=1 PROTON_LOG=0 %command%"],
    ["marker im Assignmentwert", "X=%command% gamemoderun"],
    ["zusammengeklebte Marker", "gamemoderun %command%%command%"],
    ["mehrere Marker", "PROTON_LOG=1 %command% %command%"],
    ["eingebetteter Marker", "gamemoderun abc%command%def"],
  ])("verwirft konservativ %s", (_label, draft) => {
    expect(analyzeLaunchOptions(draft)).toEqual([]);
  });

  it.each([
    ["einfaches Anführungszeichen", "gamemoderun '%command%'"],
    ["doppeltes Anführungszeichen", 'gamemoderun "%command%"'],
    ["Backslash", "gamemoderun \\ %command%"],
    ["Zeilenumbruch", "gamemoderun\n%command%"],
    ["Dollar", "gamemoderun $HOME %command%"],
    ["Backtick", "gamemoderun `date` %command%"],
    ["Semikolon", "gamemoderun; %command%"],
    ["Ampersand", "gamemoderun & %command%"],
    ["Pipe", "gamemoderun | %command%"],
    ["Redirect", "gamemoderun < %command%"],
    ["Klammern", "gamemoderun (x) %command%"],
    ["Shell-Glob stern", "gamemoderun * %command%"],
    ["Shell-Glob frage", "gamemoderun ? %command%"],
    ["Shell-Glob eckig", "gamemoderun [x] %command%"],
    ["Shell-Glob geschweift", "gamemoderun {x} %command%"],
    ["Unicode-Leerzeichen", "gamemoderun\u00a0%command%"],
    ["Zeilenumbruch am Ende ohne Marker", "gamemoderun foo\n"],
    ["Zeilenumbruch am Ende nach Assignment", "%command% A=1\n"],
    ["Wagenrücklauf am Ende", "gamemoderun foo\r"],
    ["C0-Steuerzeichen am Ende", "gamemoderun foo\u0000"],
    ["C1-Steuerzeichen am Ende", "gamemoderun foo\u0085"],
  ])("meldet keine Hinweise bei %s", (_label, draft) => {
    expect(analyzeLaunchOptions(draft)).toEqual([]);
  });

  it("akzeptiert die engen Assignment-Werte und den leeren Wert", () => {
    expect(analyzeLaunchOptions("A= %command%")).toEqual([]);
    expect(analyzeLaunchOptions("A=a0_./:+,@%- %command%")).toEqual([]);
  });

  it("verwirft einen nicht erlaubten Assignment-Wert im Präfix", () => {
    expect(analyzeLaunchOptions("A=value~ %command%")).toEqual([]);
  });

  it("behandelt exakt 8192 UTF-16-Codeeinheiten als gültiges Limit", () => {
    const draft = `gamemoderun ${"a".repeat(8180)}`;
    expect(draft.length).toBe(8192);
    expect(analyzeLaunchOptions(draft)).toEqual(["gamemode-missing-command"]);
  });

  it("verwirft einen überlangen Entwurf ohne Abschneiden", () => {
    const draft = `gamemoderun ${"a".repeat(8181)}`;
    expect(draft.length).toBe(8193);
    expect(analyzeLaunchOptions(draft)).toEqual([]);
  });
});
