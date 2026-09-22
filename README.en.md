# protium

[deutsch](README.md) · **english**

[![CI](https://github.com/Tzyber/protium-steam-play-proton-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/Tzyber/protium-steam-play-proton-manager/actions/workflows/ci.yml)

**on my very first scan I saw that a game was set to a completely different
proton version than the one I thought I had set.** that is what protium is for.

protium shows you what Steam has actually set up on your machine, and it tells
you how sure it is. there is a question mark at the places that matter. behind
it you find where a value comes from, what it means, and what it does not mean.
when protium does not know something, it says so instead of guessing.

what you can do: start games, set launch options, install new proton versions,
see how well a game runs according to protondb, and find and clear out leftover
data from games you deleted long ago. all in one window.

it came into being because this exact tool did not exist. protonup-qt only
manages versions. protontricks is a winetricks wrapper. steamtinkerlaunch does
everything and is unwieldy for exactly that reason.

> one proton. one electron. the simplest atom in the universe, and roughly the amount of overhead this tool is meant to have.

### what you get to see

every value that claims something can explain itself. where it comes from,
what it means, and explicitly what it does not mean:

![explanation window in the game drawer with source, meaning and a "does not mean" line](docs/screenshots/explain_dialog.png)

the library shows your games with their protondb rating and the tool Steam
actually assigns to them. you can filter by that too:

![library view: cover grid with protondb tiers, proton assignment and filters](docs/screenshots/main_page.png)

the proton section shows which versions are installed and which games depend
on them. new GE versions come straight from github:

![proton manager: installed versions with game mappings, GE releases to install](docs/screenshots/proton_page.png)

cleanup finds shader caches, wine prefixes from games you deleted long ago and
the trash, each with its size. nothing gets deleted without asking, and only
when protium is sure:

![cleanup view: tabs for shader caches, wine prefixes and trash](docs/screenshots/cleanup_view.png)

## installing

grab the AppImage or Debian package from the [releases page](https://github.com/Tzyber/protium-steam-play-proton-manager/releases). make the AppImage executable and run it:

current version: `v0.10.1`.

```sh
chmod +x protium_0.10.1_amd64.AppImage
./protium_0.10.1_amd64.AppImage
```

each release ships the AppImage, the Debian package, `SHA256SUMS` and
`SHA256SUMS.asc`. the checksum file is signed with the project key, and both
artifacts are additionally bound to the workflow and commit by a GitHub build
attestation. put all four files in the same folder and verify there:

```sh
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS
gh attestation verify protium_<version>_amd64.AppImage --repo Tzyber/protium-steam-play-proton-manager
gh attestation verify protium_<version>_amd64.deb --repo Tzyber/protium-steam-play-proton-manager
```

the AppImage bundles GTK and WebKit but expects the usual desktop libraries
(X11, GL, fontconfig, harfbuzz, FriBidi). it starts under X11 or through
XWayland; on a Wayland system without XWayland it does not start.

key fingerprint: `08C084ECC83DFDB10E5CF60A8B2CA074A44AC4FA` (also in
[SECURITY.md](SECURITY.md) and on keys.openpgp.org). compare it through a
second channel before you trust the signature.

the attestation binds to the repository, workflow and commit, not to a
person: anyone with write access to repository and tag can produce a matching
attestation. the GPG signature is the only GitHub-independent proof. it holds
only as long as the fingerprint is confirmed.

if you don't like that, build it yourself (see dev setup). Debian-based
systems can install the accompanying Debian package:

```sh
sudo apt install ./protium_0.10.1_amd64.deb
```

if nothing starts and no error message appears, fuse2 is usually missing. then either `sudo pacman -S fuse2` or run it once without fuse:

```sh
./protium_0.10.1_amd64.AppImage --appimage-extract-and-run
```

## what it does

**library overview.** every game across every library, external drives included, with cover art, size, the proton version assigned in Steam's configuration and protondb tier right on the card. the local scan appears immediately; protondb follows in the background. proton-check filters only `bronze`, `borked` and explicit tools not recognised in this scan. Steam and library files are read through a current, backend-canonical environment snapshot; local covers arrive as short-lived blob URLs from a bounded backend binary read. The app still works offline without granting local Steam paths to the webview.

**GE-proton manager.** installed versions with size and the information which
games have a known explicit mapping. install new releases straight from github
(streaming download with sha512 verification, cancellable, partial file
cleaned up), remove installed versions. distro protons such as proton-cachyos
are detected and marked read-only. they belong to the package manager, not to
us.

**GE mapping and prefix folder.** the proton manager summarizes the count
and measured size of tools with known explicit mappings. missing sizes remain
“not measured” or “partially measured”. the explanation button states the
source and limits: no known mapping does not prove a tool is unused. removing
a GE tool leaves its games' prefix folders untouched.

“Open prefix folder” in the game drawer launches the file manager for the freshly
validated standard prefix. external target hints and unclear launch options
disable the action with a visible reason. the same conservative detection also
leaves the compatdata part of the storage footprint unmeasured, because the
standard target is then not established. clicking does not measure storage or
create a folder. “File manager launched” confirms the start, not a visible
window. path handoff and its limits are described in [SECURITY.md](SECURITY.md).

**compat tool and launch options.** set the proton version and launch options per game. write gate in front (steam-is-running check, backup, atomic rename), and a surgical vdf string patch instead of full serialisation, because otherwise steam's escaping and key order do not survive.

**cleanup.** find and clear orphaned wine prefixes and shader caches, in three separate areas: shader caches, wine prefixes, trash. shader caches are deleted outright. prefixes move to the trash within the same filesystem. space is freed only when the trash is emptied.

confirmation runs in the Vue dialog in the main window. the backend binds the
target, consequences, token, live checks and claim; the webview confirmation
itself is deliberately not a tamper-proof security boundary.

**launching games.** via `steam://rungameid/<appId>`. no launcher of its own, no process supervision.

**failure cases.** what is unreadable is shown as unreadable, not as an empty value. destructive actions ask beforehand and show concretely what would happen. where possible, there is a way back.

**explanations and diagnostic evidence.** a question-mark button explains technical values right where they appear (config states, tool source, scan coverage, footprint, protondb, cleanup blockades, incomplete deletions) with source, meaning and what the value explicitly does not mean; the terms follow the [glossary](docs/glossar.md). "copy technical information" puts a privacy-conscious report into the clipboard: fixed labels including Valve tool labels, status values, validated numbers, format-checked GE tool names and report-local aliases. other tool names remain aliased; game names, paths and config contents are omitted. an allowed tool name proves neither origin nor installation and does not guarantee complete anonymity; see the [security policy](SECURITY.md#export-allowlist-und-zwischenablage). conservative hints in the launch-options draft warn about gamemoderun without `%command%`, an assignment behind `%command%` and an enabled `PROTON_LOG=1` assignment.

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

concretely, rust only handles: roughly 7700 productive lines for environment discovery and snapshot-authorised reads, path validation, streaming downloads with hashing, tarball extraction, the delete commands, the write gate and the process check. domain logic and UI decisions do not live in this layer. plus roughly 9100 lines of tests: the paths that modify or delete files carry more tests than the rest. Counted on 2026-09-22, production lines without test modules, `*_tests.rs` counted as tests.

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
- [x] v0.7.0: game footprint in the drawer
- [x] v0.7.1: refactored Rust layer, larger cleanup in manageable steps,
  clearer search and trash handling
- [x] v0.8.0: explainability (explanation buttons with source, meaning and
  limit), a data-minimal diagnostic record for copying and conservative
  launch-option/`PROTON_LOG` hints
- [x] v0.8.1: smaller fixes after a review
- [x] v0.9.0: readable support record, honest GE mapping summary and the
  "open prefix folder" workflow
- [x] v0.10.0: signed checksums, build attestation and immutable releases,
  plus complete package metadata and AppStream data
- [x] v0.10.1: the Wayland hook now finds the system library on distributions
  without development packages

version history lives in the [releases](https://github.com/Tzyber/protium-steam-play-proton-manager/releases).

## what comes next

protium does not need to finish quickly. 1.0 is not a deadline but the end of
the journey: reached when the application is consistent with itself. new
versions only belong here when they make local Steam data clearer, without a
daemon and without auto-repair. the list grows when something turns up in use,
and it is not a promise.

first:

- **error messages in plain language.** today the interface sometimes shows a
  raw string from the backend, sometimes German, sometimes English. the plan
  is fixed classes (unavailable, unreadable, incomplete, not found, unknown,
  blocked) maintained in both languages.
- **"why is this blocked".** when protium refuses something, it should say
  exactly what was checked and what is missing.
- **go through accessibility** and check it automatically.
- **a speed baseline** in CI so a scan that got slower is noticed.
- **allow only one instance** and make the backups of Steam files visible.
- **diagnostics on your own machine:** an error boundary and a log file that
  stays local.

later, if it is worth it:

- remember language and window size, plus a language switch
- updates from inside the application
- apply one change to several games at once
- find Flatpak and Snap installations of Steam
- make the AppImage smaller or stay with the system WebKit

at the very end, and only if it ever happens: an AUR package so Arch users can
install protium through their package manager. No deadline, no promise.

the binding internal product plan is `protium-roadmap-v2(1).md`; older roadmap
documents in the repository are historical. every release still needs its own
accepted spec; Steam writes and deletions additionally need renewed explicit
approval.

## open points

small maintenance items, done when convenient, no priority:

- mention prefix and shader cache presence in the support record
- show "still loading" instead of "no rating" while ProtonDB is fetching
- cover loading time with large libraries
- do not re-ask ProtonDB for games without a report on every scan

## status

under active development. api and UI change without notice. the roadmap describes the current state; it is not a promise of future versions.
