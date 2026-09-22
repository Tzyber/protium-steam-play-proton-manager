use super::*;
use crate::commands::test_util::wsg_fixture;
use std::path::PathBuf;

#[test]
fn libraryfolders_parser_fixture_behaelt_reihenfolge_und_first_wins() {
    let text = include_str!("../../../tests/fixtures/libraryfolders-parser.vdf");
    assert_eq!(
        parse_library_folder_paths(text).unwrap(),
        vec![
            PathBuf::from("/fixture/library-ten"),
            PathBuf::from("/fixture/library-two"),
        ]
    );
}

#[test]
fn libraryfolders_parser_ignoriert_leeren_block_und_defekte_roots() {
    assert_eq!(
        parse_library_folder_paths(include_str!(
            "../../../tests/fixtures/libraryfolders-parser-empty.vdf"
        ))
        .unwrap(),
        Vec::<PathBuf>::new()
    );
    assert!(parse_library_folder_paths(include_str!(
        "../../../tests/fixtures/libraryfolders-parser-missing-root.vdf"
    ))
    .is_err());
    assert!(parse_library_folder_paths(include_str!(
        "../../../tests/fixtures/libraryfolders-parser-scalar-root.vdf"
    ))
    .is_err());
    assert!(parse_library_folder_paths(include_str!(
        "../../../tests/fixtures/libraryfolders-parser-broken.vdf"
    ))
    .is_err());
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
            assert!(authorized[0].real.is_some());
            assert_eq!(authorized[1].requested, paths[1]);
            assert!(authorized[1].real.is_none());
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
    assert!(result.is_err());

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
    assert!(result.is_err());
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

#[test]
fn read_library_folders_lehnt_symlink_und_nicht_regulaere_datei_ab() {
    let root = wsg_fixture("lf-delete-hardening-file-types");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let steamapps = steam.join("steamapps");
    let external = root.join("external");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&steamapps).unwrap();
    std::fs::create_dir_all(&external).unwrap();
    let valid_vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
        external.display()
    );
    let target = config_dir.join("libraryfolders.vdf");
    let external_vdf = root.join("external-libraryfolders.vdf");
    std::fs::write(&external_vdf, &valid_vdf).unwrap();
    std::fs::write(steamapps.join("libraryfolders.vdf"), &valid_vdf).unwrap();

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&external_vdf, &target).unwrap();
        let error = read_library_folders(&steam).unwrap_err();
        assert!(error.contains("symlink"), "error: {error}");
        std::fs::remove_file(&target).unwrap();

        let dangling_target = root.join("missing-libraryfolders.vdf");
        std::os::unix::fs::symlink(&dangling_target, &target).unwrap();
        let error = read_library_folders(&steam).unwrap_err();
        assert!(error.contains("symlink"), "error: {error}");
        std::fs::remove_file(&target).unwrap();
    }

    std::fs::create_dir(&target).unwrap();
    assert!(read_library_folders(&steam).is_err());
    std::fs::remove_dir(&target).unwrap();

    let steamapps_vdf = steamapps.join("libraryfolders.vdf");
    #[cfg(unix)]
    {
        std::fs::remove_file(&steamapps_vdf).unwrap();
        std::os::unix::fs::symlink(&external_vdf, &steamapps_vdf).unwrap();
        let error = read_library_folders(&steam).unwrap_err();
        assert!(error.contains("symlink"), "error: {error}");
        std::fs::remove_file(&steamapps_vdf).unwrap();

        std::fs::create_dir(&steamapps_vdf).unwrap();
        assert!(read_library_folders(&steam).is_err());
        std::fs::remove_dir(&steamapps_vdf).unwrap();

        let external_steamapps = root.join("external-steamapps");
        std::fs::create_dir_all(&external_steamapps).unwrap();
        std::fs::write(external_steamapps.join("libraryfolders.vdf"), &valid_vdf).unwrap();
        std::fs::remove_dir(&steamapps).unwrap();
        std::os::unix::fs::symlink(&external_steamapps, &steamapps).unwrap();
        assert!(read_library_folders(&steam).is_err());
    }

    #[cfg(not(unix))]
    {
        std::fs::remove_file(&steamapps_vdf).unwrap();
        std::fs::create_dir(&steamapps_vdf).unwrap();
        assert!(read_library_folders(&steam).is_err());
    }

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn read_library_folders_lehnt_dateien_ueber_dem_read_limit_ab() {
    let root = wsg_fixture("lf-delete-hardening-size");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let steamapps = steam.join("steamapps");
    let library = root.join("library");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&steamapps).unwrap();
    std::fs::create_dir_all(&library).unwrap();
    let prefix = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
        library.display()
    );
    let path = config_dir.join("libraryfolders.vdf");
    std::fs::write(&path, prefix).unwrap();
    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();

    let error = read_library_folders(&steam).unwrap_err();
    assert!(error.contains("size-limit-exceeded"), "error: {error}");

    let _ = std::fs::remove_dir_all(&root);
}

/// Deckt das TOCTOU-Fenster aus S-2 ab: eine reguläre, gültige Datei besteht
/// die Pfad-Vorprüfung, im Hook wird sie gegen ein Verzeichnis getauscht.
/// Die alte Pfad-Lesung scheitert dann erst an `read` (EISDIR), die
/// Deskriptorkette erkennt den Typ am Deskriptor. Bewusst kein FIFO: ein
/// FIFO macht den alten Pfad nur blockierend sichtbar, nicht rot.
#[cfg(target_os = "linux")]
#[test]
fn getauschtes_verzeichnis_libraryfolders_wird_am_deskriptor_abgelehnt() {
    use std::sync::mpsc;

    let root = wsg_fixture("lf-delete-hardening-swap");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let library = root.join("library");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();
    std::fs::create_dir_all(&library).unwrap();
    let path = config_dir.join("libraryfolders.vdf");
    let valid_vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
        library.display()
    );
    std::fs::write(&path, &valid_vdf).unwrap();

    let (swap_ready, wait_for_swap) = mpsc::channel();
    let (wake_worker, wait_for_open) = mpsc::channel();
    // Der Hook synchronisiert nur; den Tausch macht der Hauptthread genau
    // zwischen Pfad-Vorprüfung und Deskriptor-Open.
    let mut hook = move || {
        swap_ready.send(()).unwrap();
        wait_for_open.recv().unwrap();
    };
    let worker = std::thread::spawn(move || {
        read_library_folders_with_hook(&steam, &mut hook).map(|(libraries, _)| libraries)
    });

    wait_for_swap.recv().unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    wake_worker.send(()).unwrap();
    let result = worker.join().unwrap();
    let error = result.unwrap_err();
    assert!(error.contains("not a regular file"), "error: {error}");

    let _ = std::fs::remove_dir_all(&root);
}

/// Statischer FIFO an der Stelle der Datei: die alte Pfad-Lesung hängt im
/// Open, die Deskriptorkette lehnt ihn wegen `O_NONBLOCK` und der
/// Typprüfung sofort ab.
#[cfg(target_os = "linux")]
#[test]
fn fifo_libraryfolders_blockiert_den_delete_pfad_nicht() {
    use std::os::unix::ffi::OsStrExt;
    use std::sync::mpsc;
    use std::time::Duration;

    let root = wsg_fixture("lf-delete-hardening-fifo");
    let steam = root.join("steam");
    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();
    let fifo = steam.join("config/libraryfolders.vdf");
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);

    let (sender, receiver) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = read_library_folders(&steam);
        sender.send(result).unwrap();
    });
    let completed = receiver.recv_timeout(Duration::from_secs(2));
    // O_RDWR blockiert nie und weckt einen blockierten O_RDONLY-Open, damit
    // bei einer Regression kein Testthread zurückbleibt.
    let rescue = if completed.is_err() {
        Some(
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&fifo)
                .unwrap(),
        )
    } else {
        None
    };
    worker.join().unwrap();
    drop(rescue);
    assert!(
        completed.is_ok(),
        "FIFO libraryfolders.vdf blockierte den Aufruf"
    );
    let error = completed.unwrap().unwrap_err();
    assert!(error.contains("not a regular file"), "error: {error}");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn read_library_folders_config_und_steamapps_fallback_bleiben_identisch() {
    let root = wsg_fixture("lf-delete-hardening-fallback");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let steamapps = steam.join("steamapps");
    let config_library = root.join("config-library");
    let fallback_library = root.join("fallback-library");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&steamapps).unwrap();
    std::fs::create_dir_all(config_library.join("steamapps")).unwrap();
    std::fs::create_dir_all(fallback_library.join("steamapps")).unwrap();

    let config_vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
        config_library.display()
    );
    std::fs::write(config_dir.join("libraryfolders.vdf"), &config_vdf).unwrap();
    let config_libraries = read_library_folders(&steam).unwrap();

    std::fs::remove_file(config_dir.join("libraryfolders.vdf")).unwrap();
    let fallback_vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
        fallback_library.display()
    );
    std::fs::write(steamapps.join("libraryfolders.vdf"), &fallback_vdf).unwrap();
    let fallback_libraries = read_library_folders(&steam).unwrap();

    let steam = std::fs::canonicalize(&steam).unwrap();
    let config_library = std::fs::canonicalize(config_library).unwrap();
    let fallback_library = std::fs::canonicalize(fallback_library).unwrap();
    assert_eq!(config_libraries, vec![steam.clone(), config_library]);
    assert_eq!(fallback_libraries, vec![steam.clone(), fallback_library]);

    std::fs::remove_file(steam.join("steamapps/libraryfolders.vdf")).unwrap();
    std::fs::write(
        steam.join("steamapps/libraryfolders.vdf"),
        "\"libraryfolders\" {}",
    )
    .unwrap();
    let empty_libraries = read_library_folders(&steam).unwrap();
    assert_eq!(empty_libraries, vec![steam.clone()]);

    std::fs::remove_file(steam.join("steamapps/libraryfolders.vdf")).unwrap();
    let no_vdf_libraries = read_library_folders(&steam).unwrap();
    assert_eq!(no_vdf_libraries, vec![steam.clone()]);

    std::fs::remove_dir_all(steam.join("steamapps")).unwrap();
    assert!(read_library_folders(&steam).is_err());

    std::fs::write(steam.join("steamapps"), b"").unwrap();
    assert!(read_library_folders(&steam).is_err());

    let _ = std::fs::remove_dir_all(&root);
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

/// F1: fehlgeschlagene libraries bleiben mit grund erhalten statt verworfen
/// zu werden (INV-2). Nur `path-missing` ist belegte abwesenheit.
#[test]
fn read_library_folders_mit_failures_klassifiziert_und_sammelt_gruende() {
    let root = wsg_fixture("lf-unavailable-reasons");
    let steam = root.join("steam");
    let accessible = root.join("library-a");
    let missing = root.join("library-b");
    let broken_structure = root.join("library-c");
    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();
    std::fs::create_dir_all(accessible.join("steamapps")).unwrap();
    // library B fehlt auf der platte (nicht gemountet), library C hat eine
    // datei namens steamapps statt eines verzeichnisses.
    std::fs::create_dir_all(&broken_structure).unwrap();
    std::fs::write(broken_structure.join("steamapps"), b"").unwrap();

    let vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} \"2\" {{ \"path\" \"{}\" }} }}",
        accessible.display(),
        missing.display(),
        broken_structure.display()
    );
    std::fs::write(steam.join("config/libraryfolders.vdf"), vdf).unwrap();

    let (libraries, unavailable) = read_library_folders_with_failures(&steam).unwrap();
    let steam = std::fs::canonicalize(&steam).unwrap();
    let accessible = std::fs::canonicalize(&accessible).unwrap();
    assert_eq!(libraries, vec![steam.clone(), accessible.clone()]);
    assert_eq!(
        unavailable,
        vec![
            LibraryUnavailable {
                path: missing.to_string_lossy().into_owned(),
                reason: LibraryUnavailableReason::PathMissing,
            },
            LibraryUnavailable {
                path: broken_structure.to_string_lossy().into_owned(),
                reason: LibraryUnavailableReason::ScopeFailed,
            },
        ]
    );

    // der wrapper für nicht-snapshot-aufrufer verwirft nur die fehlerliste.
    assert_eq!(read_library_folders(&steam).unwrap(), libraries);

    // read-failed: der pfad existiert, ist aber nicht auflösbar. als
    // nicht-root greift chmod 000 (EACCES); als root umgeht der kernel die
    // rechteprüfung, deshalb der selbstreferenz-symlink auf dem
    // library-pfad (ELOOP). bewusst nicht auf `steamapps`: ein symlink
    // zählt dort laut drahtvertrag als scope-failed, und `lstat` folgt ihm
    // nicht, ELOOP entsteht erst beim auflösen.
    let unreadable = root.join("library-d");
    std::fs::create_dir_all(&unreadable).unwrap();
    let read_failed_reason = LibraryUnavailableReason::ReadFailed;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::symlink_metadata(&unreadable).is_ok() {
            // root umgeht die rechteprüfung: der selbstreferenz-symlink
            // liefert ELOOP beim auflösen (siehe klassifikation).
            std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::fs::remove_dir(&unreadable).unwrap();
            std::os::unix::fs::symlink(&unreadable, &unreadable).unwrap();
        }
        // chmod 000 greift für cleanup und für den fixture-rest nicht mehr.
        let _ = std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(&unreadable).unwrap();
        std::fs::write(unreadable.join("steamapps"), b"").unwrap();
    }
    let read_failed_path = unreadable.clone();

    let vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} }}",
        accessible.display(),
        missing.display()
    );
    std::fs::write(steam.join("config/libraryfolders.vdf"), vdf).unwrap();
    let (libraries, unavailable) = read_library_folders_with_failures(&steam).unwrap();
    assert_eq!(libraries, vec![steam.clone(), accessible.clone()]);
    assert_eq!(unavailable.len(), 1);
    assert_eq!(unavailable[0].reason, LibraryUnavailableReason::PathMissing);

    let vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} }}",
        accessible.display(),
        read_failed_path.display()
    );
    std::fs::write(steam.join("config/libraryfolders.vdf"), vdf).unwrap();
    let (libraries, unavailable) = read_library_folders_with_failures(&steam).unwrap();
    assert_eq!(libraries, vec![steam.clone(), accessible.clone()]);
    assert_eq!(unavailable.len(), 1, "unavailable: {unavailable:?}");
    assert_eq!(unavailable[0].reason, read_failed_reason);
    assert_eq!(
        unavailable[0].path,
        read_failed_path.to_string_lossy().into_owned()
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn read_library_folders_happy_path_und_corrupt() {
    let root = wsg_fixture("lf-readers");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();

    let lib1 = root.join("lib1");
    let lib2 = root.join("lib2");
    std::fs::create_dir_all(lib1.join("steamapps")).unwrap();
    std::fs::create_dir_all(lib2.join("steamapps")).unwrap();

    let lf_vdf = format!(
        "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n\t\"1\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
        lib1.display(),
        lib2.display()
    );
    std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

    let libs = read_library_folders(&steam).unwrap();
    assert_eq!(libs.len(), 3);
    assert_eq!(libs[0], std::fs::canonicalize(&steam).unwrap());
    assert_eq!(libs[1], std::fs::canonicalize(&lib1).unwrap());
    assert_eq!(libs[2], std::fs::canonicalize(&lib2).unwrap());

    // Corrupt VDF -> Fail-closed
    std::fs::write(
        config_dir.join("libraryfolders.vdf"),
        "\"libraryfolders\" { \"0\" { unclosed",
    )
    .unwrap();
    assert!(read_library_folders(&steam).is_err());

    let _ = std::fs::remove_dir_all(&root);
}
