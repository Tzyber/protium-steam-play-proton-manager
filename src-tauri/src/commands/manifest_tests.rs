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
