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
            Err("invalid steam app id".into())
        };
    }
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid external URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("only HTTPS URLs allowed".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL must not contain credentials".into());
    }
    match parsed.host_str().map(|h| h.to_ascii_lowercase()).as_deref() {
        // protondb: nur spielseiten /app/<appId> (das frontend baut genau diese)
        Some("www.protondb.com") => {
            let rest = parsed
                .path()
                .strip_prefix("/app/")
                .ok_or_else(|| "invalid protondb path".to_string())?;
            if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) {
                Ok(())
            } else {
                Err("invalid protondb app id".into())
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
                Err("github URL outside protium repo".into())
            }
        }
        Some(host) => Err(format!("external URL host not allowed: {host}")),
        None => Err("external URL has no host".into()),
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
    let mut cmd = Command::new(program);
    cmd.args(args)
        .arg(url)
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

    let mut child = cmd.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
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
    Err(format!("no URL handler available ({last_err})"))
}

#[cfg(test)]
mod tests {
    use super::{env_overrides, validate_external_url};

    // ---- Externe URLs ----

    #[test]
    fn external_url_accepts_protondb_and_steam() {
        assert!(validate_external_url("https://www.protondb.com/app/620").is_ok());
        assert!(validate_external_url(
            "https://github.com/Tzyber/protium-steam-play-proton-manager"
        )
        .is_ok());
        assert!(validate_external_url("steam://rungameid/570").is_ok());
    }

    #[test]
    fn external_url_rejects_fremde_ziele() {
        assert!(validate_external_url("http://www.protondb.com/app/620").is_err());
        assert!(validate_external_url("https://evil.example/app/620").is_err());
        assert!(validate_external_url("https://user:pw@www.protondb.com/").is_err());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        // andere steam-handler (install/uninstall) sind kein play-button
        assert!(validate_external_url("steam://install/570").is_err());
        assert!(validate_external_url("steam://rungameid/570;rm -rf").is_err());
        assert!(validate_external_url("steam://rungameid/").is_err());
        // führendes "-" käme als option beim handler an
        assert!(validate_external_url("--version").is_err());
    }

    #[test]
    fn external_url_pfad_pinning_protondb() {
        // host-only wäre ein open-redirect-fenster: nur spielseiten sind
        // erlaubt, keine unterseiten (phishing-lookalikes auf echtem host)
        assert!(validate_external_url("https://www.protondb.com/app/620").is_ok());
        assert!(validate_external_url("https://www.protondb.com/app/0").is_ok());
        assert!(validate_external_url("https://www.protondb.com/app/").is_err());
        assert!(validate_external_url("https://www.protondb.com/").is_err());
        assert!(validate_external_url("https://www.protondb.com/app/620/whatever").is_err());
        assert!(validate_external_url("https://www.protondb.com/app/abc").is_err());
        assert!(validate_external_url("https://www.protondb.com/login").is_err());
    }

    #[test]
    fn external_url_pfad_pinning_github() {
        // repo-pfad oder nachfahre; präfix-trick (-evil) und fremde repos
        // schlagen am komponenten-check fehl
        let repo = "https://github.com/Tzyber/protium-steam-play-proton-manager";
        assert!(validate_external_url(repo).is_ok());
        assert!(validate_external_url(&format!("{repo}/releases")).is_ok());
        assert!(validate_external_url(&format!("{repo}/issues")).is_ok());
        assert!(validate_external_url(
            "https://github.com/Tzyber/protium-steam-play-proton-manager-evil"
        )
        .is_err());
        assert!(validate_external_url("https://github.com/Tzyber/Protium").is_err());
        assert!(validate_external_url("https://github.com/other/repo").is_err());
        assert!(validate_external_url("https://github.com/").is_err());
    }

    #[test]
    fn env_overrides_filtert_nur_appdir_eintraege() {
        let appdir = "/tmp/.mount_protiumXY";
        let vars = vec![
            (
                "PATH".to_string(),
                format!("{appdir}/usr/bin:/usr/bin:/bin"),
            ),
            (
                "XDG_DATA_DIRS".to_string(),
                format!("{appdir}/usr/share:/usr/share"),
            ),
            (
                "GSETTINGS_SCHEMA_DIR".to_string(),
                format!("{appdir}/usr/share/glib-2.0/schemas"),
            ),
            ("HOME".to_string(), "/home/dominik".to_string()),
        ];
        let out = env_overrides(&vars, appdir);
        let get = |k: &str| out.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());

        // pfad-listen behalten die system-einträge
        assert_eq!(get("PATH"), Some(Some("/usr/bin:/bin".to_string())));
        assert_eq!(get("XDG_DATA_DIRS"), Some(Some("/usr/share".to_string())));
        // einzelwert ins mount → weg
        assert_eq!(get("GSETTINGS_SCHEMA_DIR"), Some(None));
        // unbeteiligte vars bleiben unangetastet
        assert!(get("HOME").is_none());
    }

    #[test]
    fn env_overrides_droppt_loader_vars_immer() {
        // LD_PRELOAD des wayland-hooks zeigt auf eine SYSTEM-lib und würde
        // vom appdir-filter nicht erfasst
        let vars = vec![(
            "LD_PRELOAD".to_string(),
            "/usr/lib/libwayland-client.so".to_string(),
        )];
        let out = env_overrides(&vars, "/tmp/.mount_protiumXY");
        assert_eq!(
            out.iter()
                .filter(|(k, v)| k == "LD_PRELOAD" && v.is_none())
                .count(),
            1
        );
        assert!(out
            .iter()
            .any(|(k, v)| k == "LD_LIBRARY_PATH" && v.is_none()));
    }
}
