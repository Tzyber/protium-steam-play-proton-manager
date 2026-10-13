use super::*;

// ---- Externe URLs ----

#[test]
fn external_url_accepts_protondb_and_steam() {
    assert!(validate_external_url("https://www.protondb.com/app/620").is_ok());
    assert!(
        validate_external_url("https://github.com/Tzyber/protium-steam-play-proton-manager")
            .is_ok()
    );
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

#[cfg(target_os = "linux")]
mod detached_command_tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;

    #[test]
    fn preserves_non_utf8_argument_and_removes_loader_environment() {
        let target = std::ffi::OsStr::from_bytes(b"/library/\xff/pfx");
        let command = detached_command("gio", &["open"], target);
        let arguments: Vec<_> = command.get_args().collect();
        assert_eq!(arguments, vec![std::ffi::OsStr::new("open"), target]);
        for name in ENV_ALWAYS_DROP {
            assert!(command
                .get_envs()
                .any(|(key, value)| key == name && value.is_none()));
        }
    }
}

#[test]
fn probiert_xdg_open_und_bleibt_dabei() {
    let mut calls: Vec<String> = Vec::new();
    let mut ok = |program: &str, _args: &[&str], _target: &OsStr| {
        calls.push(program.to_owned());
        Ok(())
    };

    assert!(open_directory_with_handler(&mut ok, Path::new("/tmp")).is_ok());
    assert_eq!(calls, vec!["xdg-open".to_owned()]);
}

#[test]
fn faellt_auf_gio_zurueck_und_meldet_handler_unavailable() {
    let mut calls: Vec<String> = Vec::new();
    let mut nur_gio = |program: &str, _args: &[&str], _target: &OsStr| {
        calls.push(program.to_owned());
        if program == "gio" {
            Ok(())
        } else {
            Err(std::io::Error::other("kein handler"))
        }
    };
    assert!(open_directory_with_handler(&mut nur_gio, Path::new("/tmp")).is_ok());
    assert_eq!(calls, vec!["xdg-open".to_owned(), "gio".to_owned()]);

    let mut keiner = |_program: &str, _args: &[&str], _target: &OsStr| {
        Err(std::io::Error::other("kein handler"))
    };
    assert_eq!(
        open_directory_with_handler(&mut keiner, Path::new("/tmp")),
        Err("handler-unavailable".to_owned())
    );
}
