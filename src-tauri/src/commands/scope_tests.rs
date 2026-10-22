use super::*;
use crate::commands::test_util::{production_source, wsg_fixture};
use std::path::PathBuf;

/// Kodierungsrunde: die symlinK-ablehnung der pfad-komponenten ist kodiert,
/// kein rohtext mehr.
#[cfg(unix)]
#[test]
fn symlink_komponente_ist_codiert() {
    let root = wsg_fixture("symlink-component-coded");
    let real = root.join("real");
    std::fs::create_dir(&real).unwrap();
    let link = root.join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    let error = reject_symlink_components(&link.join("x"), true, "test").unwrap_err();

    assert!(
        errcode::has_code(&error, errcode::SYMLINK_REJECTED),
        "{error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn parse_compat_id_begrenzt_appid_exakt_auf_uint32() {
    // appIDs sind unsigned 32-bit. non-steam-shortcuts setzen bit 31
    // (2^31 + n), die müssen compatdata/shadercache-löschpfade und die
    // config-zuordnung erreichen können.
    assert_eq!(
        parse_compat_id(("compatdata", "2207218128")),
        Ok(("compatdata", "2207218128"))
    );
    assert_eq!(
        parse_compat_id(("shadercache", "4294967295")),
        Ok(("shadercache", "4294967295"))
    );
    assert!(parse_compat_id(("compatdata", "0")).is_err());
    assert!(parse_compat_id(("compatdata", "4294967296")).is_err());
}

fn snapshot(root: &std::path::Path, library: &std::path::Path) -> EnvironmentSnapshot {
    EnvironmentSnapshot::for_test(
        root.join("steam"),
        vec![library.to_path_buf()],
        Vec::new(),
        root.join("cache"),
        root.join("config"),
    )
}

#[test]
fn snapshot_rejects_unregistered_user_path() {
    let root = std::env::temp_dir().join(format!("protium-env-root-{}", std::process::id()));
    let library = root.join("library");
    let documents = root.join("Documents/steamapps");
    std::fs::create_dir_all(&library).unwrap();
    std::fs::create_dir_all(&documents).unwrap();
    let state = EnvironmentState::for_test(snapshot(&root, &library));

    assert!(state.authorize_for_test(&documents.join("x")).is_err());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn discovery_replaces_old_snapshot_authority_atomically() {
    let root = std::env::temp_dir().join(format!("protium-env-swap-{}", std::process::id()));
    let library_a = root.join("a");
    let library_b = root.join("b");
    std::fs::create_dir_all(&library_a).unwrap();
    std::fs::create_dir_all(&library_b).unwrap();
    let state = EnvironmentState::for_test(snapshot(&root, &library_a));

    state.replace_for_test(snapshot(&root, &library_b));

    assert!(state.authorize_for_test(&library_a).is_err());
    assert!(state.authorize_for_test(&library_b).is_ok());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn authorized_missing_path_keeps_root_authority_for_exists() {
    let root = std::env::temp_dir().join(format!("protium-env-missing-{}", std::process::id()));
    let library = root.join("library");
    std::fs::create_dir_all(&library).unwrap();
    let state = EnvironmentState::for_test(snapshot(&root, &library));
    let missing = library.join("steamapps/library_header.jpg");

    let authorized = state.authorize_for_test(&missing).unwrap();
    assert_eq!(authorized, library);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn authorized_batch_preserves_existing_and_missing_paths() {
    let root =
        std::env::temp_dir().join(format!("protium-env-batch-missing-{}", std::process::id()));
    let library = root.join("library");
    let existing = library.join("steamapps/compatdata/12345");
    let missing = library.join("steamapps/compatdata/99999");
    std::fs::create_dir_all(&existing).unwrap();
    let state = EnvironmentState::for_test(snapshot(&root, &library));
    let paths = vec![
        existing.to_string_lossy().into_owned(),
        missing.to_string_lossy().into_owned(),
    ];

    state
        .with_authorized_batch(&paths, |authorized| {
            assert_eq!(authorized.len(), 2);
            assert_eq!(authorized[0].requested, paths[0]);
            assert!(matches!(authorized[0].real, Ok(Some(_))));
            assert_eq!(authorized[1].requested, paths[1]);
            assert!(matches!(authorized[1].real, Ok(None)));
            Ok(())
        })
        .unwrap();

    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn authorized_batch_isolates_symlink_path_from_the_rest() {
    let root =
        std::env::temp_dir().join(format!("protium-env-batch-symlink-{}", std::process::id()));
    let library = root.join("library");
    let existing = library.join("steamapps/compatdata/12345");
    let elsewhere = root.join("other-disk/Game");
    let linked = library.join("steamapps/common/Game");
    std::fs::create_dir_all(&existing).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::create_dir_all(linked.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &linked).unwrap();
    let state = EnvironmentState::for_test(snapshot(&root, &library));
    let paths = vec![
        linked.to_string_lossy().into_owned(),
        existing.to_string_lossy().into_owned(),
    ];

    state
        .with_authorized_batch(&paths, |authorized| {
            assert!(authorized[0].real.is_err());
            assert!(matches!(authorized[1].real, Ok(Some(_))));
            Ok(())
        })
        .unwrap();

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn authorized_optional_keeps_authorization_and_existence_observation_consistent() {
    let root = std::env::temp_dir().join(format!(
        "protium-env-optional-status-{}",
        std::process::id()
    ));
    let library = root.join("library");
    let existing = library.join("steamapps/compatdata/12345");
    let missing = library.join("steamapps/compatdata/99999");
    std::fs::create_dir_all(&existing).unwrap();
    let state = EnvironmentState::for_test(snapshot(&root, &library));

    state
        .with_authorized_optional(&existing.to_string_lossy(), "test", |real| {
            assert_eq!(real, Some(std::fs::canonicalize(&existing).unwrap()));
            Ok(())
        })
        .unwrap();
    state
        .with_authorized_optional(&missing.to_string_lossy(), "test", |real| {
            assert!(real.is_none());
            Ok(())
        })
        .unwrap();

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn discovery_reads_libraries_only_from_validated_vdf() {
    let home = std::env::temp_dir().join(format!("protium-discovery-{}", std::process::id()));
    let root = home.join(".local/share/Steam");
    let external = home.join("mnt/SteamLibrary");
    let stale = home.join("gone/SteamLibrary");
    let cache = home.join("app-cache");
    let config = home.join("app-config");
    std::fs::create_dir_all(root.join("steamapps")).unwrap();
    std::fs::create_dir_all(external.join("steamapps")).unwrap();
    let vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} \"2\" {{ \"path\" \"{}\" }} }}",
        root.display(),
        external.display(),
        stale.display()
    );
    std::fs::write(root.join("steamapps/libraryfolders.vdf"), vdf).unwrap();

    let snapshot = build_environment_snapshot(&home, &cache, &config).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    let external = std::fs::canonicalize(external).unwrap();
    assert_eq!(snapshot.steam_root, root);
    assert!(snapshot.libraries.contains(&root));
    assert!(snapshot.libraries.contains(&external));
    assert!(!snapshot.libraries.contains(&stale));

    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn discovery_rejects_root_symlink_outside_home() {
    let home = std::env::temp_dir().join(format!("protium-discovery-link-{}", std::process::id()));
    let outside =
        std::env::temp_dir().join(format!("protium-discovery-outside-{}", std::process::id()));
    std::fs::create_dir_all(outside.join("steamapps")).unwrap();
    std::fs::create_dir_all(home.join(".steam")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, home.join(".steam/steam")).unwrap();

    let result =
        build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"));
    assert!(result.unwrap_err().contains("steam-not-found"));

    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(outside);
}

#[test]
fn discovery_rejects_documents_fake_steam() {
    let home = std::env::temp_dir().join(format!(
        "protium-discovery-documents-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(home.join("Documents/fake-steam/steamapps")).unwrap();
    let result =
        build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"));
    assert!(result.unwrap_err().contains("steam-not-found"));
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn discovery_rejects_home_without_fixed_candidate() {
    let home =
        std::env::temp_dir().join(format!("protium-discovery-no-steam-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let result =
        build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"));
    assert!(result.unwrap_err().contains("steam-not-found"));
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn discovery_prioritizes_native_fixed_candidate() {
    let home =
        std::env::temp_dir().join(format!("protium-discovery-priority-{}", std::process::id()));
    let native = home.join(".local/share/Steam");
    let flatpak = home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam");
    std::fs::create_dir_all(native.join("steamapps")).unwrap();
    std::fs::create_dir_all(flatpak.join("steamapps")).unwrap();

    let snapshot =
        build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"))
            .unwrap();
    assert_eq!(snapshot.steam_root, std::fs::canonicalize(native).unwrap());
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn discovery_accepts_flatpak_and_snap_fixed_candidates() {
    for (index, relative) in [
        ".var/app/com.valvesoftware.Steam/.local/share/Steam",
        "snap/steam/common/.local/share/Steam",
    ]
    .into_iter()
    .enumerate()
    {
        let home = std::env::temp_dir().join(format!(
            "protium-discovery-fixed-{index}-{}",
            std::process::id()
        ));
        let root = home.join(relative);
        std::fs::create_dir_all(root.join("steamapps")).unwrap();
        let snapshot =
            build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"))
                .unwrap();
        assert_eq!(snapshot.steam_root, std::fs::canonicalize(root).unwrap());
        let _ = std::fs::remove_dir_all(home);
    }
}

#[cfg(unix)]
#[test]
fn discovery_accepts_alias_to_another_fixed_candidate() {
    let home = std::env::temp_dir().join(format!("protium-discovery-alias-{}", std::process::id()));
    let target = home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam");
    let alias = home.join(".steam/steam");
    std::fs::create_dir_all(target.join("steamapps")).unwrap();
    std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&target, &alias).unwrap();

    let snapshot =
        build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"))
            .unwrap();
    assert_eq!(snapshot.steam_root, std::fs::canonicalize(target).unwrap());
    let _ = std::fs::remove_dir_all(home);
}

#[cfg(unix)]
#[test]
fn discovery_rejects_alias_to_documents_fake_steam() {
    let home = std::env::temp_dir().join(format!(
        "protium-discovery-alias-documents-{}",
        std::process::id()
    ));
    let target = home.join("Documents/fake-steam");
    let alias = home.join(".steam/steam");
    std::fs::create_dir_all(target.join("steamapps")).unwrap();
    std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&target, &alias).unwrap();

    let result =
        build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"));
    assert!(result.unwrap_err().contains("steam-not-found"));
    let _ = std::fs::remove_dir_all(home);
}

#[cfg(unix)]
#[test]
fn discovery_skips_foreign_alias_and_uses_later_fixed_candidate() {
    let home = std::env::temp_dir().join(format!(
        "protium-discovery-alias-skip-{}",
        std::process::id()
    ));
    let foreign = home.join("Documents/fake-steam");
    let flatpak = home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam");
    let alias = home.join(".steam/steam");
    std::fs::create_dir_all(foreign.join("steamapps")).unwrap();
    std::fs::create_dir_all(flatpak.join("steamapps")).unwrap();
    std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&foreign, &alias).unwrap();

    let snapshot =
        build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"))
            .unwrap();
    assert_eq!(snapshot.steam_root, std::fs::canonicalize(flatpak).unwrap());
    let _ = std::fs::remove_dir_all(home);
}

#[cfg(unix)]
#[test]
fn discovery_accepts_debian_installation_behind_steam_alias() {
    let home =
        std::env::temp_dir().join(format!("protium-discovery-debian-{}", std::process::id()));
    let target = home.join(".steam/debian-installation");
    std::fs::create_dir_all(target.join("steamapps")).unwrap();
    std::os::unix::fs::symlink(&target, home.join(".steam/steam")).unwrap();
    std::os::unix::fs::symlink(&target, home.join(".steam/root")).unwrap();

    let snapshot =
        build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"))
            .unwrap();
    assert_eq!(snapshot.steam_root, std::fs::canonicalize(target).unwrap());
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn discovery_uses_fixed_system_compat_roots_only() {
    let fixed: Vec<PathBuf> = super::SYSTEM_COMPAT_DIRS
        .iter()
        .map(PathBuf::from)
        .collect();
    assert_eq!(fixed.len(), 2);
    assert!(!fixed.iter().any(|path| path.ends_with("custom")));
}

#[test]
fn fixed_system_compat_root_rejects_symlink_target() {
    let root =
        std::env::temp_dir().join(format!("protium-system-compat-link-{}", std::process::id()));
    let target = root.join("target");
    let raw = root.join("fixed");
    std::fs::create_dir_all(&target).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &raw).unwrap();

    assert!(build_fixed_system_compat_root(&raw).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn snapshot_replacement_waits_for_running_authorized_read() {
    use std::sync::{Arc, Barrier};
    use std::thread;

    let root = std::env::temp_dir().join(format!("protium-env-concurrent-{}", std::process::id()));
    let library_a = root.join("a");
    let library_b = root.join("b");
    std::fs::create_dir_all(&library_a).unwrap();
    std::fs::create_dir_all(&library_b).unwrap();
    let state = EnvironmentState::for_test(snapshot(&root, &library_a));
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let reader_state = state.clone();
    let reader_entered = entered.clone();
    let reader_release = release.clone();
    let reader_library = library_a.clone();
    let reader = thread::spawn(move || {
        reader_state
            .with_authorized_existing_for_test(
                &reader_library.to_string_lossy(),
                "concurrent read",
                |_path| {
                    reader_entered.wait();
                    reader_release.wait();
                    Ok(())
                },
            )
            .unwrap();
    });

    entered.wait();
    assert!(state.current_for_test().is_none());

    let replacement_state = state.clone();
    let replacement_root = root.clone();
    let replacement_library_b = library_b.clone();
    let replacement = thread::spawn(move || {
        replacement_state.replace_for_test(snapshot(&replacement_root, &replacement_library_b));
    });
    assert!(state.current_for_test().is_none());
    release.wait();
    reader.join().unwrap();
    replacement.join().unwrap();

    assert!(state.authorize_for_test(&library_a).is_err());
    assert!(state.authorize_for_test(&library_b).is_ok());
    let _ = std::fs::remove_dir_all(root);
}

/// F1: die JSON-werte des drahtvertrags sind mit `SkipReason` in
/// `src/core/types.ts` abgestimmt; die serde-attribute sind deklarativ,
/// deshalb hier die feste zuordnung.
#[test]
fn library_unavailable_reason_traegt_die_drahtwerte() {
    assert_eq!(
        LibraryUnavailableReason::PathMissing.as_str(),
        "path-missing"
    );
    assert_eq!(
        LibraryUnavailableReason::ScopeFailed.as_str(),
        "scope-failed"
    );
    assert_eq!(LibraryUnavailableReason::ReadFailed.as_str(), "read-failed");
}

/// F1: eine gelistete library außerhalb der erlaubten pfade darf nie in den
/// scope (`libraries`) gelangen, die liste ist das gate für lese- und
/// löschpfade, `is_safe_path` lehnt `/etc`, `/proc`, `/sys` und `/dev` ab.
#[test]
fn read_library_folders_lehnt_blockierte_library_pfade_ab() {
    let root = wsg_fixture("lf-blocked-path");
    let steam = root.join("steam");
    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();

    let raw = "/proc/self";
    let canonical = std::fs::canonicalize(raw).unwrap();
    assert!(
        !crate::commands::path::is_safe_path(&canonical.to_string_lossy()),
        "fixture-voraussetzung: {raw} muss von der blocklist abgelehnt werden"
    );
    std::fs::write(
        steam.join("config/libraryfolders.vdf"),
        format!("\"libraryfolders\" {{ \"0\" {{ \"path\" \"{raw}\" }} }}"),
    )
    .unwrap();

    let (libraries, unavailable) = read_library_folders_with_failures(&steam).unwrap();
    let steam_canonical = std::fs::canonicalize(&steam).unwrap();
    assert_eq!(libraries, vec![steam_canonical.clone()]);
    assert_eq!(unavailable.len(), 1, "unavailable: {unavailable:?}");
    let entry = &unavailable[0];
    assert_eq!(entry.path, raw);
    assert_eq!(entry.reason, LibraryUnavailableReason::ScopeFailed);
    assert!(
        !libraries
            .iter()
            .any(|library| library.starts_with(&canonical)),
        "blockierter pfad darf nie im scope landen"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn environment_exists_uebernimmt_existenz_aus_der_autorisierungs_stat() {
    // r-16: existenz und autorisierung stammen aus derselben stat, der
    // roheingabepfad wird nicht ein zweites mal aufgelöst. das wegfallende
    // zweite stat-fenster ist ohne injektionshaken funktional nicht
    // beobachtbar (prüflücke), der quelltext-beleg darunter deckt es ab.
    let root = wsg_fixture("env-exists-auth");
    let library = root.join("library");
    let existing = library.join("steamapps/compatdata/12345");
    let missing = library.join("steamapps/compatdata/99999");
    std::fs::create_dir_all(&existing).unwrap();
    let state = EnvironmentState::for_test(snapshot(&root, &library));

    assert_eq!(
        state.environment_exists(existing.to_str().unwrap()),
        Ok(true)
    );
    assert_eq!(
        state.environment_exists(missing.to_str().unwrap()),
        Ok(false)
    );
    assert!(state
        .environment_exists(root.join("Documents").to_str().unwrap())
        .is_err());

    let link = library.join("steamapps/link");
    std::os::unix::fs::symlink(&existing, &link).unwrap();
    let error = state
        .environment_exists(link.to_str().unwrap())
        .unwrap_err();
    assert!(error.contains("symlink"), "unexpected error: {error}");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn environment_exists_statet_den_roheingabepfad_nicht_erneut() {
    // r-16: statischer beleg: environment_exists wertet nur die
    // autorisierungs-stat aus und löst den roheingabepfad nicht ein zweites
    // mal auf
    let production = production_source(include_str!("scope.rs"));
    let body_start = production
        .find("fn environment_exists")
        .expect("environment_exists muss vorhanden sein");
    let body_end = body_start
        + production[body_start..]
            .find("\n    }")
            .expect("environment_exists braucht einen funktionskörper");
    let body = &production[body_start..body_end];
    assert!(
        body.contains("authorized.exists"),
        "existenz muss aus der autorisierungs-stat kommen"
    );
    assert!(
        !body.contains("symlink_metadata"),
        "der roheingabepfad darf nicht erneut gestatet werden"
    );
}

/// r-06: die libraryfolders-Lesekette (Suchreihenfolge `config`/`steamapps`)
/// existiert nur noch einmal. Belegt quelltext-statisch, dass `compat_auth`
/// seine eigene Kette abgegeben hat und die geteilte Primitive in
/// `libraryfolders` nutzt; eine zweite Kopie in `scope` fiele ebenfalls auf. Gelesen werden die Produktionsquellen (Testmodule sind ausgelagert).
#[test]
fn libraryfolders_lesekette_existiert_nur_einmal() {
    let scope = [
        production_source(include_str!("scope.rs")),
        production_source(include_str!("libraryfolders.rs")),
    ]
    .concat();
    let compat = production_source(include_str!("compat_auth.rs"));
    let order = "[\"config\", \"steamapps\"]";
    assert_eq!(
        scope.matches(order).count(),
        1,
        "die suchreihenfolge muss genau einmal in libraryfolders.rs stehen"
    );
    assert_eq!(
        compat.matches(order).count(),
        0,
        "compat_auth darf die suchreihenfolge nicht mehr selbst aufbauen"
    );
    assert!(
        compat.contains("libraryfolders_contents_from_root_fd"),
        "compat_auth muss die geteilte Primitive nutzen"
    );
}

/// F-04: ein fehlgeschlagenes anlegen meldet `unavailable` (die app-wurzel
/// steht nicht bereit), nicht `unreadable`/`not-found` aus der leseregel.
#[test]
fn prepare_app_dir_meldet_erzeugungsfehler_als_unavailable() {
    let root = wsg_fixture("prepare-app-dir-create-failure");
    let blocker = root.join("blocker");
    std::fs::write(&blocker, b"x").unwrap();

    let error = prepare_app_dir(&blocker.join("sub"), &root, "app cache").unwrap_err();

    assert!(errcode::has_code(&error, errcode::UNAVAILABLE), "{error}");
    let _ = std::fs::remove_dir_all(root);
}

/// Audit 2026-10-20, 6.1: App-Verzeichnisse sind privat, auch wenn eine
/// aeltere Version sie mit weiterem Modus angelegt hat.
#[cfg(unix)]
#[test]
fn prepare_app_dir_legt_privat_an_und_zieht_bestand_nach() {
    use std::os::unix::fs::PermissionsExt;
    let root = wsg_fixture("prepare-app-dir-private");
    let dir = root.join("logs");
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;

    let canonical = prepare_app_dir(&dir, &root, "app logs").unwrap();
    assert_eq!(mode(&canonical), 0o700);

    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(mode(&canonical), 0o755);

    prepare_app_dir(&dir, &root, "app logs").unwrap();
    assert_eq!(mode(&canonical), 0o700);

    // nur verengen: 0500 hat keine Gruppen-/Andere-Rechte und bleibt
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    prepare_app_dir(&dir, &root, "app logs").unwrap();
    assert_eq!(mode(&canonical), 0o500);

    // rekursiv angelegte eltern: jede ebene entsteht privat, nicht nur das blatt
    let deep = root.join("nested/deep");
    let canonical_deep = prepare_app_dir(&deep, &root, "app logs").unwrap();
    assert_eq!(mode(&canonical_deep), 0o700);
    assert_eq!(mode(&root.join("nested")), 0o700);

    let _ = std::fs::remove_dir_all(root);
}

/// R2: das Verengen darf kein Verzeichnis außerhalb des App-Roots treffen.
/// Der Pfad wird abgelehnt, bevor irgendetwas angelegt wird.
#[test]
fn prepare_app_dir_lehnt_pfad_ausserhalb_des_app_roots_ab() {
    let base = wsg_fixture("prepare-app-dir-outside-root");
    let app_root = base.join("root");
    let outside = base.join("outside");
    std::fs::create_dir_all(&app_root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let target = outside.join("nested");

    let error = prepare_app_dir(&target, &app_root, "app cache").unwrap_err();

    assert!(
        errcode::has_code(&error, errcode::BLOCKED_LOCATION),
        "{error}"
    );
    assert!(
        !target.exists(),
        "pfad außerhalb des app-roots darf nicht angelegt werden"
    );
    let _ = std::fs::remove_dir_all(base);
}

/// B1: ein fehlender App-Root wird angelegt statt verlangt. Der Root entsteht im
/// Default-Modus (ein fremdes Elternverzeichnis wie `~/.cache` darf nicht auf
/// 0700 gezogen werden), das Kind bleibt privat.
#[cfg(unix)]
#[test]
fn prepare_app_dir_legt_fehlenden_root_an() {
    use std::os::unix::fs::PermissionsExt;
    let base = wsg_fixture("prepare-app-dir-missing-root");
    let root = base.join("root");
    let dir = root.join("logs");
    assert!(!root.exists(), "fixture muss ohne app-root starten");
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;

    let canonical = prepare_app_dir(&dir, &root, "app logs").unwrap();

    assert_eq!(canonical, std::fs::canonicalize(&dir).unwrap());
    assert!(root.exists(), "fehlender app-root muss angelegt werden");
    assert_eq!(mode(&dir), 0o700);
    let _ = std::fs::remove_dir_all(base);
}

/// B2: der Root selbst ist kein App-Verzeichnis; Gleichheit wird abgelehnt,
/// bevor etwas angelegt oder verengt wird.
#[test]
fn prepare_app_dir_lehnt_root_selbst_ab() {
    let base = wsg_fixture("prepare-app-dir-root-itself");
    let root = base.join("root");
    std::fs::create_dir_all(&root).unwrap();

    let error = prepare_app_dir(&root, &root, "app cache").unwrap_err();

    assert!(
        errcode::has_code(&error, errcode::BLOCKED_LOCATION),
        "{error}"
    );
    let _ = std::fs::remove_dir_all(base);
}

/// B3: die Symlink-Ablehnung läuft auf dem Rohpfad VOR dem Kanonisieren, damit
/// eine Symlink-Komponente `symlink-rejected` meldet und nicht als
/// `blocked-location` des Descendant-Checks endet.
#[cfg(unix)]
#[test]
fn prepare_app_dir_lehnt_blatt_symlink_als_symlink_rejected_ab() {
    let base = wsg_fixture("prepare-app-dir-leaf-symlink");
    let root = base.join("root");
    let outside = base.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let link = root.join("logs");
    std::os::unix::fs::symlink(&outside, &link).unwrap();

    let error = prepare_app_dir(&link, &root, "app logs").unwrap_err();

    assert!(
        errcode::has_code(&error, errcode::SYMLINK_REJECTED),
        "{error}"
    );
    let _ = std::fs::remove_dir_all(base);
}

/// B3: auch ein Symlink im Elternpfad bleibt `symlink-rejected`.
#[cfg(unix)]
#[test]
fn prepare_app_dir_lehnt_eltern_symlink_als_symlink_rejected_ab() {
    let base = wsg_fixture("prepare-app-dir-parent-symlink");
    let root = base.join("root");
    let outside = base.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let link = root.join("link");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let target = link.join("logs");

    let error = prepare_app_dir(&target, &root, "app logs").unwrap_err();

    assert!(
        errcode::has_code(&error, errcode::SYMLINK_REJECTED),
        "{error}"
    );
    let _ = std::fs::remove_dir_all(base);
}

/// B3: auch ein toter Blatt-Symlink bleibt `symlink-rejected`. `path.exists()`
/// folgt dem Symlink und ist hier `false`; ohne `include_leaf = true` bliebe das
/// Blatt ungeprueft und der Pfad endete erst beim Anlegen als `unavailable`.
#[cfg(unix)]
#[test]
fn prepare_app_dir_lehnt_toten_blatt_symlink_ab() {
    let root = wsg_fixture("prepare-app-dir-dead-leaf-symlink");
    let link = root.join("logs");
    std::os::unix::fs::symlink(root.join("fehlt"), &link).unwrap();
    assert!(!link.exists(), "fixture muss ein toter symlink sein");
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink(),
        "fixture muss ein symlink sein, kein fehlender pfad"
    );

    let error = prepare_app_dir(&link, &root, "app logs").unwrap_err();

    assert!(
        errcode::has_code(&error, errcode::SYMLINK_REJECTED),
        "{error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// B4: der pfadbasierte Fallback überspringt ein Blatt-Symlink und verengt das
/// Ziel dahinter nicht.
#[cfg(target_os = "linux")]
#[test]
fn restrict_dir_to_owner_verengt_kein_blatt_symlink_ziel() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let base = wsg_fixture("restrict-dir-leaf-symlink");
    let target = base.join("ziel");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
    let link = base.join("verweis");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;

    restrict_dir_to_owner(&link);

    assert_eq!(
        mode(&target),
        0o755,
        "das Ziel hinter einem Blatt-Symlink darf nicht verengt werden"
    );
    let _ = std::fs::remove_dir_all(base);
}

/// B4: ohne Leserecht (EACCES beim Deskriptor-Open) greift der pfadbasierte
/// Fallback und verengt trotzdem.
#[cfg(target_os = "linux")]
#[test]
fn restrict_dir_to_owner_verengt_trotz_fehlendem_leserecht() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    for (start, expected) in [(0o111, 0o100), (0o355, 0o300)] {
        let base = wsg_fixture(&format!("restrict-dir-mode-{start:o}"));
        let dir = base.join("dir");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(start)).unwrap();
        assert_eq!(mode(&dir), start);

        restrict_dir_to_owner(&dir);

        assert_eq!(
            mode(&dir),
            expected,
            "{start:o} muss auf {expected:o} verengt werden"
        );
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _ = std::fs::remove_dir_all(base);
    }
}

/// R9/R5: Bestand aus einer aelteren Version wird auch ohne Anlegen verengt.
#[cfg(unix)]
#[test]
fn ensure_private_dir_verengt_bestand_auf_0700() {
    use std::os::unix::fs::PermissionsExt;
    let root = wsg_fixture("ensure-private-dir-existing");
    let dir = root.join("backups");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir), 0o755);

    ensure_private_dir(&dir).unwrap();

    assert_eq!(mode(&dir), 0o700);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn content_read_folgt_den_lesern_aus_paths_ts() {
    let steam = PathBuf::from("/s");
    let snapshot = EnvironmentSnapshot::for_test(
        steam.clone(),
        vec![steam.clone(), PathBuf::from("/lib")],
        vec![PathBuf::from("/usr/share/steam/compatibilitytools.d")],
        PathBuf::from("/cache"),
        PathBuf::from("/app-config"),
    );
    let read = |raw: &str| snapshot.content_read(Path::new(raw));

    assert_eq!(
        read("/s/config/config.vdf"),
        Some(ContentRead::CompatToolMappingOnly)
    );
    for allowed in [
        "/s/config/loginusers.vdf",
        "/s/userdata/12/config/localconfig.vdf",
        "/s/userdata/12/config/shortcuts.vdf",
        "/s/compatibilitytools.d/GE-Proton9-1/compatibilitytool.vdf",
        "/s/appcache/librarycache/620/abc/library_header.jpg",
        "/s/steamapps/appmanifest_620.acf",
        "/lib/steamapps/appmanifest_620.acf",
        "/usr/share/steam/compatibilitytools.d/proton-cachyos/compatibilitytool.vdf",
    ] {
        assert_eq!(read(allowed), Some(ContentRead::Full), "{allowed}");
    }
    for denied in [
        "/s/config/local.vdf",
        "/s/config/htmlcache/Cookies",
        "/s/ssfn123",
        "/s/logs/connection_log.txt",
        "/s/userdata/abc/config/localconfig.vdf",
        "/s/userdata/12/7/remote/save.dat",
        "/s/compatibilitytools.d/a/b/compatibilitytool.vdf",
        "/s/appcache/librarycache/620/library_header.jpg",
        "/lib/steamapps/appmanifest_.acf",
        "/lib/steamapps/appmanifest_6x.acf",
        "/lib/steamapps/common/g/appmanifest_1.acf",
        "/lib/config/config.vdf",
        "/cache/protondb/x.json",
        "/elsewhere/config/config.vdf",
    ] {
        assert_eq!(read(denied), None, "{denied}");
    }
}
