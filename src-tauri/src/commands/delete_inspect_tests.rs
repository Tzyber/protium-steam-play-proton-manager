use super::*;
use crate::commands::manifest::MAX_MANIFEST_BYTES;
use crate::commands::shortcuts_bin::make_test_bin_shortcuts;
use crate::commands::test_util::{wire_unit_variant, wsg_fixture, WireSerializer, WireValue};
use serde::ser::Serialize;

/// Ein Feld der Wire-Form einer Struktur; `None` heißt: nicht serialisiert.
fn wire_field<T: Serialize>(value: &T, key: &str) -> Option<WireValue> {
    match value.serialize(WireSerializer).unwrap() {
        WireValue::Object(fields) => fields
            .into_iter()
            .find(|(field, _)| field == key)
            .map(|(_, value)| value),
        other => panic!("keine struktur: {other:?}"),
    }
}

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
        DeleteTargetType::Trash,
        target.to_str().unwrap(),
        &|path| path.starts_with(&steam_owned),
    )
    .unwrap_err();
    assert!(error.contains("blocked-location"), "error: {error}");

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
        DeleteTargetType::Orphan,
        orphan_dir.to_str().unwrap(),
        &|_| true,
    )
    .unwrap();
    assert_eq!(inspection.target_type, DeleteTargetType::Orphan);
    assert_eq!(inspection.consequences.len(), 1);
    assert_eq!(inspection.consequences[0].action, DeleteAction::Trash);
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
        DeleteTargetType::Orphan,
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
        DeleteTargetType::Orphan,
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
        DeleteTargetType::CompatTool,
        tool.to_str().unwrap(),
        &|_| true,
    )
    .unwrap();
    assert_eq!(tool_inspection.target_type, DeleteTargetType::CompatTool);
    assert_eq!(
        tool_inspection.consequences[0].action,
        DeleteAction::PermanentDelete
    );

    // 5. Nicht-GE Tool -> Err
    let custom_tool = tools_dir.join("Proton-Custom");
    std::fs::create_dir_all(&custom_tool).unwrap();
    assert!(inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::CompatTool,
        custom_tool.to_str().unwrap(),
        &|_| true,
    )
    .is_err());

    let _ = std::fs::remove_dir_all(&root);
}

/// INV-6: die folgen eines GE-tools nennen auch den globalen standard
/// (mapping `"0"`) und gleichen über den internen namen der tool-vdf ab.
#[test]
fn compat_tool_folgen_nennen_globalen_standard_und_internen_namen() {
    let root = wsg_fixture("inspect-tool-internal");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let tool = steam.join("compatibilitytools.d/GE-Proton11-4-x86_64");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&tool).unwrap();
    std::fs::write(
        tool.join("compatibilitytool.vdf"),
        "\"compatibilitytools\"\n{\n\t\"compat_tools\"\n\t{\n\t\t\"GE-Proton11-4\"\n\t\t{\n\t\t\t\"display_name\"\t\"GE-Proton11-4\"\n\t\t}\n\t}\n}\n",
    )
    .unwrap();
    std::fs::write(
        config_dir.join("config.vdf"),
        "\"InstallConfigStore\"\n{\n\t\"Software\"\n\t{\n\t\t\"Valve\"\n\t\t{\n\t\t\t\"Steam\"\n\t\t\t{\n\t\t\t\t\"CompatToolMapping\"\n\t\t\t\t{\n\t\t\t\t\t\"0\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"name\"\t\"GE-Proton11-4\"\n\t\t\t\t\t}\n\t\t\t\t\t\"620\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"name\"\t\"GE-Proton11-4\"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n",
    )
    .unwrap();

    let inspection = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::CompatTool,
        tool.to_str().unwrap(),
        &|_| true,
    )
    .unwrap();
    let consequence = &inspection.consequences[0];
    assert_eq!(consequence.affected_app_ids, Some(vec![620]));
    assert_eq!(consequence.affects_global_default, Some(true));
    assert!(!consequence.impact_unknown);

    // FR-8-Pin: eine fehlende tool-vdf ist belegte abwesenheit, kein
    // lesefehler; die folge bleibt bekannt.
    std::fs::remove_file(tool.join("compatibilitytool.vdf")).unwrap();
    let without_vdf = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::CompatTool,
        tool.to_str().unwrap(),
        &|_| true,
    )
    .unwrap();
    assert_eq!(without_vdf.consequences[0].affected_app_ids, None);
    assert_eq!(without_vdf.consequences[0].affects_global_default, None);
    assert!(!without_vdf.consequences[0].impact_unknown);

    let _ = std::fs::remove_dir_all(&root);
}

/// FR-8: ein nicht lesbares tool-vdf ist keine belegte abwesenheit. Der
/// Ordner-name zählt weiter (die suche läuft), die folge nennt die app-liste
/// aber unbekannt statt leer.
#[test]
fn compat_tool_vdf_als_verzeichnis_laesst_die_appliste_unbekannt() {
    let root = wsg_fixture("inspect-tool-vdf-unreadable");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let tool = steam.join("compatibilitytools.d/GE-Proton11-4-x86_64");
    std::fs::create_dir_all(&config_dir).unwrap();
    // der vdf-name ist ein verzeichnis: das open gelingt, `ensure_regular_fd`
    // liefert not-a-directory.
    std::fs::create_dir_all(tool.join("compatibilitytool.vdf")).unwrap();
    // gemappt ist der ORDNERNAME: er belegt, dass die suche trotz des
    // vdf-fehlers gelaufen ist.
    std::fs::write(
        config_dir.join("config.vdf"),
        "\"InstallConfigStore\"\n{\n\t\"Software\"\n\t{\n\t\t\"Valve\"\n\t\t{\n\t\t\t\"Steam\"\n\t\t\t{\n\t\t\t\t\"CompatToolMapping\"\n\t\t\t\t{\n\t\t\t\t\t\"620\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"name\"\t\"GE-Proton11-4-x86_64\"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n",
    )
    .unwrap();

    let canonical_root = std::fs::canonicalize(&steam).unwrap();
    let root_fd = crate::commands::fd::open_bound_root_fd(&canonical_root, &mut || {}).unwrap();
    let error = crate::commands::compat_auth::read_compat_tool_internal_name(
        &root_fd,
        "GE-Proton11-4-x86_64",
    )
    .unwrap_err();
    assert!(
        errcode::has_code(&error, errcode::NOT_A_DIRECTORY),
        "{error}"
    );

    let inspection = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::CompatTool,
        tool.to_str().unwrap(),
        &|_| true,
    )
    .unwrap();
    let consequence = &inspection.consequences[0];
    assert!(consequence.impact_unknown);
    assert_eq!(consequence.affected_app_ids, Some(vec![620]));

    let _ = std::fs::remove_dir_all(&root);
}

/// FR-8: `impactUnknown` ist pflichtfeld der wire-form und wird auch als
/// `false` serialisiert. Der serializer bildet bool auf Number(1/0) ab;
/// gepinnt werden präsenz und wert, nicht der JSON-typ.
#[test]
fn consequence_serialisiert_impact_unknown_immer() {
    let mut consequence = DeleteConsequence {
        path: "/lib/steamapps/compatdata/620".to_string(),
        action: DeleteAction::PermanentDelete,
        description: "beschreibung".to_string(),
        affected_app_ids: None,
        affects_global_default: None,
        impact_unknown: false,
    };
    assert_eq!(
        wire_field(&consequence, "impactUnknown"),
        Some(WireValue::Number(0))
    );
    consequence.impact_unknown = true;
    assert_eq!(
        wire_field(&consequence, "impactUnknown"),
        Some(WireValue::Number(1))
    );
}

/// FR-1/FR-2: die wire-namen bleiben die bisherigen strings und kommen aus
/// dem serde-Rename (`camelCase`), nicht aus einem `as_str`. Beide `Trash`-
/// varianten (zielart und aktion) werden getrennt geprüft.
#[test]
fn delete_enums_tragen_die_bisherigen_wire_namen() {
    for (value, wire) in [
        (DeleteTargetType::Orphan, "orphan"),
        (DeleteTargetType::Trash, "trash"),
        (DeleteTargetType::CompatTool, "compatTool"),
        (DeleteTargetType::ExtractLeftover, "extractLeftover"),
    ] {
        assert_eq!(
            wire_unit_variant(value.serialize(WireSerializer).unwrap()),
            Some(wire.to_string()),
            "targetType fuer {value:?}"
        );
    }
    for (value, wire) in [
        (DeleteAction::Trash, "trash"),
        (DeleteAction::PermanentDelete, "permanentDelete"),
    ] {
        let consequence = DeleteConsequence {
            path: "/lib/steamapps/compatdata/620".to_string(),
            action: value,
            description: "beschreibung".to_string(),
            affected_app_ids: None,
            affects_global_default: None,
            impact_unknown: false,
        };
        let action = wire_field(&consequence, "action").expect("action muss serialisiert werden");
        assert_eq!(
            wire_unit_variant(action),
            Some(wire.to_string()),
            "action fuer {value:?}"
        );
    }
}

/// FR-1: der pfad-suffix traegt weiterhin seinen code; nur das wire-feld
/// `targetType` kennt einen fremden wert nicht mehr (tauri `InvalidArgs`).
#[test]
fn fremder_pfad_suffix_traegt_unsupported_target() {
    let root = wsg_fixture("inspect-unsupported-suffix");
    let steam = root.join("steam");
    let target = steam.join("steamapps/foo/123");
    std::fs::create_dir_all(&target).unwrap();

    let error = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::Orphan,
        target.to_str().unwrap(),
        &|_| true,
    )
    .unwrap_err();
    assert!(
        errcode::has_code(&error, errcode::UNSUPPORTED_TARGET),
        "{error}"
    );

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
        DeleteTargetType::Trash,
        target.to_str().unwrap(),
        &|p| p == steam_root_path,
    );
    let err = result.unwrap_err();
    assert!(err.contains("blocked-location"), "err: {err}");

    // kontrast: scope der das target einschliesst → ok
    let steam_owned = steam.clone();
    let ok = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::Trash,
        target.to_str().unwrap(),
        &|p| p.starts_with(&steam_owned),
    )
    .unwrap();
    assert_eq!(ok.target_type, DeleteTargetType::Trash);

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
            DeleteTargetType::Trash,
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

/// Ein leerer timestamp (`compatdata_123_`) ist nicht-numerisch, nicht
/// "ausserhalb des bereichs": der code ist `unreadable`, und das detail bleibt
/// als stabiler text gepinnt.
#[test]
fn leerer_trash_timestamp_traegt_unreadable_mit_stabilem_detail() {
    let root = wsg_fixture("trash-target-empty-timestamp");
    let dir = root.join("ziel");
    std::fs::create_dir_all(&dir).unwrap();
    let meta = std::fs::symlink_metadata(&dir).unwrap();

    let error =
        validate_trash_target("/lib/steamapps/.protium-trash/compatdata_123_", &meta).unwrap_err();
    assert_eq!(
        error,
        "unreadable: trash target has non-numeric timestamp: "
    );

    let _ = std::fs::remove_dir_all(root);
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
        DeleteTargetType::Orphan,
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

/// F-04: eine fremde datei `appmanifest_<nichtnumerisch>.acf` ist ein
/// dateisystem-formfehler und wird als `unreadable` gemeldet, nicht als
/// gepatchter `invalid-value` (die oberflaeche zeigte sonst "unzulaessige
/// zeichen" fuer eine fremde library-datei).
#[test]
fn orphan_inspektion_meldet_fremden_manifestnamen_als_unreadable() {
    let root = wsg_fixture("inspect-invalid-manifest-name");
    let steam = root.join("steam");
    let steamapps = steam.join("steamapps");
    let target = steamapps.join("compatdata/999999");
    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(
        steam.join("config/libraryfolders.vdf"),
        format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
            steam.display()
        ),
    )
    .unwrap();
    std::fs::write(steamapps.join("appmanifest_alt.acf"), "nonsense").unwrap();

    let error = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::Orphan,
        target.to_str().unwrap(),
        &|_| true,
    )
    .unwrap_err();

    assert!(errcode::has_code(&error, errcode::UNREADABLE), "{error}");
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
        DeleteTargetType::Orphan,
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
        DeleteTargetType::Orphan,
        target.to_str().unwrap(),
        &all_in_scope,
    )
    .unwrap();
    assert_eq!(inspection.target_type, DeleteTargetType::Orphan);
    assert_eq!(inspection.consequences.len(), 1);

    let _ = std::fs::remove_dir_all(root);
}

/// Producer 6 (A-04): die live-ablehnungen von `validate_trash_target` trugen
/// rohtext und erschienen in der oberfläche als „unbekannt". Jeder zweig trägt
/// jetzt seinen code; die symlink-ablehnung ist über den öffentlichen aufrufer
/// nicht erreichbar (dort greift schon `canonicalize_no_symlink`) und wird
/// deshalb direkt geprüft.
#[test]
fn trash_ziel_ablehnungen_tragen_ihren_code() {
    let root = wsg_fixture("trash-target-codes");
    let dir = root.join("ziel");
    std::fs::create_dir_all(&dir).unwrap();
    let meta = std::fs::symlink_metadata(&dir).unwrap();
    let base = "/lib/steamapps/.protium-trash/";

    // gültiger fall bleibt gültig
    assert!(validate_trash_target(&format!("{base}compatdata_570_100"), &meta).is_ok());

    let cases = [
        (
            "/lib/steamapps/compatdata/570".to_string(),
            errcode::NOT_AN_ORPHAN,
        ),
        (format!("{base}a/b"), errcode::NOT_AN_ORPHAN),
        (format!("{base}compatdata_570"), errcode::INVALID_ID),
        (format!("{base}compatdata_570_100_x"), errcode::INVALID_ID),
        // F-02: das artefakt ist der dateiname; nicht-numerisch und überlauf
        // tragen dieselbe klasse wie die appId-formfehler (`unreadable`), nur
        // der wert 0 bleibt die bewusste wert-ablehnung.
        (format!("{base}compatdata_570_abc"), errcode::UNREADABLE),
        (
            format!("{base}compatdata_570_99999999999999999999"),
            errcode::UNREADABLE,
        ),
        (format!("{base}compatdata_570_0"), errcode::INVALID_VALUE),
    ];
    for (path, code) in &cases {
        let error = validate_trash_target(path, &meta).unwrap_err();
        assert!(
            errcode::has_code(&error, code),
            "{path}: unerwarteter fehler: {error}"
        );
    }

    // ein verzeichnis, das als symlink vorliegt (die funktion prüft die
    // metadaten des ziels, nicht den aufgelösten pfad)
    let link = root.join("verweis");
    std::os::unix::fs::symlink(&dir, &link).unwrap();
    let link_meta = std::fs::symlink_metadata(&link).unwrap();
    let error =
        validate_trash_target(&format!("{base}compatdata_570_100"), &link_meta).unwrap_err();
    assert!(
        errcode::has_code(&error, errcode::SYMLINK_REJECTED),
        "unerwarteter fehler: {error}"
    );

    // eine datei ist kein papierkorb-eintrag
    let file = root.join("datei");
    std::fs::write(&file, b"x").unwrap();
    let file_meta = std::fs::symlink_metadata(&file).unwrap();
    assert_eq!(
        validate_trash_target(&format!("{base}compatdata_570_100"), &file_meta).unwrap_err(),
        errcode::NOT_A_DIRECTORY
    );

    let _ = std::fs::remove_dir_all(root);
}

/// S-07: Trash-Ziele muessen direkt in `.protium-trash` einer aktuell
/// gelisteten Steam-Library liegen; defekte gelistete Libraries (ausser
/// `path-missing`) sperren fail-closed.
#[test]
fn trash_inspektion_prueft_gelistete_libraries_und_defekte_libraries_fail_closed() {
    let root = wsg_fixture("inspect-trash-listed-libraries");
    let steam = root.join("steam");
    let missing = root.join("library-missing");
    let unlisted = root.join("library-unlisted");
    let broken = root.join("library-broken");

    let listed_trash = steam.join("steamapps/.protium-trash");
    let listed_entry = listed_trash.join("compatdata_620_100");
    let non_numeric_entry = listed_trash.join("compatdata_abc_100");
    let missing_entry = listed_trash.join("compatdata_620_999");
    let unlisted_entry = unlisted.join("steamapps/.protium-trash/compatdata_620_200");
    let nested_under_root = steam.join("sub/steamapps/.protium-trash/compatdata_620_300");

    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::create_dir_all(&listed_entry).unwrap();
    std::fs::create_dir_all(&non_numeric_entry).unwrap();
    std::fs::create_dir_all(&unlisted_entry).unwrap();
    std::fs::create_dir_all(&nested_under_root).unwrap();
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(broken.join("steamapps"), b"").unwrap();

    #[cfg(unix)]
    let symlink_entry = {
        let link = listed_trash.join("compatdata_620_400");
        std::os::unix::fs::symlink(&listed_entry, &link).unwrap();
        link
    };

    let write_lf = |extra: Option<&Path>| {
        let mut entries = format!(
            "\"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }}",
            steam.display(),
            missing.display()
        );
        if let Some(extra_lib) = extra {
            entries.push_str(&format!(
                " \"2\" {{ \"path\" \"{}\" }}",
                extra_lib.display()
            ));
        }
        std::fs::write(
            steam.join("config/libraryfolders.vdf"),
            format!("\"libraryfolders\" {{ {entries} }}"),
        )
        .unwrap();
    };
    let all_in_scope = |_: &Path| true;

    // 1. Gelistete Library + abwesende Nachbar-Library (`path-missing`) -> Ok
    write_lf(None);
    let ok = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::Trash,
        listed_entry.to_str().unwrap(),
        &all_in_scope,
    )
    .unwrap();
    assert_eq!(ok.target_type, DeleteTargetType::Trash);

    // 2. Nicht-numerisch, Symlink, fehlender Ordner bleiben mit kanonischem Code abgelehnt
    let non_num_err = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::Trash,
        non_numeric_entry.to_str().unwrap(),
        &all_in_scope,
    )
    .unwrap_err();
    assert!(
        errcode::has_code(&non_num_err, errcode::UNREADABLE),
        "{non_num_err}"
    );
    let missing_err = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::Trash,
        missing_entry.to_str().unwrap(),
        &all_in_scope,
    )
    .unwrap_err();
    assert!(
        errcode::has_code(&missing_err, errcode::NOT_FOUND),
        "{missing_err}"
    );
    #[cfg(unix)]
    {
        let symlink_err = inspect_deletion_target(
            steam.to_str().unwrap(),
            DeleteTargetType::Trash,
            symlink_entry.to_str().unwrap(),
            &all_in_scope,
        )
        .unwrap_err();
        assert!(
            errcode::has_code(&symlink_err, errcode::SYMLINK_REJECTED),
            "{symlink_err}"
        );
    }

    // 3. Ungelistete Library (sowohl Geschwisterpfad als auch Unterbaum unter Steam-Root) -> library-not-listed
    for target in [&unlisted_entry, &nested_under_root] {
        let error = inspect_deletion_target(
            steam.to_str().unwrap(),
            DeleteTargetType::Trash,
            target.to_str().unwrap(),
            &all_in_scope,
        )
        .unwrap_err();
        assert!(
            errcode::has_code(&error, errcode::LIBRARY_NOT_LISTED),
            "{}: {error}",
            target.display()
        );
    }

    // 4. Defekte gelistete Library (`ScopeFailed` durch Datei statt steamapps-Ordner) -> fail-closed unavailable
    write_lf(Some(&broken));
    let broken_err = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::Trash,
        listed_entry.to_str().unwrap(),
        &all_in_scope,
    )
    .unwrap_err();
    assert!(
        errcode::has_code(&broken_err, errcode::UNAVAILABLE),
        "{broken_err}"
    );
    assert!(
        broken_err.contains(broken.to_string_lossy().as_ref()),
        "{broken_err}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn inspect_extract_leftover_prueft_muster_ort_symlink_und_aktiven_install() {
    let root = wsg_fixture("inspect-extract-leftover");
    let steam = root.join("steam");
    let tools = steam.join("compatibilitytools.d");
    let valid = tools.join(format!("{}999999-abc123", steam_layout::EXTRACT_PREFIX));
    let real_suffix = tools.join(format!(
        "{}999999-{}",
        steam_layout::EXTRACT_PREFIX,
        crate::commands::path::random_suffix()
    ));
    let invalid_name = tools.join("GE-Proton9-27");
    let bad_pid = tools.join(format!("{}0-abc", steam_layout::EXTRACT_PREFIX));
    let bad_hyphen = tools.join(format!("{}999999-abc--def", steam_layout::EXTRACT_PREFIX));
    let outside = steam.join(format!("{}999999-abc123", steam_layout::EXTRACT_PREFIX));
    std::fs::create_dir_all(&valid).unwrap();
    std::fs::create_dir_all(&real_suffix).unwrap();
    std::fs::create_dir_all(&invalid_name).unwrap();
    std::fs::create_dir_all(&bad_pid).unwrap();
    std::fs::create_dir_all(&bad_hyphen).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let scope = |path: &Path| path.starts_with(&steam);

    for good in [&valid, &real_suffix] {
        let inspection = inspect_deletion_target(
            steam.to_str().unwrap(),
            DeleteTargetType::ExtractLeftover,
            good.to_str().unwrap(),
            &scope,
        )
        .unwrap();
        assert_eq!(inspection.consequences.len(), 1);
        assert_eq!(
            inspection.consequences[0].action,
            DeleteAction::PermanentDelete
        );
    }

    for bad in [&invalid_name, &bad_pid, &bad_hyphen] {
        let err = inspect_deletion_target(
            steam.to_str().unwrap(),
            DeleteTargetType::ExtractLeftover,
            bad.to_str().unwrap(),
            &scope,
        )
        .unwrap_err();
        assert!(errcode::has_code(&err, errcode::BLOCKED), "{bad:?}: {err}");
    }

    let loc_err = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::ExtractLeftover,
        outside.to_str().unwrap(),
        &scope,
    )
    .unwrap_err();
    assert!(
        errcode::has_code(&loc_err, errcode::BLOCKED_LOCATION),
        "{loc_err}"
    );

    #[cfg(unix)]
    {
        let link = tools.join(format!("{}999999-link1", steam_layout::EXTRACT_PREFIX));
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let sym_err = inspect_deletion_target(
            steam.to_str().unwrap(),
            DeleteTargetType::ExtractLeftover,
            link.to_str().unwrap(),
            &scope,
        )
        .unwrap_err();
        assert!(
            errcode::has_code(&sym_err, errcode::SYMLINK_REJECTED),
            "{sym_err}"
        );
    }

    let own_leftover = tools.join(format!(
        "{}{}-active1",
        steam_layout::EXTRACT_PREFIX,
        std::process::id()
    ));
    std::fs::create_dir_all(&own_leftover).unwrap();
    let _active = crate::commands::ge_install::enter_active_ge_install_for_test();
    let active_err = inspect_deletion_target(
        steam.to_str().unwrap(),
        DeleteTargetType::ExtractLeftover,
        own_leftover.to_str().unwrap(),
        &scope,
    )
    .unwrap_err();
    assert!(
        errcode::has_code(&active_err, errcode::BLOCKED),
        "{active_err}"
    );

    let _ = std::fs::remove_dir_all(root);
}
