use super::*;
use crate::commands::compat_auth::MAX_MANIFEST_BYTES;
use crate::commands::fd::open_bound_root_fd;
use crate::commands::shortcuts_bin::make_test_bin_shortcuts;
use crate::commands::test_util::wsg_fixture;

#[test]
fn delete_livepruefung_verwirft_nachtraeglich_ungescopte_library() {
    let root = wsg_fixture("lf-delete-hardening-snapshot-boundary");
    let steam = root.join("steam");
    let external = root.join("external-library");
    let config_dir = steam.join("config");
    let target = external.join("steamapps/.protium-trash/compatdata_123_1");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&target).unwrap();

    let initial_vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
        steam.display()
    );
    std::fs::write(config_dir.join("libraryfolders.vdf"), initial_vdf).unwrap();
    let changed_vdf = format!(
        "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} }}",
        steam.display(),
        external.display()
    );
    std::fs::write(config_dir.join("libraryfolders.vdf"), changed_vdf).unwrap();

    let steam_owned = steam.clone();
    let error = inspect_deletion_target(
        steam.to_str().unwrap(),
        "trash",
        target.to_str().unwrap(),
        &|path| path.starts_with(&steam_owned),
    )
    .unwrap_err();
    assert!(error.contains("blocked-location"), "error: {error}");

    let _ = std::fs::remove_dir_all(&root);
}

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
        find_apps_using_compat_tool_linux_with_hook(&root_fd, "GE-Proton9-27", &mut config_hook)
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
fn manifest_read_bleibt_am_geoeffneten_fd_bei_pfadtausch() {
    let root = wsg_fixture("manifest-fd-swap");
    let library = root.join("library");
    let steamapps = library.join("steamapps");
    std::fs::create_dir_all(&steamapps).unwrap();
    let manifest = steamapps.join("appmanifest_570.acf");
    std::fs::write(&manifest, "\"AppState\" { \"appid\" \"570\" }").unwrap();

    let before_path = manifest.clone();
    let mut before_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
        if stage == DeleteReadStage::ManifestBeforeOpen {
            let old = before_path.with_extension("old");
            std::fs::rename(&before_path, old).unwrap();
            std::fs::File::create(&before_path)
                .unwrap()
                .set_len(MAX_MANIFEST_BYTES + 1)
                .unwrap();
        }
    };
    let error = is_app_installed_in_libraries_linux_with_hook(
        std::slice::from_ref(&library),
        570,
        &mut before_open,
    )
    .unwrap_err();
    assert!(error.contains("size-limit-exceeded"), "error: {error}");

    std::fs::write(&manifest, "\"AppState\" { \"appid\" \"570\" }").unwrap();
    let after_path = manifest.clone();
    let mut after_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
        if stage == DeleteReadStage::ManifestAfterOpen {
            let old = after_path.with_extension("bound");
            // defensiv: readdir-lieferung unter modifikation ist nicht
            // spezifiziert; ein zweiter slot darf nicht am fehlenden
            // original paniken.
            if std::fs::rename(&after_path, &old).is_ok() {
                std::fs::write(&after_path, "\"AppState\" { \"appid\" \"999\" }").unwrap();
            }
        }
    };
    assert!(
        is_app_installed_in_libraries_linux_with_hook(&[library], 570, &mut after_open,)
            .unwrap()
            .is_some()
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
        find_apps_using_compat_tool_linux_with_hook(&root_fd, "GE-Proton9-27", &mut before_open)
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
        find_apps_using_compat_tool_linux_with_hook(&root_fd, "GE-Proton9-27", &mut after_open)
            .unwrap(),
        vec![620]
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
    assert_eq!(apps, vec![620, 730]);

    let other = find_apps_using_compat_tool(&steam, "GE-Proton10-1").unwrap();
    assert!(other.is_empty());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn inspect_deletion_target_schuetzt_vor_falschen_loeschungen() {
    let root = wsg_fixture("inspect-target");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let steamapps = steam.join("steamapps");
    let compatdata = steamapps.join("compatdata");
    let shadercache = steamapps.join("shadercache");
    let tools_dir = steam.join("compatibilitytools.d");
    let trash_dir = steamapps.join(".protium-trash");

    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&compatdata).unwrap();
    std::fs::create_dir_all(&shadercache).unwrap();
    std::fs::create_dir_all(&tools_dir).unwrap();
    std::fs::create_dir_all(&trash_dir).unwrap();

    let lf_vdf = format!(
        "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
        steam.display()
    );
    std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

    // 1. Reines Orphan (kein Manifest, kein Shortcut)
    let orphan_dir = compatdata.join("999999");
    std::fs::create_dir_all(&orphan_dir).unwrap();
    let inspection = inspect_deletion_target(
        steam.to_str().unwrap(),
        "orphan",
        orphan_dir.to_str().unwrap(),
        &|_| true,
    )
    .unwrap();
    assert_eq!(inspection.target_type, "orphan");
    assert_eq!(inspection.consequences.len(), 1);
    assert_eq!(inspection.consequences[0].action, "trash");
    assert_eq!(
        inspection.consequences[0].affected_app_ids,
        Some(vec![999999])
    );

    // 2. Installiertes Spiel darf nicht als Orphan inspiziert werden;
    // der fehler nennt den spielnamen aus dem manifest statt nur die id.
    let installed_dir = compatdata.join("570");
    std::fs::create_dir_all(&installed_dir).unwrap();
    let manifest = "\"AppState\"\n{\n\t\"appid\"\t\t\"570\"\n\t\"name\"\t\t\"Dota 2\"\n}\n";
    std::fs::write(steamapps.join("appmanifest_570.acf"), manifest).unwrap();

    let err = inspect_deletion_target(
        steam.to_str().unwrap(),
        "orphan",
        installed_dir.to_str().unwrap(),
        &|_| true,
    )
    .unwrap_err();
    assert!(err.contains("currently installed"), "err: {err}");
    assert!(
        err.contains("Dota 2"),
        "fehler muss den spielnamen nennen: {err}"
    );

    // 3. Shortcut-Spiel darf nicht als Orphan inspiziert werden
    let shortcut_dir = compatdata.join("123456");
    std::fs::create_dir_all(&shortcut_dir).unwrap();
    let userdata_cfg = steam.join("userdata/12345/config");
    std::fs::create_dir_all(&userdata_cfg).unwrap();
    let sc_bytes = make_test_bin_shortcuts(&[123456]);
    std::fs::write(userdata_cfg.join("shortcuts.vdf"), sc_bytes).unwrap();

    let err2 = inspect_deletion_target(
        steam.to_str().unwrap(),
        "orphan",
        shortcut_dir.to_str().unwrap(),
        &|_| true,
    )
    .unwrap_err();
    assert!(err2.contains("non-steam shortcut"), "err: {err2}");

    // 4. GE-Proton Tool Inspektion
    let tool = tools_dir.join("GE-Proton9-27");
    std::fs::create_dir_all(&tool).unwrap();
    let tool_inspection = inspect_deletion_target(
        steam.to_str().unwrap(),
        "compatTool",
        tool.to_str().unwrap(),
        &|_| true,
    )
    .unwrap();
    assert_eq!(tool_inspection.target_type, "compatTool");
    assert_eq!(tool_inspection.consequences[0].action, "permanentDelete");

    // 5. Nicht-GE Tool -> Err
    let custom_tool = tools_dir.join("Proton-Custom");
    std::fs::create_dir_all(&custom_tool).unwrap();
    assert!(inspect_deletion_target(
        steam.to_str().unwrap(),
        "compatTool",
        custom_tool.to_str().unwrap(),
        &|_| true,
    )
    .is_err());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn inspect_deletion_target_lehnt_target_ausserhalb_scope_ab() {
    let root = wsg_fixture("inspect-target-scope");
    let steam = root.join("steam");
    let trash_dir = steam.join("steamapps/.protium-trash");
    let target = trash_dir.join("compatdata_123_1");
    std::fs::create_dir_all(&target).unwrap();

    // scope_ok autorisiert nur den steam-root selbst, nicht das target.
    // der target-check darf nicht am lexikalischen steam-root-suffix hängen.
    let steam_root_path = steam.clone();
    let result = inspect_deletion_target(
        steam.to_str().unwrap(),
        "trash",
        target.to_str().unwrap(),
        &|p| p == steam_root_path,
    );
    let err = result.unwrap_err();
    assert!(err.contains("blocked-location"), "err: {err}");

    // kontrast: scope der das target einschliesst → ok
    let steam_owned = steam.clone();
    let ok = inspect_deletion_target(
        steam.to_str().unwrap(),
        "trash",
        target.to_str().unwrap(),
        &|p| p.starts_with(&steam_owned),
    )
    .unwrap();
    assert_eq!(ok.target_type, "trash");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn trash_inspektion_erlaubt_nur_direkte_gueltige_ordner() {
    let root = wsg_fixture("inspect-trash-validator");
    let steam = root.join("steam");
    let trash_dir = steam.join("steamapps/.protium-trash");
    std::fs::create_dir_all(&trash_dir).unwrap();
    let all_in_scope = |_: &Path| true;
    let inspect = |path: &Path| {
        inspect_deletion_target(
            steam.to_str().unwrap(),
            "trash",
            path.to_str().unwrap(),
            &all_in_scope,
        )
    };

    let compatdata = trash_dir.join("compatdata_123_1700000000000");
    let shadercache = trash_dir.join("shadercache_4294967295_1");
    std::fs::create_dir_all(&compatdata).unwrap();
    std::fs::create_dir_all(&shadercache).unwrap();
    assert!(inspect(&compatdata).is_ok());
    assert!(inspect(&shadercache).is_ok());

    let nested = trash_dir.join("nested/compatdata_123_1");
    std::fs::create_dir_all(&nested).unwrap();
    assert!(inspect(&nested).is_err());

    let unknown = trash_dir.join("unknown_123_1");
    std::fs::create_dir_all(&unknown).unwrap();
    assert!(inspect(&unknown).is_err());

    let file = trash_dir.join("compatdata_123_2");
    std::fs::write(&file, b"not a directory").unwrap();
    assert!(inspect(&file).is_err());

    let app_id_zero = trash_dir.join("compatdata_0_3");
    let app_id_non_numeric = trash_dir.join("compatdata_not-a-number_5");
    let app_id_too_large = trash_dir.join("compatdata_4294967296_4");
    let timestamp_zero = trash_dir.join("compatdata_123_0");
    let timestamp_non_numeric = trash_dir.join("compatdata_123_not-a-number");
    let timestamp_overflow = trash_dir.join("compatdata_123_18446744073709551616");
    for path in [
        &app_id_zero,
        &app_id_non_numeric,
        &app_id_too_large,
        &timestamp_zero,
        &timestamp_non_numeric,
        &timestamp_overflow,
    ] {
        std::fs::create_dir_all(path).unwrap();
        assert!(
            inspect(path).is_err(),
            "muss abgelehnt werden: {}",
            path.display()
        );
    }

    #[cfg(unix)]
    {
        let symlink_target = trash_dir.join("symlink-target");
        let symlink = trash_dir.join("compatdata_123_5");
        std::fs::create_dir_all(&symlink_target).unwrap();
        std::os::unix::fs::symlink(&symlink_target, &symlink).unwrap();
        assert!(inspect(&symlink).is_err());
    }

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn inspection_erlaubt_non_steam_shortcut_appid() {
    let root = wsg_fixture("inspect-appid-non-steam");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let target = steam.join("steamapps/compatdata/2207218128");
    std::fs::create_dir_all(config_dir).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(
        steam.join("config/libraryfolders.vdf"),
        format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
            steam.display()
        ),
    )
    .unwrap();

    let result = inspect_deletion_target(
        steam.to_str().unwrap(),
        "orphan",
        target.to_str().unwrap(),
        &|_| true,
    );
    assert!(
        result.is_ok(),
        "inspection muss bit-31-appids autorisieren: {:?}",
        result.err()
    );
    assert!(target.exists());

    let _ = std::fs::remove_dir_all(root);
}

/// F1: eine gelistete library, die nicht nur fehlt, sondern scope- oder
/// lesegeschädigt ist, kann ein installiertes spiel verbergen. die
/// orphan-inspektion bricht dann fail-closed ab (INV-2); belegte
/// abwesenheit (`path-missing`) bleibt still übersprungen.
#[test]
fn orphan_inspektion_bricht_bei_geschaedigter_gelisteter_library_ab() {
    let root = wsg_fixture("inspect-orphan-unavailable-library");
    let steam = root.join("steam");
    let external = root.join("library-external");
    let ghost = root.join("library-ghost");
    let ghost_two = root.join("library-ghost-two");
    let broken = root.join("library-broken");
    let target = external.join("steamapps/compatdata/999999");
    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(broken.join("steamapps"), b"").unwrap();

    let all_in_scope = |_: &Path| true;
    let vdf = |ghost: &Path, broken: &Path| {
        format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} \"2\" {{ \"path\" \"{}\" }} \"3\" {{ \"path\" \"{}\" }} }}",
            steam.display(),
            external.display(),
            ghost.display(),
            broken.display()
        )
    };
    std::fs::write(
        steam.join("config/libraryfolders.vdf"),
        vdf(&ghost, &broken),
    )
    .unwrap();

    let error = inspect_deletion_target(
        steam.to_str().unwrap(),
        "orphan",
        target.to_str().unwrap(),
        &all_in_scope,
    )
    .unwrap_err();
    assert!(error.contains("unavailable"), "error: {error}");
    assert!(
        error.contains(broken.to_string_lossy().as_ref()),
        "error: {error}"
    );

    // nur fehlende libraries: belegte abwesenheit, die prüfung läuft weiter.
    std::fs::write(
        steam.join("config/libraryfolders.vdf"),
        vdf(&ghost, &ghost_two),
    )
    .unwrap();
    let inspection = inspect_deletion_target(
        steam.to_str().unwrap(),
        "orphan",
        target.to_str().unwrap(),
        &all_in_scope,
    )
    .unwrap();
    assert_eq!(inspection.target_type, "orphan");
    assert_eq!(inspection.consequences.len(), 1);

    let _ = std::fs::remove_dir_all(root);
}
