use std::ffi::OsStr;
use std::path::Path;

use crate::commands::errcode;
use std::process::{Command, Stdio};

// Externe URLs für Browser und Steam-Handler.

/// Erlaubte externe Ziele sind auf die von der Anwendung erzeugten Muster begrenzt:
/// protondb-spielseiten, das protium-repo, und steam://rungameid/<appid>.
/// die allowlist verhindert nebenbei argument-injection: eine url, die mit
/// "-" beginnt, kommt hier nie durch (xdg-open läse sie als option).
///
/// Pfad-Pinning: Nur den Host zu prüfen ließe
/// jede unterseite des hosts durch (open-redirect/phishing). erlaubt sind
/// nur die exakten pfadmuster, die die app selbst baut.
pub(super) fn validate_external_url(url: &str) -> Result<(), String> {
    if let Some(app_id) = url.strip_prefix("steam://rungameid/") {
        return if !app_id.is_empty() && app_id.bytes().all(|b| b.is_ascii_digit()) {
            Ok(())
        } else {
            Err(errcode::INVALID_APPID.into())
        };
    }
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| errcode::with_detail(errcode::INVALID_URL, error))?;
    // gemeinsame basis mit dem download-pfad (r-13); der dortige port-443-zwang
    // gilt hier bewusst nicht.
    crate::commands::download::validate_https_credentials(&parsed)?;
    match parsed.host_str().map(|h| h.to_ascii_lowercase()).as_deref() {
        // protondb: nur spielseiten /app/<appId> (das frontend baut genau diese)
        Some("www.protondb.com") => {
            let rest = parsed
                .path()
                .strip_prefix("/app/")
                .ok_or_else(|| errcode::with_detail(errcode::INVALID_URL, "protondb path"))?;
            if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) {
                Ok(())
            } else {
                Err(errcode::INVALID_APPID.into())
            }
        }
        // protium-repo: exakt der repo-pfad oder ein nachfahre (präfix-tricks
        // wie "-evil" hinter dem namen schlagen am komponenten-check fehl)
        Some("github.com") => {
            let path = parsed.path();
            let repo = "/Tzyber/protium-steam-play-proton-manager";
            let ok = path == repo
                || path
                    .strip_prefix(repo)
                    .is_some_and(|rest| rest.starts_with('/'));
            if ok {
                Ok(())
            } else {
                Err(errcode::INVALID_URL.into())
            }
        }
        Some(host) => Err(errcode::with_detail(errcode::HOST_DISALLOWED, host)),
        None => Err(errcode::INVALID_URL.into()),
    }
}

/// vars, die ein kind NIE erben darf, auch ohne AppImage. LD_PRELOAD zeigt
/// im AppImage auf eine SYSTEM-lib (wayland-hook), fällt also durch den
/// appdir-filter unten durch und braucht den expliziten eintrag.
const ENV_ALWAYS_DROP: [&str; 2] = ["LD_PRELOAD", "LD_LIBRARY_PATH"];

/// env-änderungen für den kind-prozess: alles, was ins AppImage-mount zeigt,
/// fliegt raus. Some(v) = setzen, None = löschen.
///
/// WARUM: die AppRun-hooks setzen LD_LIBRARY_PATH, GTK_*, GDK_PIXBUF_*,
/// GIO_MODULE_DIR, GSETTINGS_SCHEMA_DIR, GI_TYPELIB_PATH und PATH auf das
/// mount-verzeichnis. ein browser oder steam, der das erbt, lädt die
/// gebündelten libs/module statt der systemeigenen und stirbt lautlos, der
/// klick tut dann scheinbar "nichts". gleiche fehlerklasse wie der
/// LD_PRELOAD-fix in lib.rs, nur für alle übrigen vars.
///
/// pfad-LISTEN werden eintragsweise gefiltert (PATH behält /usr/bin),
/// einzelwerte komplett entfernt. leere liste → var löschen.
pub(super) fn env_overrides(
    vars: &[(String, String)],
    appdir: &str,
) -> Vec<(String, Option<String>)> {
    let mut out: Vec<(String, Option<String>)> = ENV_ALWAYS_DROP
        .iter()
        .map(|k| ((*k).to_string(), None))
        .collect();

    for (key, value) in vars {
        if ENV_ALWAYS_DROP.contains(&key.as_str()) || !value.contains(appdir) {
            continue;
        }
        if value.contains(':') {
            let kept: Vec<&str> = value
                .split(':')
                .filter(|e| !e.is_empty() && !e.contains(appdir))
                .collect();
            out.push((
                key.clone(),
                if kept.is_empty() {
                    None
                } else {
                    Some(kept.join(":"))
                },
            ));
        } else {
            out.push((key.clone(), None));
        }
    }
    out
}

/// handler starten und loslassen: kein warten (xdg-open blockiert je nach
/// handler bis zum ende des browsers), aber ein reaper-thread, sonst bliebe
/// je klick ein zombie stehen. endet protium zuerst, läuft das kind als
/// waise weiter.
pub(super) fn spawn_detached(program: &str, args: &[&str], url: &str) -> std::io::Result<()> {
    spawn_detached_os(program, args, OsStr::new(url))
}

pub(super) fn spawn_detached_os(
    program: &str,
    args: &[&str],
    target: &OsStr,
) -> std::io::Result<()> {
    let mut child = detached_command(program, args, target).spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Ein Verzeichnis im System-Dateimanager oeffnen. Ein gemeinsamer Helfer fuer
/// alle "im Dateimanager zeigen"-Aktionen, damit Handler-Reihenfolge,
/// Prozess-Aufraeumen (Reaper) und Fehlercode ueberall gleich sind.
/// `spawn` ist injizierbar, damit Tests das Starten beobachten koennen.
pub(super) type SpawnOs<'a> = dyn FnMut(&str, &[&str], &OsStr) -> std::io::Result<()> + 'a;

pub(super) fn open_directory_with_handler(
    spawn: &mut SpawnOs<'_>,
    directory: &Path,
) -> Result<(), String> {
    for (program, args) in [("xdg-open", &[][..]), ("gio", &["open"][..])] {
        if spawn(program, args, directory.as_os_str()).is_ok() {
            return Ok(());
        }
    }
    Err(errcode::HANDLER_UNAVAILABLE.into())
}

fn detached_command(program: &str, args: &[&str], target: &OsStr) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    for key in ENV_ALWAYS_DROP {
        cmd.env_remove(key);
    }
    if let Some(appdir) = std::env::var_os("APPDIR").and_then(|v| v.into_string().ok()) {
        let vars: Vec<(String, String)> = std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .collect();
        for (key, value) in env_overrides(&vars, &appdir) {
            match value {
                Some(v) => cmd.env(key, v),
                None => cmd.env_remove(key),
            };
        }
    }

    cmd
}

/// Öffnet eine URL im System-Browser oder Steam-Handler.
///
/// eigener command statt tauri-plugin-opener, weil dessen spawn die env des
/// app-prozesses ungefiltert vererbt, im AppImage genau der grund, warum
/// play-button und protondb-link dort nichts taten (siehe env_overrides).
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    validate_external_url(&url)?;

    let mut last_err = String::new();
    for (program, args) in [("xdg-open", &[][..]), ("gio", &["open"][..])] {
        match spawn_detached(program, args, &url) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = format!("{program}: {e}"),
        }
    }
    Err(errcode::with_detail(errcode::HANDLER_UNAVAILABLE, last_err))
}

#[cfg(test)]
#[path = "external_tests.rs"]
mod tests;
