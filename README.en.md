# protium

[deutsch](README.md) · **english**

[![CI](https://github.com/Tzyber/protium-steam-play-proton-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/Tzyber/protium-steam-play-proton-manager/actions/workflows/ci.yml)

> one proton. one electron. the simplest atom in the universe, and roughly the amount of overhead this tool is meant to have.

open it, start a game or set launch options, delete orphaned prefixes, pull down proton versions. that much, and still in one place.

protium shows you what is actually going on on your system: which games run on which proton version, how those are rated on protondb, which GE-proton versions are eating space unused, and which prefixes from long-uninstalled games still occupy gigabytes.

it came into being because this exact tool did not exist. protonup-qt only manages versions. protontricks is a winetricks wrapper. steamtinkerlaunch does everything and is unwieldy for exactly that reason. the first scan with protium immediately revealed a difference between the proton version I thought I had set and the one that was actually running.

![library view: cover grid with protondb tiers, proton assignment and filters](docs/screenshots/main_page.png)

![proton manager: installed versions with usage, GE releases to install](docs/screenshots/proton_page.png)

![cleanup view: tabs for shader caches, wine prefixes and trash](docs/screenshots/cleanup_view.png)

## installing

grab the ready-made AppImage from the [releases page](https://github.com/Tzyber/protium-steam-play-proton-manager/releases), make it executable, run it:

```sh
chmod +x protium_0.2.7_amd64.AppImage
./protium_0.2.7_amd64.AppImage
```

the AppImage is not signed. if you don't like that, build it yourself (see dev setup) or wait for the AUR package.

if nothing starts and no error message appears, fuse2 is usually missing. then either `sudo pacman -S fuse2` or run it once without fuse:

```sh
./protium_0.2.7_amd64.AppImage --appimage-extract-and-run
```

## what it does

**library overview.** every game across every library, external drives included, with cover art, size, assigned proton version and protondb tier right on the card. covers come from steam's local librarycache, so the app works fully offline.

**GE-proton manager.** installed versions with size and the information which games actually use them. install new releases straight from github (streaming download with sha512 verification, cancellable, partial file cleaned up), remove unused ones. distro protons such as proton-cachyos are detected and marked read-only. they belong to the package manager, not to us.

**compat tool and launch options.** set the proton version and launch options per game. write gate in front (steam-is-running check, backup, atomic rename), and a surgical vdf string patch instead of full serialisation, because otherwise steam's escaping and key order do not survive.

**cleanup.** find and clear orphaned wine prefixes and shader caches, in three separate areas: shader caches, wine prefixes, trash. shader caches are deleted outright. prefixes move to the trash within the same filesystem. space is freed only when the trash is emptied.

**launching games.** via `steam://rungameid/<appId>`. no launcher of its own, no process supervision.

**failure cases.** what is unreadable is shown as unreadable, not as an empty value. destructive actions ask beforehand and show concretely what would happen. where possible, there is a way back.

**accessibility.** fully keyboard operable, visible focus states, tabs following the WAI-ARIA pattern (arrow keys, roving tabindex), contrasts checked against WCAG AA, `prefers-reduced-motion` respected globally. font sizes in `rem` so the app scales with the system font size. interface in german and english, key parity guarded by a test.

### supported steam installations

- **native**: `~/.local/share/Steam` and `~/.steam/steam`
- **flatpak**: `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`
- **symlinks and custom paths**: `discoverSteamRoot` resolves symlinks via `realpath`

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

concretely, rust only handles: just over 1000 productive lines for path validation, streaming downloads with hashing, tarball extraction, the two delete commands, process check and fs scope grants. domain logic and UI decisions do not live in this layer. plus nearly 1800 lines of tests, almost twice as many as production code, because these paths modify and delete files.

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
- [ ] phase 6 (part 2): AUR package

version history lives in the [releases](https://github.com/Tzyber/protium-steam-play-proton-manager/releases).

## open points

no security issues, rather maintenance. worked through when convenient, order is not a priority.

- split up `scanLibrary` (`scan.ts`, 164 lines, 7 concerns), as its own cycle and not in passing

## status

under active development. api and UI change without notice. the roadmap describes the current state; it is not a promise of future versions.

written with AI support, designed and owned by me. if you see a claude in the contributors list: that comes from `Co-Authored-By` trailers. he does not appear in the commit graph because he never pushed anything there.
