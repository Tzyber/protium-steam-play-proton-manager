# protium

**deutsch** · [english](README.en.md)

[![CI](https://github.com/Tzyber/protium-steam-play-proton-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/Tzyber/protium-steam-play-proton-manager/actions/workflows/ci.yml)

> ein proton. ein elektron. das simpelste atom im universum, und ungefähr so viel overhead soll auch dieses tool haben.

aufmachen, spiel starten oder startoptionen setzen, verwaiste prefixes löschen,
proton-versionen nachladen. so viel, und trotzdem an einem ort.

protium zeigt dir, was auf deinem system wirklich los ist: welche spiele über
welche proton-version laufen, wie die auf protondb bewertet sind, welche
GE-proton-versionen ungenutzt platz fressen und welche prefixes von längst
deinstallierten spielen noch gigabytes belegen.

entstanden, weil es genau dieses tool nicht gab. protonup-qt managt nur
versionen. protontricks ist ein winetricks-wrapper. steamtinkerlaunch kann
alles und ist genau deshalb unübersichtlich. der erste scan mit protium zeigte
sofort einen unterschied zwischen der proton-version, die ich eingestellt
glaubte, und der, die tatsächlich lief.

![library-ansicht: cover-grid mit protondb-tiers, proton-zuordnung und filtern](docs/screenshots/main_page.png)

![proton-manager: installierte versionen mit nutzung, GE-releases zum installieren](docs/screenshots/proton_page.png)

![cleanup-ansicht: tabs für shader-caches, wine-prefixes und papierkorb](docs/screenshots/cleanup_view.png)

## installieren

fertige AppImage von der [releases-seite](https://github.com/Tzyber/protium-steam-play-proton-manager/releases)
laden, ausführbar machen, starten:

```sh
chmod +x protium_0.2.9_amd64.AppImage
./protium_0.2.9_amd64.AppImage
```

die AppImage ist nicht signiert. wer das nicht mag, baut selbst (siehe
dev-setup) oder wartet auf das AUR-paket.

startet nichts und es kommt keine fehlermeldung, fehlt meist fuse2. dann
entweder `sudo pacman -S fuse2` oder einmalig ohne fuse starten:

```sh
./protium_0.2.9_amd64.AppImage --appimage-extract-and-run
```

## was es kann

**library-übersicht.** alle spiele über alle libraries, auch auf externen
platten, mit cover, größe, zugewiesener proton-version und protondb-tier direkt
auf der karte. cover kommen aus steams lokalem librarycache, die app
funktioniert also komplett offline.

**GE-proton-manager.** installierte versionen mit größe und der info, welche
spiele sie tatsächlich nutzen. neue releases direkt von github installieren
(streaming-download mit sha512-prüfung, abbrechbar, mit aufräumen der
partiellen datei), ungenutzte löschen. distro-protons wie proton-cachyos werden
erkannt und als read-only markiert. die gehören dem paketmanager, nicht uns.

**compat-tool und startoptionen.** proton-version und startoptionen pro spiel
direkt setzen. write-gate davor (steam-läuft-check, backup, atomarer rename),
und ein chirurgischer vdf-string-patch statt voll-serialisierung, weil steams
escaping und schlüsselreihenfolge sonst nicht erhalten bleiben.

**cleanup.** verwaiste wine-prefixes und shader-caches finden und bereinigen, in
drei getrennten bereichen: shader-caches, wine-prefixes, papierkorb.
shader-caches werden hart gelöscht. prefixes wandern innerhalb desselben
dateisystems in den papierkorb. erst beim leeren wird der platz frei.

**spiele starten.** über `steam://rungameid/<appId>`. kein eigener launcher,
keine prozess-überwachung.

**fehlerfälle.** was nicht lesbar ist, steht als nicht lesbar da, nicht als
leerer wert. destruktive aktionen fragen vorher und zeigen konkret, was
passieren würde. wo es geht, gibt es einen rückweg.

**bedienbarkeit.** vollständig mit der tastatur bedienbar, sichtbare
focus-states, tabs nach WAI-ARIA-pattern (pfeiltasten, roving tabindex),
kontraste auf WCAG-AA geprüft, `prefers-reduced-motion` global respektiert.
schriftgrößen in `rem`, damit die app mit der system-schriftgröße mitwächst.
oberfläche auf deutsch und englisch, key-parität durch einen test abgesichert.

### unterstützte steam-installationen

- **nativ**: `~/.local/share/Steam` und `~/.steam/steam`
- **flatpak**: `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`
- **symlinks und custom-pfade**: `discoverSteamRoot` löst symlinks via `realpath` auf

snap (`~/snap/steam/`) ist ab 0.1.7 enthalten, aber nur gegen fixtures
getestet. auf einem echten snap-system hat das noch niemand verifiziert.

### prefix aus dem papierkorb zurückholen

protium hat bewusst **keine** wiederherstellungs-funktion. sobald ein spiel neu
installiert ist, existiert `compatdata/<appId>` wieder, und ein automatisches
zurückschieben müsste entscheiden, welcher stand gilt. dazu kommt, dass ein
prefix von einer anderen proton-version stammen kann als die aktuell
eingestellte. das sind entscheidungen für den menschen, nicht für ein tool.

von hand ist es ein `mv`. der papierkorb liegt in derselben library, der eintrag
heißt `compatdata_<appId>_<zeitstempel>`:

```sh
cd /pfad/zur/SteamLibrary/steamapps
ls .protium-trash                       # eintrag finden
mv .protium-trash/compatdata_1477940_1785071505657 compatdata/1477940
```

wichtig: das ziel `compatdata/<appId>` darf nicht schon existieren. tut es das,
hast du zwei stände. dann erst den vorhandenen wegsichern und danach
entscheiden. steam legt einen fehlenden prefix beim nächsten spielstart selbst
neu an, dann ohne die alten spielstände.

## stack

tauri v2 als shell, vue 3 und typescript für UI und domänenlogik, rust nur für
das, was die webview nicht darf. kein electron, das binary bleibt klein und
nutzt die system-webview (webkit2gtk).

konkret übernimmt rust nur: etwas über 1000 produktive zeilen für
pfad-validierung, streaming-downloads mit hash, tarball-extraktion, die beiden
löschbefehle, prozess-check und fs-scope-freigabe. geschäftslogik und
UI-entscheidungen liegen nicht in dieser schicht. dazu kommen knapp 1800
testzeilen, fast doppelt so viele wie produktivcode, denn diese pfade verändern
und löschen dateien.

die domänenlogik in `src/core/` ist komplett UI-frei und redet mit dem system
nur über ports und adapter. dadurch läuft die gesamte core-testsuite headless
gegen fixtures, ohne tauri, ohne steam, ohne netz.

## dev-setup

voraussetzungen (cachyos/arch):

```sh
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl librsvg
rustup default stable   # falls rust fehlt: sudo pacman -S rustup
```

dann:

```sh
npm install
npm test              # vitest, core headless gegen fixtures
npm run check         # biome (194 lint-regeln, 0 warnings) + vue-tsc --noEmit
(cd src-tauri && cargo test)   # rust: downloads, pfad-validierung, extraktion, cleanup
npm run tauri dev     # app starten (erster build kompiliert rust, dauert)
```

`npm run check`, `npm test` und die cargo-tests laufen zusätzlich in der CI bei
jedem push und pull request.

cache liegt unter `~/.cache/com.protium.desktop/`.

### abhängigkeiten und advisories

```sh
(cd src-tauri && cargo audit)
```

`.cargo/audit.toml` listet advisories, die bewusst getragen werden, jeweils
per ID mit begründung, damit ein **neuer** advisory weiterhin anschlägt.
betrifft im wesentlichen tauris GTK3-stack (die gtk-rs-bindings sind
unmaintained, gtk-rs ist auf GTK4 umgezogen) und build-time-only-crates.
wiedervorlage, sobald tauri auf gtk-rs 0.20 geht.

## struktur

```
src/core/                    domänenlogik, UI-frei. redet nur über ports
src/core/adapters/tauri.ts   ports gegen plugin-fs/http + rust-commands
src/ui/                      vue-app: library, proton-manager, cleanup, i18n
src-tauri/                   rust-commands (extract, download, prozess-check,
                             dir-size, fs-scope, löschpfade)
tests/                       vitest gegen fake-steam-fixtures
docs/                        screenshots, smoke-checkliste
```

regeln für die implementierung: schreibende zugriffe auf steam-dateien laufen
ausnahmslos durch das write-gate. destruktive aktionen fragen immer nach und
zeigen konkret, was passieren würde. pfadwissen kommt aus `paths.ts` und nicht
aus zusammengebauten strings. netzwerkausfall darf features verarmen, aber nie
die app blockieren. was sich nicht zuverlässig bestimmen lässt, heißt in der UI
`unbekannt`.

## roadmap

- [x] phase 1: core data layer (scan, vdf-parsing, protondb, multi-library inkl. externer mounts)
- [x] phase 2: library-UI (cover-grid, tiers, warnings, such/filter/sort)
- [x] phase 3: GE-proton-manager (install/remove, queue, distro-tool-erkennung, downloads abbrechen)
- [x] game-detail-drawer mit protondb-link
- [x] phase 4: compat-tool und startoptionen setzen (write-gate, backups, vdf-string-patch)
- [x] phase 5: cleanup verwaister prefixes und shader-caches, papierkorb
- [x] spiele starten (steam-protokoll, kein eigener launcher)
- [x] i18n (deutsch/englisch)
- [x] CI: lint, typecheck und tests bei jedem push
- [x] phase 6 (teil 1): AppImage-build in der CI
- [ ] phase 6 (teil 2): AUR-paket

versionshistorie steht in den [releases](https://github.com/Tzyber/protium-steam-play-proton-manager/releases).

## offene punkte

keine sicherheitsprobleme, eher wartung. abarbeitung bei gelegenheit,
reihenfolge ist keine priorität.

- `scanLibrary` aufteilen (`scan.ts`, 164 zeilen, 7 concerns), als eigener
  zyklus und nicht im vorbeigehen

## status

in aktiver entwicklung. api und UI ändern sich ohne vorwarnung. die roadmap
beschreibt den aktuellen stand, sie ist keine zusage für kommende versionen.
