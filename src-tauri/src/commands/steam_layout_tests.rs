// Quelltext-Pins und Paritätstests für das Pfad-Layout (FR-1..FR-4).

/// Die zwölf Produktionsdateien, die das Steam-Layout nicht mehr selbst joinen.
const PRODUCTION_FILES: [(&str, &str); 12] = [
    ("steam.rs", include_str!("steam.rs")),
    ("cleanup.rs", include_str!("cleanup.rs")),
    ("prefix.rs", include_str!("prefix.rs")),
    ("scope.rs", include_str!("scope.rs")),
    ("discovery.rs", include_str!("discovery.rs")),
    ("compat_auth.rs", include_str!("compat_auth.rs")),
    ("ge_install.rs", include_str!("ge_install.rs")),
    ("delete_inspect.rs", include_str!("delete_inspect.rs")),
    ("write_gate.rs", include_str!("write_gate.rs")),
    ("libraryfolders.rs", include_str!("libraryfolders.rs")),
    ("fs_ops.rs", include_str!("fs_ops.rs")),
    ("delete_usage.rs", include_str!("delete_usage.rs")),
];

/// Pfad-Joins, die das Layout-Modul trägt (Positiv-Kontrolle des Pins).
const LAYOUT_JOINS: [&str; 7] = [
    "join(\"steamapps\")",
    "join(\"compatibilitytools.d\")",
    "join(\"config.vdf\")",
    "join(\"localconfig.vdf\")",
    "join(\"libraryfolders.vdf\")",
    "join(\"userdata\")",
    "join(\"config\")",
];

/// Pfad-Joins, die in keiner der zwölf Produktionsdateien stehen dürfen. Für
/// `compatdata`/`shadercache` gibt es im Scope keinen Produktions-Join: beide
/// laufen über die gebundene fd-Kette (`prefix.rs`, `compat_auth.rs`,
/// `delete_usage.rs`), die ihre Bausteine als `OsStr` an `openat` gibt. Der Pin
/// steht trotzdem, damit ein späterer Join dort nicht unbemerkt entsteht.
const FORBIDDEN_JOINS: [&str; 9] = [
    "join(\"steamapps\")",
    "join(\"compatibilitytools.d\")",
    "join(\"compatdata\")",
    "join(\"shadercache\")",
    "join(\"config.vdf\")",
    "join(\"localconfig.vdf\")",
    "join(\"libraryfolders.vdf\")",
    "join(\"userdata\")",
    "join(\"config\")",
];

/// Zusammengesetzte Relativ-Literale, die im Layout als Joins stehen.
const LAYOUT_RELATIVE_LITERALS: [&str; 2] = [
    "\"config/libraryfolders.vdf\"",
    "\"steamapps/libraryfolders.vdf\"",
];

fn production(name: &str) -> &'static str {
    let source = PRODUCTION_FILES
        .iter()
        .find(|(file, _)| *file == name)
        .unwrap_or_else(|| panic!("datei fehlt: {name}"))
        .1;
    crate::commands::test_util::production_source(source)
}

/// FR-2: die Pfad-Joins der zwölf Produktionsdateien stehen nur noch in
/// `steam_layout.rs`. Der Positiv-Teil hält fest, dass das Layout-Modul die
/// Literale wirklich trägt; ohne ihn wäre der Pin still grün, wenn ein Join
/// ersatzlos verschwindet.
#[test]
fn pfad_joins_liegen_nur_im_layout_modul() {
    let layout = include_str!("steam_layout.rs");
    for join in LAYOUT_JOINS {
        assert!(
            layout.contains(join),
            "das layout-modul trägt den join nicht: {join}"
        );
    }
    assert!(
        layout.contains("fn libraryfolders_vdf")
            && layout.contains("fn steamapps_libraryfolders_vdf"),
        "beide libraryfolders-ablagen gehören ins layout-modul"
    );

    for (name, _) in PRODUCTION_FILES {
        let source = production(name);
        for join in FORBIDDEN_JOINS {
            assert!(!source.contains(join), "{name} joint selbst: {join}");
        }
        for literal in LAYOUT_RELATIVE_LITERALS {
            assert!(
                !source.contains(literal),
                "{name} trägt ein relatives pfad-literal: {literal}"
            );
        }
    }
}

/// P16/FR-2: die Discovery joint die Root-Kandidaten relativ unter `home` und
/// holt `steamapps` aus dem Layout. Der Test ist der Rot-Beleg für die Aufnahme
/// in `PRODUCTION_FILES`: ohne den Eintrag panikt `production` mit „datei
/// fehlt: discovery.rs"; danach laufen die Verbots-Pins oben auch über die
/// Discovery, und dieser Positiv-Teil hält ihre zwei Joins fest.
#[test]
fn discovery_gehoert_zu_den_gepinnten_produktionsdateien() {
    let discovery = production("discovery.rs");
    assert!(
        discovery.contains("steam_layout::steamapps("),
        "die discovery holt steamapps aus dem layout"
    );
    assert_eq!(
        discovery.matches(".join(").count(),
        2,
        "die zwei kandidaten-joins liegen unter home"
    );
    assert!(
        !discovery.contains(".join(\"/"),
        "kein absoluter join in der discovery"
    );
}

/// FR-4: die Schlüsselkette der Compat-Zuordnung steht einmal im Layout-Modul;
/// eine zweite Literalkette in einem Leser wäre eine zweite Wahrheit.
#[test]
fn vdf_schluesselkette_steht_nur_im_layout_modul() {
    let layout = include_str!("steam_layout.rs");
    for key in [
        "\"InstallConfigStore\"",
        "\"Software\"",
        "\"Valve\"",
        "\"Steam\"",
        "\"CompatToolMapping\"",
        "\"name\"",
    ] {
        assert!(
            layout.contains(key),
            "layout-modul trägt den schlüssel nicht: {key}"
        );
    }

    for (name, _) in PRODUCTION_FILES {
        let source = production(name);
        for key in ["\"InstallConfigStore\"", "\"CompatToolMapping\""] {
            assert!(
                !source.contains(key),
                "{name} trägt eine zweite schlüssel-kette: {key}"
            );
        }
    }
}

/// FR-3: `split_after_steamapps` ist die einzige `rfind("/steamapps/")`-Regel.
/// Der Pin hält fest, dass der Marker nur an dieser Stelle gesucht wird.
#[test]
fn nur_ein_rfind_auf_den_steamapps_marker() {
    let scope = production("scope.rs")
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        scope.matches("rfind(").count(),
        1,
        "genau eine rfind-stelle im scope-modul"
    );
    assert!(
        scope.contains("fn split_after_steamapps"),
        "die regel steht in split_after_steamapps"
    );
    let marker = scope
        .find("fn split_after_steamapps")
        .expect("split_after_steamapps fehlt");
    let rfind = scope.find("rfind(").expect("rfind fehlt");
    assert!(rfind > marker, "die rfind-stelle liegt nicht in der regel");
    assert_eq!(
        scope.matches("\"/steamapps/\"").count(),
        1,
        "genau ein marker-literal im scope-modul"
    );
}

/// FR-3: `library_of` und `suffix_after_steamapps` delegieren; Fehlertext und
/// Auswahl des letzten Markers bleiben identisch.
#[test]
fn split_paritaet_mit_library_of_und_suffix() {
    let cases = [
        "/home/n/.local/share/Steam/steamapps/compatdata/620",
        "/lib/steamapps/compatdata/steamapps/999",
        "/lib/steamapps/",
        "/lib/steamapps",
        "/lib/steamapps/steamapps",
        "relativ/ohne/marker",
        "",
    ];
    for case in cases {
        let split = crate::commands::scope::split_after_steamapps(case);
        let library = crate::commands::scope::library_of(case);
        let suffix = crate::commands::scope::suffix_after_steamapps(case);
        match &split {
            Ok((before, after)) => {
                assert_eq!(library.as_deref(), Ok(*before), "library_of: {case}");
                assert_eq!(suffix.as_deref(), Ok(*after), "suffix: {case}");
                assert_eq!(
                    format!("{before}/steamapps/{after}"),
                    case,
                    "der schnitt liegt am letzten marker: {case}"
                );
            }
            Err(error) => {
                assert_eq!(
                    library.as_deref().unwrap_err(),
                    error,
                    "library_of-fehlertext: {case}"
                );
                assert_eq!(
                    suffix.as_deref().unwrap_err(),
                    error,
                    "suffix-fehlertext: {case}"
                );
                assert!(
                    error.contains("path does not contain /steamapps/"),
                    "fehlertext geändert: {error}"
                );
            }
        }
    }
}

/// FR-1: Papierkorb-Name und Extraktions-Präfix stehen genau einmal im
/// Layout-Modul. Eine zweite Definition in einer Produktionsdatei wäre eine
/// zweite Wahrheit; der Wert selbst ist Teil des Wire-Vertrags (TS-Spiegel in
/// `tests/security/mirrored-constants.test.ts`).
#[test]
fn papierkorb_name_und_extraktions_praefix_stehen_nur_im_layout_modul() {
    assert_eq!(super::TRASH_DIR_NAME, ".protium-trash");
    assert_eq!(super::EXTRACT_PREFIX, ".protium-extract-");
    for (name, _) in PRODUCTION_FILES {
        let source = production(name);
        assert!(
            !source.contains("const TRASH_DIR_NAME"),
            "{name} definiert den papierkorb-namen"
        );
        assert!(
            !source.contains("const EXTRACT_PREFIX"),
            "{name} definiert das extraktions-präfix"
        );
    }
}

/// FR-4: die zwei Basis-Ketten der Compat-Zuordnung stehen einmal im
/// Layout-Modul, das klassische `InstallConfigStore`-Layout zuerst. Der Leser
/// `src/core/compatTools.ts` nimmt je AppID die erste Zuordnung; eine zweite
/// Kette in einem Leser wäre eine zweite Wahrheit.
#[test]
fn compat_basis_ketten_stehen_nur_im_layout_modul() {
    assert_eq!(
        super::COMPAT_TOOL_MAPPING_BASE_PATHS.len(),
        2,
        "genau zwei layouts"
    );
    let classic = super::COMPAT_TOOL_MAPPING_BASE_PATHS[0];
    let flat = super::COMPAT_TOOL_MAPPING_BASE_PATHS[1];
    assert_eq!(
        classic,
        &[
            super::INSTALL_CONFIG_STORE,
            super::SOFTWARE,
            super::VALVE,
            super::STEAM,
            super::COMPAT_TOOL_MAPPING,
        ][..],
        "das klassische layout steht zuerst"
    );
    assert_eq!(
        flat,
        &[
            super::SOFTWARE,
            super::VALVE,
            super::STEAM,
            super::COMPAT_TOOL_MAPPING,
        ][..]
    );
    assert_eq!(flat, &classic[1..], "das flache layout ist der rest");

    let mut with_app = classic.to_vec();
    with_app.push("620");
    assert_eq!(super::compat_tool_mapping_path("620"), with_app);

    let layout = include_str!("steam_layout.rs");
    assert!(
        layout.contains("COMPAT_TOOL_MAPPING_BASE_PATHS"),
        "positiv-kontrolle: das layout-modul trägt die ketten"
    );
    for (name, _) in PRODUCTION_FILES {
        let source = production(name);
        assert!(
            !source.contains("steam_layout::COMPAT_TOOL_MAPPING,"),
            "{name} baut eine zweite schlüssel-kette"
        );
    }
}

/// FR-3: der Schnitt liegt am LETZTEN Marker. `find` statt `rfind` liefert
/// für eine Library unterhalb eines `steamapps`-Verzeichnisses das falsche
/// library und den falschen suffix.
#[test]
fn letzter_steamapps_marker_gewinnt() {
    let case = "/lib/steamapps/compatdata/steamapps/999";
    assert_eq!(
        crate::commands::scope::library_of(case),
        Ok("/lib/steamapps/compatdata"),
        "library_of muss am letzten marker schneiden"
    );
    assert_eq!(
        crate::commands::scope::suffix_after_steamapps(case),
        Ok("999"),
        "suffix muss nach dem letzten marker beginnen"
    );
}

/// FR-4: `compat_tool_mapping_path` ist die eine Schlüsselkette des Schreibers.
#[test]
fn compat_tool_mapping_path_hat_die_schluesselkette() {
    assert_eq!(
        super::compat_tool_mapping_path("620"),
        vec![
            super::INSTALL_CONFIG_STORE,
            super::SOFTWARE,
            super::VALVE,
            super::STEAM,
            super::COMPAT_TOOL_MAPPING,
            "620",
        ]
    );
    assert_eq!(
        super::compat_tool_mapping_path("0").len(),
        6,
        "die app-id ist genau ein glied"
    );
}
