use super::*;
#[cfg(target_os = "linux")]
use crate::commands::fd::{open_absolute_dir, open_bound_root_fd};
use crate::commands::test_util::wsg_fixture;

#[cfg(target_os = "linux")]
fn valve_authority_fixture(tag: &str) -> (PathBuf, PathBuf) {
    let root = wsg_fixture(tag);
    let steam = root.join("steam");
    std::fs::create_dir_all(steam.join("config")).unwrap();
    (root, steam)
}

#[cfg(target_os = "linux")]
fn wsg_env(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
    let root = wsg_fixture(tag);
    let home = root.join("fakehome");
    let steam = home.join(".local/share/Steam");
    let cache = root.join("cache");
    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::create_dir_all(steam.join("userdata/123/config")).unwrap();
    std::fs::create_dir_all(&cache).unwrap();
    for tool_name in ["GE-Proton9-27", "GE-Proton9-28"] {
        let tool_dir = steam.join("compatibilitytools.d").join(tool_name);
        std::fs::create_dir_all(&tool_dir).unwrap();
        let tool_vdf =
            format!("\"compatibilitytools\" {{ \"compat_tools\" {{ \"{tool_name}\" {{ }} }} }}");
        std::fs::write(tool_dir.join("compatibilitytool.vdf"), tool_vdf).unwrap();
    }
    (home, cache, steam)
}

#[cfg(target_os = "linux")]
fn tool_vdf(tool_name: &str) -> String {
    format!("\"compatibilitytools\" {{ \"compat_tools\" {{ \"{tool_name}\" {{ }} }} }}")
}

// Fixture für S-1: Tool-Ordner mit rohem VDF-inhalt. Bei gemischten
// fixtures steht `BrokenTool` zuerst, damit der kaputte ordner zuerst
// gelesen wird (fs::read_dir liefert einträge in anlagereihenfolge) und
// der test den alten abbruch reproduziert.
#[cfg(target_os = "linux")]
fn compat_tools_fixture(tag: &str, dirs: &[(&str, &[u8])]) -> PathBuf {
    let root = wsg_fixture(tag);
    for (dir, vdf_bytes) in dirs {
        let tool_dir = root.join(dir);
        std::fs::create_dir_all(&tool_dir).unwrap();
        std::fs::write(tool_dir.join("compatibilitytool.vdf"), vdf_bytes).unwrap();
    }
    root
}

#[cfg(target_os = "linux")]
#[test]
fn compat_autorisiert_trotz_kaputter_vdf_und_lehnt_unbekannte_namen_ab() {
    let intact_dir = "GE-Proton9-27";
    let intact_name = "GE-Proton11-5-x86_64";
    let intact = tool_vdf(intact_name);
    // nicht-UTF8-bytes: der lesepfad scheitert, der ordner wird verlassen.
    // Der angefragte name steht bewusst nicht in dieser datei — die
    // fail-closed-eigenschaft ist, dass ohne geparsten inhalt kein name
    // autorisiert wird (das 0xFF-byte wird nicht als name interpretiert).
    let broken = b"\"compatibilitytools\" { \"compat_tools\" { \"Broken\" { \xff } } }";
    // zweiter skip-pfad: statt einer datei liegt ein verzeichnis mit dem
    // VDF-namen im tool-ordner; `read_to_string` scheitert am read.
    let unreadable_dir = "GE-Proton8-30";

    let only_broken = compat_tools_fixture("compat-broken-only", &[("BrokenTool", broken)]);
    let broken_fd = open_absolute_dir(&only_broken).unwrap();
    let result = compat_root_contains_name_at_fd(&broken_fd, intact_dir, &mut |_| {});
    assert!(
        result.is_ok(),
        "kaputter ordner darf die ganze autorisierung nicht abbrechen: {result:?}"
    );
    assert!(
        !result.unwrap(),
        "ein kaputter ordner autorisiert keinen namen"
    );
    drop(broken_fd);
    let _ = std::fs::remove_dir_all(only_broken);

    let only_unreadable = compat_tools_fixture("compat-unreadable-only", &[]);
    std::fs::create_dir_all(
        only_unreadable
            .join(unreadable_dir)
            .join("compatibilitytool.vdf"),
    )
    .unwrap();
    let unreadable_fd = open_absolute_dir(&only_unreadable).unwrap();
    let result = compat_root_contains_name_at_fd(&unreadable_fd, unreadable_dir, &mut |_| {});
    assert!(
        result.is_ok(),
        "unlesbarer vdf-name darf die autorisierung nicht abbrechen: {result:?}"
    );
    assert!(
        !result.unwrap(),
        "ein unlesbarer vdf-name autorisiert keinen namen"
    );
    drop(unreadable_fd);
    let _ = std::fs::remove_dir_all(only_unreadable);

    let intact_dir_only =
        compat_tools_fixture("compat-intact-only", &[(intact_dir, intact.as_bytes())]);
    let intact_fd = open_absolute_dir(&intact_dir_only).unwrap();
    assert!(
        compat_root_contains_name_at_fd(&intact_fd, intact_name, &mut |_| {}).unwrap(),
        "intakte vdf autorisiert weiterhin"
    );
    assert!(
        !compat_root_contains_name_at_fd(&intact_fd, "GE-Proton10-25", &mut |_| {}).unwrap(),
        "unbekannter name bleibt false"
    );
    drop(intact_fd);
    let _ = std::fs::remove_dir_all(intact_dir_only);

    let mixed = compat_tools_fixture(
        "compat-broken-and-intact",
        &[("BrokenTool", broken), (intact_dir, intact.as_bytes())],
    );
    std::fs::create_dir_all(mixed.join(unreadable_dir).join("compatibilitytool.vdf")).unwrap();
    let mixed_fd = open_absolute_dir(&mixed).unwrap();
    assert!(
        compat_root_contains_name_at_fd(&mixed_fd, intact_name, &mut |_| {}).unwrap(),
        "intakter ordner muss trotz kaputtem nachbarn gefunden werden"
    );
    let absent = compat_root_contains_name_at_fd(&mixed_fd, "GE-Proton10-25", &mut |_| {});
    assert!(
        absent.is_ok(),
        "fehlender name muss sauber false liefern: {absent:?}"
    );
    assert!(!absent.unwrap());
    drop(mixed_fd);
    let _ = std::fs::remove_dir_all(mixed);
}

#[cfg(target_os = "linux")]
#[test]
fn compat_parsefehler_eines_kandidaten_bricht_die_suche_nicht_ab() {
    let intact_dir = "GE-Proton9-27";
    let intact_name = "GE-Proton11-5-x86_64";
    let intact = tool_vdf(intact_name);
    // UTF-8-gültig, aber syntaktisch defekt (unterminierter string): der
    // parser scheitert, der ordner wird wie ein unlesbarer verlassen. Der
    // angefragte name steht bewusst nicht in dieser datei — aus
    // unparsbarem inhalt wird nie autorisiert (S-1).
    let broken = b"\"compatibilitytools\" { \"compat_tools\" { \"BrokenTool";

    let only_broken = compat_tools_fixture("compat-parse-error-only", &[("BrokenTool", broken)]);
    let broken_fd = open_absolute_dir(&only_broken).unwrap();
    for name in [intact_dir, "BrokenTool", "GE-Proton10-25"] {
        let result = compat_root_contains_name_at_fd(&broken_fd, name, &mut |_| {});
        assert!(
            result.is_ok(),
            "parsefehler darf die autorisierung nicht abbrechen: {result:?}"
        );
        assert!(!result.unwrap(), "defekte vdf autorisiert \"{name}\" nicht");
    }
    drop(broken_fd);
    let _ = std::fs::remove_dir_all(only_broken);

    // Der defekte kandidat wird vor dem intakten angelegt (anlagereihenfolge
    // von fs::read_dir), der intakte muss trotzdem gefunden werden.
    let mixed = compat_tools_fixture(
        "compat-parse-error-then-intact",
        &[("BrokenTool", broken), (intact_dir, intact.as_bytes())],
    );
    let mixed_fd = open_absolute_dir(&mixed).unwrap();
    assert!(
        compat_root_contains_name_at_fd(&mixed_fd, intact_name, &mut |_| {}).unwrap(),
        "intakter ordner muss trotz parsefehler im nachbarordner gefunden werden"
    );
    assert!(
        !compat_root_contains_name_at_fd(&mixed_fd, "GE-Proton10-25", &mut |_| {}).unwrap(),
        "unbekannter name bleibt false"
    );
    drop(mixed_fd);
    let _ = std::fs::remove_dir_all(mixed);
}

#[cfg(target_os = "linux")]
#[test]
fn valve_libraryfolders_descriptor_reader_nutzt_gemeinsamen_parser() {
    let (root, steam) = valve_authority_fixture("libraryfolders-descriptor-reader");
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();
    let libraryfolders = steam.join("config/libraryfolders.vdf");
    std::fs::write(
        &libraryfolders,
        include_str!("../../../tests/fixtures/libraryfolders-parser.vdf"),
    )
    .unwrap();
    let root_fd = open_absolute_dir(&steam).unwrap();

    let libraries = read_library_folders_from_root_fd(&steam, &root_fd, &mut |_| {}).unwrap();
    assert_eq!(
        libraries,
        vec![
            PathBuf::from("/fixture/library-ten"),
            PathBuf::from("/fixture/library-two"),
        ]
    );

    std::fs::write(
        &libraryfolders,
        include_str!("../../../tests/fixtures/libraryfolders-parser-broken.vdf"),
    )
    .unwrap();
    let error = read_library_folders_from_root_fd(&steam, &root_fd, &mut |_| {}).unwrap_err();
    assert!(
        error.starts_with("scan libraryfolders entries:"),
        "error: {error}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn valve_libraryfolders_obergrenze_ist_die_der_discovery() {
    let (root, steam) = valve_authority_fixture("libraryfolders-oversized");
    let config = steam.join("config");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();
    let oversized = config.join("libraryfolders.vdf");
    std::fs::write(
        &oversized,
        vec![b' '; crate::commands::scope::MAX_VDF_READ_BYTES as usize + 1],
    )
    .unwrap();
    let root_fd = open_absolute_dir(&steam).unwrap();

    // Vor der angleichung lag hier ein 1-MiB-cap: eine datei zwischen 1 und
    // 16 MiB liess die autorisierung scheitern, obwohl die Discovery sie
    // vollständig gelesen hatte. Jetzt greift dieselbe grenze.
    let error = read_library_folders_from_root_fd(&steam, &root_fd, &mut |_| {}).unwrap_err();
    assert!(error.contains("size-limit-exceeded"), "error: {error}");

    // entfernte datei (nicht: übergrosse) nutzt weiter den root-fallback.
    std::fs::remove_file(&oversized).unwrap();
    let libraries = read_library_folders_from_root_fd(&steam, &root_fd, &mut |_| {}).unwrap();
    assert_eq!(libraries, vec![steam.clone()]);

    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn valve_libraryfolders_leerer_block_bleibt_leer() {
    let (root, steam) = valve_authority_fixture("libraryfolders-empty");
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();
    std::fs::write(
        steam.join("config/libraryfolders.vdf"),
        include_str!("../../../tests/fixtures/libraryfolders-parser-empty.vdf"),
    )
    .unwrap();
    let root_fd = open_absolute_dir(&steam).unwrap();

    let libraries = read_library_folders_from_root_fd(&steam, &root_fd, &mut |_| {}).unwrap();

    assert!(libraries.is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn valve_libraryfolders_fehlende_vdf_nutzt_steamapps_fallback() {
    let (root, steam) = valve_authority_fixture("libraryfolders-missing");
    std::fs::create_dir_all(steam.join("steamapps")).unwrap();
    let root_fd = open_absolute_dir(&steam).unwrap();

    let libraries = read_library_folders_from_root_fd(&steam, &root_fd, &mut |_| {}).unwrap();

    assert_eq!(libraries, vec![steam.clone()]);
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn valve_authority_missing_local_compat_root_is_false() {
    let (root, steam) = valve_authority_fixture("compat-missing-local-root");
    let compat_root = steam.join("compatibilitytools.d");
    let mut hook = |_| {};
    assert!(
        !compat_root_contains_name_linux_with_hook(&compat_root, "missing", &mut hook).unwrap()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn steam_root_identity_swap_between_capture_and_open_fails_closed() {
    let (root, steam) = valve_authority_fixture("valve-root-open-race");
    let canonical = std::fs::canonicalize(&steam).unwrap();
    let foreign = root.join("foreign-root");
    std::fs::create_dir_all(&foreign).unwrap();
    let mut swapped = false;
    let result = open_bound_root_fd(&canonical, &mut || {
        if !swapped {
            std::fs::rename(&canonical, canonical.with_extension("old")).unwrap();
            std::os::unix::fs::symlink(&foreign, &canonical).unwrap();
            swapped = true;
        }
    });
    assert!(
        result.is_err(),
        "Root-Identity-Swap muss fail-closed bleiben"
    );
    std::fs::remove_file(&canonical).unwrap();
    std::fs::rename(canonical.with_extension("old"), &canonical).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn valve_authority_root_and_libraryfolders_race_use_bound_fds() {
    let (root, steam) = valve_authority_fixture("valve-root-vdf-races");
    let steamapps = steam.join("steamapps");
    std::fs::create_dir_all(&steamapps).unwrap();
    std::fs::write(
        steamapps.join("appmanifest_1493710.acf"),
        "\"AppState\" { \"appid\" \"1493710\" }",
    )
    .unwrap();
    let libraryfolders = "\"libraryfolders\" { \"0\" { \"path\" \"";
    let libraryfolders = format!("{libraryfolders}{}\" }} }}", steam.display());
    let libraryfolders_path = steam.join("config/libraryfolders.vdf");
    std::fs::write(&libraryfolders_path, &libraryfolders).unwrap();

    let root_fd = open_absolute_dir(&steam).unwrap();
    let external = root.join("foreign-steam-root");
    std::fs::create_dir_all(&external).unwrap();
    let mut swapped_root = false;
    let result = valve_builtin_installed_from_fds(&steam, &root_fd, 1493710, &mut |stage| {
        if stage == 1 && !swapped_root {
            std::fs::rename(&steam, steam.with_extension("old")).unwrap();
            std::os::unix::fs::symlink(&external, &steam).unwrap();
            swapped_root = true;
        }
    })
    .unwrap();
    assert!(result, "gebundener Steam-root muss trotz Pfadtausch gelten");
    std::fs::remove_file(&steam).unwrap();
    std::fs::rename(steam.with_extension("old"), &steam).unwrap();

    let mut swapped_vdf = false;
    let foreign_vdf = root.join("foreign-libraryfolders.vdf");
    std::fs::write(&foreign_vdf, "\"libraryfolders\" { \"0\" { unclosed").unwrap();
    let result = valve_builtin_installed_from_fds(&steam, &root_fd, 1493710, &mut |stage| {
        if stage == 2 && !swapped_vdf {
            std::fs::rename(
                &libraryfolders_path,
                libraryfolders_path.with_extension("old"),
            )
            .unwrap();
            std::os::unix::fs::symlink(&foreign_vdf, &libraryfolders_path).unwrap();
            swapped_vdf = true;
        }
    })
    .unwrap();
    assert!(
        result,
        "libraryfolders muss aus dem bereits geöffneten fd kommen"
    );
    std::fs::remove_file(&libraryfolders_path).unwrap();
    std::fs::rename(
        libraryfolders_path.with_extension("old"),
        &libraryfolders_path,
    )
    .unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn valve_authority_external_library_identity_race_fails_closed() {
    let (root, steam) = valve_authority_fixture("valve-external-library-race");
    let external = root.join("library");
    std::fs::create_dir_all(external.join("steamapps")).unwrap();
    std::fs::write(
        external.join("steamapps/appmanifest_1493710.acf"),
        "\"AppState\" { \"appid\" \"1493710\" }",
    )
    .unwrap();
    let libraryfolders_path = steam.join("config/libraryfolders.vdf");
    std::fs::write(
        &libraryfolders_path,
        format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
            external.display()
        ),
    )
    .unwrap();
    let root_fd = open_absolute_dir(&steam).unwrap();
    let foreign = root.join("foreign-library");
    std::fs::create_dir_all(foreign.join("steamapps")).unwrap();
    std::fs::write(
        foreign.join("steamapps/appmanifest_1493710.acf"),
        "\"AppState\" { \"appid\" \"1493710\" }",
    )
    .unwrap();
    let mut swapped = false;
    let result = valve_builtin_installed_from_fds(&steam, &root_fd, 1493710, &mut |stage| {
        if stage == 3 && !swapped {
            std::fs::rename(&external, external.with_extension("old")).unwrap();
            std::os::unix::fs::symlink(&foreign, &external).unwrap();
            swapped = true;
        }
    });
    assert!(
        result.is_err(),
        "fremde externe Library darf nicht autorisieren"
    );
    std::fs::remove_file(&external).unwrap();
    std::fs::rename(external.with_extension("old"), &external).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn valve_authority_nicht_gemountete_library_blockiert_spaetere_nicht() {
    let (root, steam) = valve_authority_fixture("valve-unmounted-library");
    let without_manifest = root.join("library-a");
    std::fs::create_dir_all(without_manifest.join("steamapps")).unwrap();
    // library B ist gelistet, aber nicht gemountet: der fehlende pfad darf
    // die suche nicht abbrechen (INV-2), sonst bliebe library C unsichtbar.
    let missing = root.join("library-b");
    let external = root.join("library-c");
    std::fs::create_dir_all(external.join("steamapps")).unwrap();
    std::fs::write(
        external.join("steamapps/appmanifest_1493710.acf"),
        "\"AppState\" { \"appid\" \"1493710\" }",
    )
    .unwrap();
    let libraryfolders_path = steam.join("config/libraryfolders.vdf");
    std::fs::write(
        &libraryfolders_path,
        format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} \"2\" {{ \"path\" \"{}\" }} }}",
            without_manifest.display(),
            missing.display(),
            external.display()
        ),
    )
    .unwrap();
    let root_fd = open_absolute_dir(&steam).unwrap();

    assert_eq!(
        valve_builtin_installed_from_fds(&steam, &root_fd, 1493710, &mut |_| {}),
        Ok(true),
        "gültiges Manifest in library C muss trotz fehlender library B gefunden werden"
    );
    assert_eq!(
        valve_builtin_installed_from_fds(&steam, &root_fd, 3658110, &mut |_| {}),
        Ok(false),
        "proton in keiner library liefert false statt fehler"
    );
    assert_eq!(
        is_authorized_compat_tool_with_hook(
            &steam,
            Some(&root_fd),
            "proton_experimental",
            &mut |_| {}
        ),
        Ok(true)
    );
    assert_eq!(
        is_authorized_compat_tool_with_hook(&steam, Some(&root_fd), "proton_10", &mut |_| {}),
        Ok(false)
    );

    // Nicht-NotFound beim kanonisieren bleibt hart fail-closed: ein
    // pfadbestandteil, der keine directory ist, wird nicht übersprungen.
    let not_a_dir = root.join("library-blocker");
    std::fs::write(&not_a_dir, b"x").unwrap();
    std::fs::write(
        &libraryfolders_path,
        format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} }}",
            not_a_dir.join("sub").display(),
            external.display()
        ),
    )
    .unwrap();
    let error = valve_builtin_installed_from_fds(&steam, &root_fd, 1493710, &mut |_| {});
    assert!(
        error.is_err(),
        "nicht-NotFound muss die suche fail-closed abbrechen: {error:?}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn valve_authority_manifest_swap_reads_same_fd() {
    let (root, steam) = valve_authority_fixture("valve-manifest-race");
    let steamapps = steam.join("steamapps");
    std::fs::create_dir_all(&steamapps).unwrap();
    let manifest = steamapps.join("appmanifest_1493710.acf");
    std::fs::write(&manifest, "\"AppState\" { \"appid\" \"1493710\" }").unwrap();
    std::fs::write(
        steam.join("config/libraryfolders.vdf"),
        format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
            steam.display()
        ),
    )
    .unwrap();
    let root_fd = open_absolute_dir(&steam).unwrap();
    let mut swapped = false;
    let result = valve_builtin_installed_from_fds(&steam, &root_fd, 1493710, &mut |stage| {
        if stage == 4 && !swapped {
            std::fs::rename(&manifest, manifest.with_extension("old")).unwrap();
            std::fs::write(&manifest, "\"AppState\" { \"appid\" \"1\" }").unwrap();
            swapped = true;
        }
    })
    .unwrap();
    assert!(result, "Manifest muss aus dem gebundenen fd gelesen werden");
    std::fs::remove_file(&manifest).unwrap();
    std::fs::rename(manifest.with_extension("old"), &manifest).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn compat_authority_bleibt_an_root_tooldir_und_vdf_fd_gebunden() {
    let (home, _cache, steam) = wsg_env("compat-fd-races");
    let root = steam.join("compatibilitytools.d");
    let tool = root.join("GE-Proton9-27");
    let external = home.parent().unwrap().join("compat-fd-external");
    std::fs::create_dir_all(external.join("ExternalTool")).unwrap();
    std::fs::write(
        external.join("ExternalTool/compatibilitytool.vdf"),
        "\"compatibilitytools\" { \"compat_tools\" { \"ExternalTool\" {} } }",
    )
    .unwrap();

    let mut root_swapped = false;
    let root_result =
        compat_root_contains_name_linux_with_hook(&root, "ExternalTool", &mut |stage| {
            if stage == 1 && !root_swapped {
                std::fs::rename(&root, root.with_extension("old")).unwrap();
                std::os::unix::fs::symlink(&external, &root).unwrap();
                root_swapped = true;
            }
        })
        .unwrap();
    assert!(
        !root_result,
        "root-swap darf keinen externen namen autorisieren"
    );
    std::fs::remove_file(&root).unwrap();
    std::fs::rename(root.with_extension("old"), &root).unwrap();

    let mut tool_swapped = false;
    let tool_result =
        compat_root_contains_name_linux_with_hook(&root, "ExternalTool", &mut |stage| {
            if stage == 2 && !tool_swapped {
                std::fs::rename(&tool, tool.with_extension("old")).unwrap();
                std::os::unix::fs::symlink(external.join("ExternalTool"), &tool).unwrap();
                tool_swapped = true;
            }
        })
        .unwrap();
    assert!(
        !tool_result,
        "tooldir-swap darf keinen externen namen autorisieren"
    );
    std::fs::remove_file(&tool).unwrap();
    std::fs::rename(tool.with_extension("old"), &tool).unwrap();

    let vdf = tool.join("compatibilitytool.vdf");
    let mut vdf_swapped = false;
    let vdf_result =
        compat_root_contains_name_linux_with_hook(&root, "GE-Proton9-27", &mut |stage| {
            if stage == 3 && !vdf_swapped {
                std::fs::rename(&vdf, vdf.with_extension("old")).unwrap();
                std::fs::write(
                    &vdf,
                    "\"compatibilitytools\" { \"compat_tools\" { \"ExternalTool\" {} } }",
                )
                .unwrap();
                vdf_swapped = true;
            }
        })
        .unwrap();
    assert!(vdf_result, "vdf-swap muss am bereits geöffneten fd bleiben");
    std::fs::remove_file(&vdf).unwrap();
    std::fs::rename(vdf.with_extension("old"), &vdf).unwrap();
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn is_managed_ge_name_validiert_exakte_muster() {
    assert!(is_managed_ge_name("GE-Proton9-27"));
    assert!(is_managed_ge_name("GE-Proton10-25"));
    assert!(is_managed_ge_name("GE-Proton11-4-x86_64"));
    assert!(is_managed_ge_name("GE-Proton11-5-aarch64"));
    assert!(is_managed_ge_name("GE-Proton11-3"));
    assert!(!is_managed_ge_name("Proton"));
    assert!(!is_managed_ge_name("GE-Proton"));
    assert!(!is_managed_ge_name("GE-Proton10"));
    assert!(!is_managed_ge_name("ge-proton9-27"));
    assert!(!is_managed_ge_name("GE-Proton9-27-custom"));
    assert!(!is_managed_ge_name("GE-Proton11-5-arm64"));
    assert!(!is_managed_ge_name("GE-Proton11-4"));
    assert!(!is_managed_ge_name("GE-Proton9-"));
    assert!(!is_managed_ge_name("GE-Proton-27"));
}

#[test]
fn legacy_ge_schwelle_ist_fuer_namensregel_und_release_regel_dieselbe() {
    use crate::commands::ge_install::is_legacy_ge_version;
    // Die Grenze: bis 11-3 ohne architektur-suffix (legacy), ab 11-4 mit.
    // Beide regeln müssen an derselben stelle kippen, sonst akzeptiert das
    // write-gate einen namen, dessen release-asset es nicht autorisiert.
    assert!(is_legacy_ge_version(10, 99));
    assert!(is_legacy_ge_version(11, 3));
    assert!(!is_legacy_ge_version(11, 4));
    assert!(!is_legacy_ge_version(12, 0));

    // namensregel: ohne suffix nur bis 11-3, mit suffix immer ab 11-4
    assert!(is_managed_ge_name("GE-Proton11-3"));
    assert!(!is_managed_ge_name("GE-Proton11-4"));
    assert!(is_managed_ge_name("GE-Proton11-4-x86_64"));
}

#[cfg(all(test, target_os = "linux"))]
mod manifest_reader_tests {
    use super::*;
    use crate::commands::test_util::fixture_dir;

    #[test]
    fn shared_manifest_reader_preserves_library_results_and_errors() {
        let root = fixture_dir("prefix", "manifest-reader");
        let library = open_absolute_dir(&root).unwrap();
        assert_eq!(
            is_app_installed_in_library_fd(library.as_raw_fd(), 620, &mut |_| {}),
            Ok(false)
        );
        fs::create_dir(root.join("steamapps")).unwrap();
        let steamapps = open_dir_at(library.as_raw_fd(), OsStr::new("steamapps")).unwrap();
        for (text, expected) in [
            ("\"AppState\" { \"appid\" \"620\" }", Ok(true)),
            ("\"AppState\" { \"appid\" \"570\" }", Err("blocked")),
            ("\"AppState\" {", Err("unreadable")),
        ] {
            fs::write(root.join("steamapps/appmanifest_620.acf"), text).unwrap();
            let shared = is_app_installed_in_steamapps_fd(steamapps.as_raw_fd(), 620, &mut |_| {});
            assert_eq!(
                shared
                    .as_ref()
                    .map(|value| *value)
                    .map_err(|error| match error {
                        ManifestReadError::Blocked(_) => "blocked",
                        ManifestReadError::Unreadable(_) => "unreadable",
                    }),
                expected
            );
            assert_eq!(
                is_app_installed_in_library_fd(library.as_raw_fd(), 620, &mut |_| {}),
                shared.map_err(ManifestReadError::into_message)
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
