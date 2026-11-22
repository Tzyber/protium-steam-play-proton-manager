/// r-05: die manifest-Lesekette (AppID inkl. „AppId“-Fallback) existiert nur
/// noch einmal im gemeinsamen reader; delete_usage ruft sie nur auf. Der
/// appmanifest-Cap lebt ausschließlich im reader. Produktionsquellen, keine
/// Testtexte (Testmodule sind ausgelagert).
#[test]
fn manifest_lesekette_existiert_nur_einmal() {
    use crate::commands::test_util::production_source;
    let compat = production_source(include_str!("manifest.rs"));
    // die delete-seite ist auf inspektion und nutzungsabfragen verteilt; beide
    // zählen als ein aufrufer.
    let delete_inspect = [
        production_source(include_str!("delete_inspect.rs")),
        production_source(include_str!("delete_usage.rs")),
    ]
    .concat();
    for path in ["[\"AppState\", \"appid\"]", "[\"AppState\", \"AppId\"]"] {
        assert_eq!(
            compat.matches(path).count(),
            1,
            "die appid-kette muss genau einmal im gemeinsamen reader stehen: {path}"
        );
        assert_eq!(
            delete_inspect.matches(path).count(),
            0,
            "delete_inspect darf die appid-kette nicht mehr selbst tragen: {path}"
        );
    }
    assert!(
        !delete_inspect.contains("MAX_DELETE_MANIFEST_BYTES"),
        "der doppelte manifest-cap muss entfallen sein"
    );
    assert!(
        delete_inspect.contains("read_app_manifest_with_hook"),
        "delete_inspect muss den gemeinsamen reader nutzen"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn manifest_appid_fallback_wird_lazy_ausgewertet() {
    use super::*;
    use crate::commands::fd::open_absolute_dir;
    use crate::commands::test_util::{fixture_dir, production_source};
    use std::ffi::OsStr;
    use std::os::fd::AsRawFd;

    let compat = production_source(include_str!("manifest.rs"));
    assert!(
        !compat.contains(".or(vdf_patch::get_vdf_value"),
        "manifest.rs darf AppId-Fallback nicht eager per .or() parsen"
    );

    let dir = fixture_dir("manifest", "lazy-fallback");
    std::fs::write(
        dir.join("appmanifest_440.acf"),
        "\"AppState\"\n{\n  \"appid\" \"440\"\n  \"name\" \"Team Fortress 2\"\n}\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("appmanifest_570.acf"),
        "\"AppState\"\n{\n  \"AppId\" \"570\"\n  \"name\" \"Dota 2\"\n}\n",
    )
    .unwrap();
    let dir_fd = open_absolute_dir(&dir).unwrap();

    let mut hook = |_: ManifestStage, _: Option<&mut std::fs::File>| {};
    let tf2 = read_app_manifest_with_hook(
        dir_fd.as_raw_fd(),
        OsStr::new("appmanifest_440.acf"),
        440,
        &mut hook,
    )
    .unwrap()
    .unwrap();
    assert_eq!(tf2.app_id, 440);
    assert_eq!(tf2.name.as_deref(), Some("Team Fortress 2"));

    let dota = read_app_manifest_with_hook(
        dir_fd.as_raw_fd(),
        OsStr::new("appmanifest_570.acf"),
        570,
        &mut hook,
    )
    .unwrap()
    .unwrap();
    assert_eq!(dota.app_id, 570);
    assert_eq!(dota.name.as_deref(), Some("Dota 2"));

    let _ = std::fs::remove_dir_all(&dir);
}
