# protium

[deutsch](README.md) · **english**

[![CI](https://github.com/Tzyber/protium-steam-play-proton-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/Tzyber/protium-steam-play-proton-manager/actions/workflows/ci.yml)

> one proton. one electron. the simplest atom in the universe, and roughly the amount of overhead this tool is meant to have.

open it, start a game or set launch options, delete orphaned prefixes, pull down proton versions. that much, and still in one place.

protium shows you what is actually going on on your system: which proton
version Steam assigns to each game in its configuration, how those are rated
on protondb, which GE-proton versions have known explicit game mappings, and
which prefixes from long-uninstalled games still occupy gigabytes.

it came into being because this exact tool did not exist. protonup-qt only manages versions. protontricks is a winetricks wrapper. steamtinkerlaunch does everything and is unwieldy for exactly that reason. the first scan with protium immediately revealed a difference between the proton version I thought I had set and the one assigned in Steam's configuration.

![library view: cover grid with protondb tiers, proton assignment and filters](docs/screenshots/main_page.png)

![proton manager: installed versions with game mappings, GE releases to install](docs/screenshots/proton_page.png)

![cleanup view: tabs for shader caches, wine prefixes and trash](docs/screenshots/cleanup_view.png)

## installing

grab the AppImage or Debian package from the [releases page](https://github.com/Tzyber/protium-steam-play-proton-manager/releases). make the AppImage executable and run it:

```sh
chmod +x protium_0.6.5_amd64.AppImage
./protium_0.6.5_amd64.AppImage
```

the AppImage is not signed. if you don't like that, build it yourself (see dev setup). Debian-based systems can install the accompanying Debian package:

```sh
sudo apt install ./protium_0.6.5_amd64.deb
```

if nothing starts and no error message appears, fuse2 is usually missing. then either `sudo pacman -S fuse2` or run it once without fuse:

```sh
./protium_0.6.5_amd64.AppImage --appimage-extract-and-run
```

## what it does

**library overview.** every game across every library, external drives included, with cover art, size, the proton version assigned in Steam's configuration and protondb tier right on the card. the local scan appears immediately; protondb follows in the background. proton-check filters only `bronze`, `borked` and explicit tools not recognised in this scan. Steam and library files are read through a current, backend-canonical environment snapshot; local covers arrive as short-lived blob URLs from a bounded backend binary read. The app still works offline without granting local Steam paths to the webview.

**GE-proton manager.** installed versions with size and the information which
games have a known explicit mapping. install new releases straight from github
(streaming download with sha512 verification, cancellable, partial file
cleaned up), remove installed versions. distro protons such as proton-cachyos
are detected and marked read-only. they belong to the package manager, not to
us.

**compat tool and launch options.** set the proton version and launch options per game. write gate in front (steam-is-running check, backup, atomic rename), and a surgical vdf string patch instead of full serialisation, because otherwise steam's escaping and key order do not survive.

**cleanup.** find and clear orphaned wine prefixes and shader caches, in three separate areas: shader caches, wine prefixes, trash. shader caches are deleted outright. prefixes move to the trash within the same filesystem. space is freed only when the trash is emptied.

confirmation runs in the Vue dialog in the main window. the backend binds the
target, consequences, token, live checks and claim; the webview confirmation
itself is deliberately not a tamper-proof security boundary.

**launching games.** via `steam://rungameid/<appId>`. no launcher of its own, no process supervision.

**failure cases.** what is unreadable is shown as unreadable, not as an empty value. destructive actions ask beforehand and show concretely what would happen. where possible, there is a way back.

**accessibility.** fully keyboard operable, visible focus states, tabs following the WAI-ARIA pattern (arrow keys, roving tabindex), contrasts checked against WCAG AA, `prefers-reduced-motion` respected globally. font sizes in `rem` so the app scales with the system font size. interface in german and english, key parity guarded by a test.

### supported steam installations

- **native**: `~/.local/share/Steam` and `~/.steam/steam`
- **flatpak**: `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`
- **discovery**: `discover_steam_environment` resolves only fixed candidates
  from the backend home directory and reads libraries from `libraryfolders.vdf`;
  webview-supplied library paths are not trusted.
- **symlinks**: root and library symlinks are canonicalised by the backend and
  checked against the current snapshot for every environment read.

snap (`~/snap/steam/`) is included from 0.1.7, but only tested against fixtures. nobody has verified it on a real snap system yet.

### restoring a prefix from the trash

protium deliberately has **no** restore function. once a game is reinstalled, `compatdata/<appId>` exists again, and moving something back automatically would have to decide which state wins. on top of that, a prefix may originate from a different proton version than the one currently selected. those are decisions for a human, not for a tool.

by hand it is one `mv`. the trash lives in the same library, the entry is named `compatdata_<appId>_<timestamp>`:

```sh
cd /path/to/SteamLibrary/steamapps
ls .protium-trash                       # find the entry
mv .protium-trash/compatdata_1477940_1785071505657 compatdata/1477940
```

important: the target `compatdata/<appId>` must not already exist. if it does, you have two states. back up the existing one first, then decide. steam recreates a missing prefix on the next launch, then without the old savegames.

## stack

tauri v2 as the shell, vue 3 and typescript for UI and domain logic, rust only for what the webview is not allowed to do. no electron; the binary stays small and uses the system webview (webkit2gtk).

concretely, rust only handles: just over 1000 productive lines for environment discovery and snapshot-authorised reads, path validation, streaming downloads with hashing, tarball extraction, the two delete commands and the process check. domain logic and UI decisions do not live in this layer. plus nearly 1800 lines of tests, almost twice as many as production code, because these paths modify and delete files.

the domain logic in `src/core/` is entirely UI-free and talks to the system only through ports and adapters. that lets the whole core test suite run headless against fixtures, no tauri, no steam, no network.

## dev setup

prerequisites (cachyos/arch):

```sh
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl librsvg
rustup default stable   # if rust is missing: sudo pacman -S rustup
```

then:

```sh
npm install
npm test              # vitest, core headless against fixtures
npm run check         # biome (194 lint rules, 0 warnings) + vue-tsc --noEmit
(cd src-tauri && cargo test)   # rust: downloads, path validation, extraction, cleanup
npm run tauri dev     # start the app (the first build compiles rust, takes a while)
```

`npm run check`, `npm test` and the cargo tests also run in CI on every push and pull request.

the cache lives in `~/.cache/com.protium.desktop/`.

### dependencies and advisories

```sh
(cd src-tauri && cargo audit)
```

`.cargo/audit.toml` lists advisories that are knowingly accepted, each by ID with a reason, so that a **new** advisory still trips the check. these mostly concern tauri's GTK3 stack (the gtk-rs bindings are unmaintained; gtk-rs moved on to GTK4) and build-time-only crates. to be revisited once tauri moves to gtk-rs 0.20.

## layout

```
src/core/                    domain logic, UI-free. talks only through ports
src/core/adapters/tauri.ts   ports against plugin-fs/http + rust commands
src/ui/                      vue app: library, proton manager, cleanup, i18n
src-tauri/                   rust commands (extract, download, process check,
                             dir size, fs scope, delete paths)
tests/                       vitest against fake-steam fixtures
docs/                        screenshots, smoke checklist
```

rules for the implementation: writes to steam files go through the write gate without exception. destructive actions always ask and show concretely what would happen. path knowledge comes from `paths.ts`, not from assembled strings. a network outage may impoverish features but must never block the app. if a value cannot be determined reliably, the UI says `unknown`.

## roadmap

- [x] phase 1: core data layer (scan, vdf parsing, protondb, multi-library incl. external mounts)
- [x] phase 2: library UI (cover grid, tiers, warnings, search/filter/sort)
- [x] phase 3: GE-proton manager (install/remove, queue, distro tool detection, cancellable downloads)
- [x] game detail drawer with protondb link
- [x] phase 4: setting compat tool and launch options (write gate, backups, vdf string patch)
- [x] phase 5: cleanup of orphaned prefixes and shader caches, trash
- [x] launching games (steam protocol, no launcher of its own)
- [x] i18n (german/english)
- [x] CI: lint, typecheck and tests on every push
- [x] phase 6 (part 1): AppImage build in CI
- [x] v0.5.0: library first, protondb follow-up and proton-check
- [x] v0.6.0: scan truth with clear coverage and local detail facts
- [x] v0.6.1: incomplete deletions (claim restore, claim leftovers in cleanup)

version history lives in the [releases](https://github.com/Tzyber/protium-steam-play-proton-manager/releases).

## next

protium does not need to finish quickly. new versions only belong here when
they make local Steam data clearer without a daemon or auto-repair. with
this direction ahead:

- v0.7.0: game footprint in the drawer (known local storage per game,
  without a full-disk scan)
- v0.8.0: explainability and a data-minimal diagnostic record (copyable,
  without private paths, accounts or upload)
- v0.9.0: GE reference analysis (known explicit game mappings per GE
  version, without an "unused" claim)
- v1.0.0: consolidation (consistency, error semantics, security and
  accessibility review)

the order is a direction, not a promise. if something more important comes
up in between (like v0.6.1 after v0.6.0), the rest shifts.

## open points

open maintenance items. security boundaries are reviewed separately and before
refactors. work proceeds as convenient; the order is not a priority.

## status

under active development. api and UI change without notice. the roadmap describes the current state; it is not a promise of future versions.
