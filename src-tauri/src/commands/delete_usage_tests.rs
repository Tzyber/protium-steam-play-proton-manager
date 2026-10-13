use super::*;
use crate::commands::compat_auth::MAX_MANIFEST_BYTES;
use crate::commands::fd::open_bound_root_fd;
use crate::commands::shortcuts_bin::make_test_bin_shortcuts;
use crate::commands::test_util::wsg_fixture;

#[test]
fn is_app_installed_in_libraries_pruefung() {
    let root = wsg_fixture("app-installed-check");
    let lib = root.join("lib");
    let steamapps = lib.join("steamapps");
    std::fs::create_dir_all(&steamapps).unwrap();

    let manifest = "\"AppState\"\n{\n\t\"appid\"\t\t\"570\"\n\t\"name\"\t\t\"Dota 2\"\n}\n";
    std::fs::write(steamapps.join("appmanifest_570.acf"), manifest).unwrap();

    let libraries = vec![lib.clone()];
    assert!(is_app_installed_in_libraries(&libraries, 570)
        .unwrap()
        .is_some());
    assert!(is_app_installed_in_libraries(&libraries, 730)
        .unwrap()
        .is_none());

    // Mismatched filename/internal ID -> fail-closed
    let bad_manifest = "\"AppState\"\n{\n\t\"appid\"\t\t\"999\"\n}\n";
    std::fs::write(steamapps.join("appmanifest_440.acf"), bad_manifest).unwrap();
    assert!(is_app_installed_in_libraries(&libraries, 440).is_err());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn is_app_installed_library_ohne_steamapps_wird_uebersprungen() {
    let root = wsg_fixture("app-installed-missing-steamapps");
    let present = root.join("present");
    std::fs::create_dir_all(present.join("steamapps")).unwrap();
    let absent = root.join("absent"); // kein steamapps (z. b. volume nicht gemountet)

    // fehlende steamapps = dort liegen keine manifeste: kein fehler (INV-2).
    let libraries = vec![absent, present.clone()];
    assert!(is_app_installed_in_libraries(&libraries, 570)
        .unwrap()
        .is_none());

    // symlink-steamapps bleibt anomalie -> abgelehnt.
    let symlink_steamapps = root.join("symlinklib");
    std::fs::create_dir_all(&symlink_steamapps).unwrap();
    std::os::unix::fs::symlink(
        present.join("steamapps"),
        symlink_steamapps.join("steamapps"),
    )
    .unwrap();
    let symlink_libs = vec![symlink_steamapps];
    assert!(is_app_installed_in_libraries(&symlink_libs, 570).is_err());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn uebergrosses_manifest_blockiert_delete_inspektion() {
    let root = wsg_fixture("app-installed-oversized");
    let lib = root.join("lib");
    let steamapps = lib.join("steamapps");
    std::fs::create_dir_all(&steamapps).unwrap();
    let oversized = vec![b'x'; (MAX_MANIFEST_BYTES + 1) as usize];
    std::fs::write(steamapps.join("appmanifest_570.acf"), oversized).unwrap();

    let error = is_app_installed_in_libraries(&[lib], 570).unwrap_err();
    assert!(error.contains("size-limit-exceeded"), "error: {error}");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn uebergrosse_config_vdf_blockiert_compat_tool_suche() {
    let root = wsg_fixture("config-vdf-oversized");
    let steam_root = root.join("steam");
    std::fs::create_dir_all(steam_root.join("config")).unwrap();
    let oversized = vec![b'x'; (MAX_DELETE_CONFIG_BYTES + 1) as usize];
    std::fs::write(steam_root.join("config/config.vdf"), oversized).unwrap();

    let error = find_apps_using_compat_tool(&steam_root, "GE-Proton9-27").unwrap_err();
    assert!(error.contains("size-limit-exceeded"), "error: {error}");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn delete_reads_begrenzen_wachstum_nach_fd_pruefung() {
    let root = wsg_fixture("delete-read-growth");

    let library = root.join("library");
    let manifest_dir = library.join("steamapps");
    std::fs::create_dir_all(&manifest_dir).unwrap();
    std::fs::write(
        manifest_dir.join("appmanifest_570.acf"),
        "\"AppState\" { \"appid\" \"570\" }",
    )
    .unwrap();
    let manifest_path = manifest_dir.join("appmanifest_570.acf");
    let mut manifest_hook = |stage: DeleteReadStage, _file: Option<&mut std::fs::File>| {
        if stage == DeleteReadStage::ManifestBeforeRead {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&manifest_path)
                .unwrap()
                .set_len(MAX_MANIFEST_BYTES + 1)
                .unwrap();
        }
    };
    let manifest_error =
        is_app_installed_in_libraries_linux_with_hook(&[library], 570, &mut manifest_hook)
            .unwrap_err();
    assert!(
        manifest_error.contains("size-limit-exceeded"),
        "error: {manifest_error}"
    );

    let steam = root.join("steam");
    let config_dir = steam.join("config");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(config_dir.join("config.vdf"), "\"InstallConfigStore\" {}\n").unwrap();
    let steam = std::fs::canonicalize(&steam).unwrap();
    let root_fd = open_bound_root_fd(&steam, &mut || {}).unwrap();
    let config_path = config_dir.join("config.vdf");
    let mut config_hook = |stage: DeleteReadStage, _file: Option<&mut std::fs::File>| {
        if stage == DeleteReadStage::ConfigBeforeRead {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&config_path)
                .unwrap()
                .set_len(MAX_DELETE_CONFIG_BYTES + 1)
                .unwrap();
        }
    };
    let config_error =
        find_apps_using_compat_tool_linux_with_hook(&root_fd, &["GE-Proton9-27"], &mut config_hook)
            .unwrap_err();
    assert!(
        config_error.contains("size-limit-exceeded"),
        "error: {config_error}"
    );

    let shortcut_dir = steam.join("userdata/123/config");
    std::fs::create_dir_all(&shortcut_dir).unwrap();
    std::fs::write(
        shortcut_dir.join("shortcuts.vdf"),
        make_test_bin_shortcuts(&[42]),
    )
    .unwrap();
    let shortcuts_path = shortcut_dir.join("shortcuts.vdf");
    let mut shortcuts_hook = |stage: DeleteReadStage, _file: Option<&mut std::fs::File>| {
        if stage == DeleteReadStage::ShortcutsBeforeRead {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&shortcuts_path)
                .unwrap()
                .set_len(MAX_SHORTCUTS_VDF_BYTES + 1)
                .unwrap();
        }
    };
    let shortcuts_root_fd = open_bound_root_fd(&steam, &mut || {}).unwrap();
    let shortcuts_error =
        read_all_shortcut_app_ids_linux_with_hook(&shortcuts_root_fd, &mut shortcuts_hook)
            .unwrap_err();
    assert!(
        shortcuts_error.contains("size-limit-exceeded"),
        "error: {shortcuts_error}"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn config_read_bleibt_am_geoeffneten_fd_bei_pfadtausch() {
    let root = wsg_fixture("config-fd-swap");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    std::fs::create_dir_all(&config_dir).unwrap();
    let config = config_dir.join("config.vdf");
    let content = "\"InstallConfigStore\" { \"Software\" { \"Valve\" { \"Steam\" { \"CompatToolMapping\" { \"620\" { \"name\" \"GE-Proton9-27\" } } } } } }";
    std::fs::write(&config, content).unwrap();
    let steam = std::fs::canonicalize(&steam).unwrap();
    let root_fd = open_bound_root_fd(&steam, &mut || {}).unwrap();

    let before_path = config.clone();
    let mut before_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
        if stage == DeleteReadStage::ConfigBeforeOpen {
            let old = before_path.with_extension("old");
            std::fs::rename(&before_path, old).unwrap();
            std::fs::File::create(&before_path)
                .unwrap()
                .set_len(MAX_DELETE_CONFIG_BYTES + 1)
                .unwrap();
        }
    };
    let error =
        find_apps_using_compat_tool_linux_with_hook(&root_fd, &["GE-Proton9-27"], &mut before_open)
            .unwrap_err();
    assert!(error.contains("size-limit-exceeded"), "error: {error}");

    std::fs::write(&config, content).unwrap();
    let after_path = config.clone();
    let mut after_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
        if stage == DeleteReadStage::ConfigAfterOpen {
            let old = after_path.with_extension("bound");
            std::fs::rename(&after_path, old).unwrap();
            std::fs::write(&after_path, "\"InstallConfigStore\" {}").unwrap();
        }
    };
    assert_eq!(
        find_apps_using_compat_tool_linux_with_hook(&root_fd, &["GE-Proton9-27"], &mut after_open)
            .unwrap(),
        (vec![620], false)
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn shortcuts_read_bleibt_am_geoeffneten_fd_bei_pfadtausch() {
    let root = wsg_fixture("shortcuts-fd-swap");
    let steam = root.join("steam");
    let config_dir = steam.join("userdata/123/config");
    std::fs::create_dir_all(&config_dir).unwrap();
    let shortcuts = config_dir.join("shortcuts.vdf");
    std::fs::write(&shortcuts, make_test_bin_shortcuts(&[42])).unwrap();
    let steam = std::fs::canonicalize(&steam).unwrap();
    let root_fd = open_bound_root_fd(&steam, &mut || {}).unwrap();

    let before_path = shortcuts.clone();
    let mut before_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
        if stage == DeleteReadStage::ShortcutsBeforeOpen {
            let old = before_path.with_extension("old");
            std::fs::rename(&before_path, old).unwrap();
            std::fs::File::create(&before_path)
                .unwrap()
                .set_len(MAX_SHORTCUTS_VDF_BYTES + 1)
                .unwrap();
        }
    };
    let error = read_all_shortcut_app_ids_linux_with_hook(&root_fd, &mut before_open).unwrap_err();
    assert!(error.contains("size-limit-exceeded"), "error: {error}");

    std::fs::write(&shortcuts, make_test_bin_shortcuts(&[42])).unwrap();
    let after_path = shortcuts.clone();
    let mut after_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
        if stage == DeleteReadStage::ShortcutsAfterOpen {
            let old = after_path.with_extension("bound");
            std::fs::rename(&after_path, old).unwrap();
            std::fs::write(&after_path, b"not-a-shortcuts-vdf").unwrap();
        }
    };
    assert!(
        read_all_shortcut_app_ids_linux_with_hook(&root_fd, &mut after_open)
            .unwrap()
            .contains(&42)
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn read_all_shortcut_app_ids_lehnt_riesige_datei_ab() {
    let root = wsg_fixture("shortcuts-huge");
    let steam = root.join("steam");
    let config_dir = steam.join("userdata/12345/config");
    std::fs::create_dir_all(&config_dir).unwrap();
    let shortcuts_vdf = config_dir.join("shortcuts.vdf");
    // sparse file ueber dem größenlimit: darf nicht gelesen werden
    let file = std::fs::File::create(&shortcuts_vdf).unwrap();
    file.set_len(17 * 1024 * 1024).unwrap();
    drop(file);
    let err = read_all_shortcut_app_ids(&steam).unwrap_err();
    assert!(err.contains("size-limit-exceeded"), "err: {err}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn find_apps_using_compat_tool_findet_abhaengige_spiele() {
    let root = wsg_fixture("compat-tool-usage");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    std::fs::create_dir_all(&config_dir).unwrap();

    let config_content = r#"
"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
				"0"
				{
					"name"		"proton-cachyos-slr"
				}
				"2207218128"
				{
					"name"		"GE-Proton11-4"
				}
					"620"
					{
						"name"		"GE-Proton9-27"
						"config"		""
						"priority"		"250"
					}
					"730"
					{
						"name"		"GE-Proton9-27"
					}
					"570"
					{
						"name"		"proton_experimental"
					}
				}
			}
		}
	}
}
"#;
    std::fs::write(config_dir.join("config.vdf"), config_content).unwrap();

    let apps = find_apps_using_compat_tool(&steam, "GE-Proton9-27").unwrap();
    assert_eq!(apps, (vec![620, 730], false));

    let other = find_apps_using_compat_tool(&steam, "GE-Proton10-1").unwrap();
    assert_eq!(other, (vec![], false));

    let global = find_apps_using_compat_tool(&steam, "proton-cachyos-slr").unwrap();
    assert_eq!(global, (vec![], true));

    let _ = std::fs::remove_dir_all(&root);
}
