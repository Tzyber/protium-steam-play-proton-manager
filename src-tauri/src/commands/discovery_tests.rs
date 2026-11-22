use super::*;

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
    let err = result.unwrap_err();
    assert!(
        err.contains("steam-root-symlink-unsupported"),
        "expected steam-root-symlink-unsupported, got: {err}"
    );

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
    let err = result.unwrap_err();
    assert!(
        err.contains("steam-root-symlink-unsupported"),
        "expected steam-root-symlink-unsupported, got: {err}"
    );
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

/// S-11: `$HOME` sowie Vorfahren von `$HOME`, `$APPCACHE` oder `$APPCONFIG`
/// dürfen in `build_environment_snapshot` nie als Steam-Library autorisiert
/// werden.
#[test]
fn discovery_lehnt_home_und_app_dir_vorfahren_als_library_ab() {
    use crate::commands::scope::LibraryUnavailableReason;
    use crate::commands::test_util::wsg_fixture;

    let temp = wsg_fixture("discovery-s11");
    let home = temp.join("home");
    let steam = home.join(".local/share/Steam");
    let app_parent = temp.join("app-parent");
    let cache = app_parent.join("cache");
    let config = app_parent.join("config");
    let valid_lib = temp.join("external-lib");

    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();
    std::fs::create_dir_all(home.join("steamapps")).unwrap();
    std::fs::create_dir_all(app_parent.join("steamapps")).unwrap();
    std::fs::create_dir_all(valid_lib.join("steamapps")).unwrap();

    let vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} \"2\" {{ \"path\" \"{}\" }} }}",
        home.display(),
        app_parent.display(),
        valid_lib.display()
    );
    std::fs::write(steam.join("config/libraryfolders.vdf"), vdf).unwrap();

    let snapshot = build_environment_snapshot(&home, &cache, &config).unwrap();
    let home_canon = std::fs::canonicalize(&home).unwrap();
    let app_parent_canon = std::fs::canonicalize(&app_parent).unwrap();
    let valid_canon = std::fs::canonicalize(&valid_lib).unwrap();

    assert!(!snapshot.libraries.contains(&home_canon));
    assert!(!snapshot.libraries.contains(&app_parent_canon));
    assert!(snapshot.libraries.contains(&valid_canon));

    let scope_failed_paths: Vec<&str> = snapshot
        .unavailable_libraries
        .iter()
        .filter(|entry| entry.reason == LibraryUnavailableReason::ScopeFailed)
        .map(|entry| entry.path.as_str())
        .collect();
    assert!(
        scope_failed_paths.contains(&home.to_string_lossy().as_ref())
            || scope_failed_paths.contains(&home_canon.to_string_lossy().as_ref()),
        "home muss als scope-failed abgelehnt sein: {scope_failed_paths:?}"
    );
    assert!(
        scope_failed_paths.contains(&app_parent_canon.to_string_lossy().as_ref())
            || scope_failed_paths.contains(&app_parent.to_string_lossy().as_ref()),
        "app_parent muss als scope-failed abgelehnt sein: {scope_failed_paths:?}"
    );

    let _ = std::fs::remove_dir_all(&temp);
}
