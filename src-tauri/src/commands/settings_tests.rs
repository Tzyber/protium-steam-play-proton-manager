use std::fs;
use std::path::Path;

use super::*;
use crate::commands::errcode;
use crate::commands::test_util::fixture_dir;

fn settings_fixture(tag: &str) -> std::path::PathBuf {
    fixture_dir("settings", tag)
}

fn has_tmp_files(dir: &Path) -> bool {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
}

// ---- Fenster-Parse, Format und Clamp ----

#[test]
fn parse_window_size_akzeptiert_gueltige_zeilen() {
    assert_eq!(parse_window_size("1280x800"), Some((1280, 800)));
    assert_eq!(parse_window_size("1440x900\n"), Some((1440, 900)));
    assert_eq!(parse_window_size("  960x600 \r\n"), Some((960, 600)));
}

#[test]
fn parse_window_size_lehnt_null_und_defekte_eingaben_ab() {
    for raw in [
        "",
        "   ",
        "0x0",
        "0x800",
        "1280x0",
        "1280",
        "1280x",
        "x800",
        "abcxdef",
        "-1280x800",
        "+1280x800",
        "1280x+800",
        "1280x800x2",
        "99999999999x800",
        "1280 x 800",
    ] {
        assert_eq!(parse_window_size(raw), None, "raw={raw:?}");
    }
}

#[test]
fn format_window_size_rechnet_in_logische_pixel_um() {
    assert_eq!(format_window_size((1280, 800), 1.0), "1280x800");
    assert_eq!(format_window_size((2560, 1600), 2.0), "1280x800");
    assert_eq!(format_window_size((1920, 1200), 1.5), "1280x800");
    assert_eq!(format_window_size((1280, 800), 1.5), "853x533");
}

#[test]
fn format_window_size_faellt_bei_ungueltigem_scale_auf_eins_zurueck() {
    for scale in [0.0, -1.0, -2.5, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(
            format_window_size((1280, 800), scale),
            "1280x800",
            "scale={scale}"
        );
    }
}

#[test]
fn clamp_window_size_deckelt_und_wahrt_mindestgroesse() {
    assert_eq!(
        clamp_window_size((1280, 800), MIN_WINDOW_SIZE, Some((1920, 1080))),
        (1280, 800)
    );
    assert_eq!(
        clamp_window_size((640, 480), MIN_WINDOW_SIZE, Some((1920, 1080))),
        MIN_WINDOW_SIZE
    );
    assert_eq!(
        clamp_window_size((2560, 1600), MIN_WINDOW_SIZE, Some((1920, 1080))),
        (1920, 1080)
    );
}

#[test]
fn clamp_window_size_ohne_monitor_kein_ober_clamp() {
    assert_eq!(
        clamp_window_size((2560, 1600), MIN_WINDOW_SIZE, None),
        (2560, 1600)
    );
    assert_eq!(
        clamp_window_size((500, 400), MIN_WINDOW_SIZE, None),
        MIN_WINDOW_SIZE
    );
}

#[test]
fn clamp_window_size_monitor_kleiner_als_min_panikt_nicht() {
    // Steam Deck 1280x800 bei 1,5x-Skalierung = 853x533 logisch (< 960x600).
    assert_eq!(
        clamp_window_size((1280, 800), MIN_WINDOW_SIZE, Some((853, 533))),
        MIN_WINDOW_SIZE
    );
    assert_eq!(
        clamp_window_size((400, 300), MIN_WINDOW_SIZE, Some((853, 533))),
        MIN_WINDOW_SIZE
    );
    assert_eq!(
        clamp_window_size((1280, 800), MIN_WINDOW_SIZE, Some((1920, 500))),
        (1280, 600)
    );
}

// ---- Fensterdatei-I/O ----

#[test]
fn window_setting_roundtrip_und_modus_0600() {
    use std::os::unix::fs::PermissionsExt;

    let dir = settings_fixture("window_roundtrip");
    save_window_setting_at(&dir, (2560, 1600), 2.0).unwrap();

    assert_eq!(read_window_setting_at(&dir), (1280, 800));
    let file = dir.join("protium-window");
    let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert!(!has_tmp_files(&dir));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn save_window_setting_bei_null_ist_noop_ohne_ueberschreiben() {
    let dir = settings_fixture("window_zero_noop");
    save_window_setting_at(&dir, (1440, 900), 1.0).unwrap();

    for zero in [(0, 0), (0, 800), (1280, 0)] {
        save_window_setting_at(&dir, zero, 1.0).unwrap();
        assert_eq!(read_window_setting_at(&dir), (1440, 900), "zero={zero:?}");
    }

    let empty_dir = settings_fixture("window_zero_no_create");
    save_window_setting_at(&empty_dir, (0, 0), 1.0).unwrap();
    assert!(!empty_dir.join("protium-window").exists());

    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&empty_dir);
}

#[test]
fn read_window_setting_negativfaelle_liefern_default() {
    let dir = settings_fixture("window_negatives");

    // Fehlende Datei
    assert_eq!(read_window_setting_at(&dir), DEFAULT_WINDOW_SIZE);

    // Fehlendes Verzeichnis
    assert_eq!(
        read_window_setting_at(&dir.join("does-not-exist")),
        DEFAULT_WINDOW_SIZE
    );

    // Defekte / leere / 0x0 Inhalte -> Default (1280, 800), kein Clamp auf (960, 600)
    let file = dir.join("protium-window");
    for content in ["", "garbage", "0x0", "0x800", "1280x0", "1280"] {
        fs::write(&file, content).unwrap();
        assert_eq!(
            read_window_setting_at(&dir),
            DEFAULT_WINDOW_SIZE,
            "content={content:?}"
        );
    }

    // Ueber 64 Byte Cap
    fs::write(&file, format!("1440x900{}", " ".repeat(65))).unwrap();
    assert_eq!(read_window_setting_at(&dir), DEFAULT_WINDOW_SIZE);

    // Symlink statt regulaerer Datei
    let target = dir.join("real-window");
    fs::write(&target, "1440x900").unwrap();
    fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(&target, &file).unwrap();
    assert_eq!(read_window_setting_at(&dir), DEFAULT_WINDOW_SIZE);

    // Nicht-regulaerer Eintrag (Verzeichnis)
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    assert_eq!(read_window_setting_at(&dir), DEFAULT_WINDOW_SIZE);

    let _ = fs::remove_dir_all(&dir);
}

// ---- App-Settings-I/O ----

#[test]
fn load_settings_fehlende_datei_liefert_none() {
    let dir = settings_fixture("settings_missing");
    assert_eq!(load_settings_at(&dir).unwrap(), None);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn settings_roundtrip_modus_0600_und_ueberschreiben() {
    use std::os::unix::fs::PermissionsExt;

    let dir = settings_fixture("settings_roundtrip");
    let first = r#"{"language":"de","view":"library","sortKey":"name","sortDir":"asc"}"#;
    let second = r#"{"language":"en","view":"proton","sortKey":"size","sortDir":"desc"}"#;

    save_settings_at(&dir, first).unwrap();
    assert_eq!(load_settings_at(&dir).unwrap().as_deref(), Some(first));
    let file = dir.join("ui-settings.json");
    let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert!(!has_tmp_files(&dir));

    save_settings_at(&dir, second).unwrap();
    assert_eq!(load_settings_at(&dir).unwrap().as_deref(), Some(second));
    assert!(!has_tmp_files(&dir));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn save_settings_prueft_16kib_grenze_mit_size_limit() {
    let dir = settings_fixture("settings_save_cap");
    let at_limit = "a".repeat(16 * 1024);
    save_settings_at(&dir, &at_limit).unwrap();
    assert_eq!(
        load_settings_at(&dir).unwrap().as_deref(),
        Some(at_limit.as_str())
    );

    let over_limit = "b".repeat(16 * 1024 + 1);
    let error = save_settings_at(&dir, &over_limit).unwrap_err();
    assert!(errcode::has_code(&error, errcode::SIZE_LIMIT), "{error}");
    // Bestehender Inhalt bleibt unangetastet.
    assert_eq!(
        load_settings_at(&dir).unwrap().as_deref(),
        Some(at_limit.as_str())
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn load_settings_lehnt_datei_ueber_16kib_mit_size_limit_ab() {
    let dir = settings_fixture("settings_load_cap");
    fs::write(dir.join("ui-settings.json"), "x".repeat(16 * 1024 + 1)).unwrap();

    let error = load_settings_at(&dir).unwrap_err();
    assert!(errcode::has_code(&error, errcode::SIZE_LIMIT), "{error}");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn load_settings_lehnt_symlink_ab_und_save_ersetzt_ohne_zu_folgen() {
    use std::os::unix::fs::PermissionsExt;

    let dir = settings_fixture("settings_symlink");
    let target = dir.join("outside.json");
    fs::write(&target, r#"{"language":"en"}"#).unwrap();
    let link = dir.join("ui-settings.json");
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let error = load_settings_at(&dir).unwrap_err();
    assert!(errcode::has_code(&error, errcode::UNREADABLE), "{error}");

    // Save ersetzt den Symlink per rename_at, ohne dem Ziel zu folgen.
    let saved = r#"{"language":"de"}"#;
    save_settings_at(&dir, saved).unwrap();
    assert!(!fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::metadata(&link).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"language":"en"}"#);
    assert_eq!(load_settings_at(&dir).unwrap().as_deref(), Some(saved));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn load_settings_lehnt_ungueltiges_utf8_und_verzeichnis_ab() {
    let dir = settings_fixture("settings_invalid_entries");
    let file = dir.join("ui-settings.json");

    fs::write(&file, [0xff, 0xfe, 0xfd]).unwrap();
    let utf8_err = load_settings_at(&dir).unwrap_err();
    assert!(
        errcode::has_code(&utf8_err, errcode::UNREADABLE),
        "{utf8_err}"
    );

    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    let dir_err = load_settings_at(&dir).unwrap_err();
    assert!(
        errcode::has_code(&dir_err, errcode::NOT_A_DIRECTORY),
        "{dir_err}"
    );

    // Rename gegen ein bestehendes Verzeichnis schlaegt fehl und raeumt die Temp-Datei auf.
    let rename_err = save_settings_at(&dir, r#"{"language":"de"}"#).unwrap_err();
    assert!(
        errcode::has_code(&rename_err, errcode::UNREADABLE),
        "{rename_err}"
    );
    assert!(!has_tmp_files(&dir));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn save_window_setting_ersetzt_symlink_ohne_zu_folgen() {
    use std::os::unix::fs::PermissionsExt;

    let dir = settings_fixture("window_symlink_replace");
    let target = dir.join("outside-window");
    fs::write(&target, "1024x768").unwrap();
    let link = dir.join("protium-window");
    std::os::unix::fs::symlink(&target, &link).unwrap();

    save_window_setting_at(&dir, (1440, 900), 1.0).unwrap();
    assert!(!fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::metadata(&link).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "1024x768");
    assert_eq!(read_window_setting_at(&dir), (1440, 900));

    let _ = fs::remove_dir_all(&dir);
}
