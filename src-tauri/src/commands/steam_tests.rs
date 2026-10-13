use super::*;
use crate::commands::test_util::{
    production_source, write_appmanifest, wsg_env, wsg_env_at, wsg_fixture,
};
use crate::commands::write_gate::{set_write_lock_entry_probe, MAX_CONFIG_VDF_BYTES};

#[test]
fn save_launch_options_steam_laeuft_abgelehnt() {
    let (home, cache, steam) = wsg_env("launch-running");
    std::fs::remove_file(steam.join("userdata/123/config/localconfig.vdf")).unwrap();
    let mut reader = || Ok(true);
    let res = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        "-novid",
        &cache,
        &steam,
        &mut reader,
    );
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("steam-running"));
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_prueft_prozess_zweimal_und_schreibt_nicht_bei_start_race() {
    let (home, cache, steam) = wsg_env("launch-process-race");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    let before = std::fs::read_to_string(&target).unwrap();
    let mut states = [false, true].into_iter();
    let mut reader = || Ok(states.next().expect("process reader call"));

    let result = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        "-novid",
        &cache,
        &steam,
        &mut reader,
    );

    assert!(result.unwrap_err().contains("steam-running"));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
    assert!(!cache.join("backups").exists());
    assert_eq!(states.next(), None);
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_happy_write_and_backup() {
    let (home, cache, steam) = wsg_env("launch-happy");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    let mut reader = || Ok(false);
    let res = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        "-novid",
        &cache,
        &steam,
        &mut reader,
    );
    assert_eq!(res.unwrap(), WriteResult::Written);
    let content = std::fs::read_to_string(&target).unwrap();
    assert!(content.contains("\"-novid\""));

    let backups: Vec<_> = std::fs::read_dir(cache.join("backups"))
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(backups.len(), 1);
    let backup_content = std::fs::read_to_string(backups[0].path()).unwrap();
    assert!(backup_content.contains("\"gamemoderun %command%\""));

    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_empty_removes_entry() {
    let (home, cache, steam) = wsg_env("launch-empty");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    let mut reader = || Ok(false);
    let res = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        "",
        &cache,
        &steam,
        &mut reader,
    );
    assert_eq!(res.unwrap(), WriteResult::Written);
    let content = std::fs::read_to_string(&target).unwrap();
    assert!(!content.contains("LaunchOptions"));
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_no_op_unchanged() {
    let (home, cache, steam) = wsg_env("launch-noop");
    let mut states = [false].into_iter();
    let mut reader = || Ok(states.next().expect("no-op must check once"));
    let res = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        "gamemoderun %command%",
        &cache,
        &steam,
        &mut reader,
    );
    assert_eq!(res.unwrap(), WriteResult::Unchanged);
    assert!(!cache.join("backups").exists());
    assert_eq!(states.next(), None);
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_invalid_account_or_app_id() {
    let (home, cache, steam) = wsg_env("launch-invalid");
    let mut reader = || Ok(false);
    assert!(save_launch_options_inner(
        steam.to_str().unwrap(),
        "abc",
        620,
        "-novid",
        &cache,
        &steam,
        &mut reader
    )
    .is_err());
    assert!(save_launch_options_inner(
        steam.to_str().unwrap(),
        "0",
        620,
        "-novid",
        &cache,
        &steam,
        &mut reader
    )
    .is_err());
    assert!(save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        0,
        "-novid",
        &cache,
        &steam,
        &mut reader
    )
    .is_err());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_steuerzeichen_werden_abgelehnt_ohne_seiteneffekt() {
    let (home, cache, steam) = wsg_env("launch-control");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    let before = std::fs::read_to_string(&target).unwrap();
    let mut reader = || Ok(false);

    for evil in ["gamemoderun %command%\0evil", "\u{7}evil", "\u{1}"] {
        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            evil,
            &cache,
            &steam,
            &mut reader,
        );
        assert!(res.is_err(), "wert {evil:?} muss abgelehnt werden");
    }

    // zieldatei byte-identisch, kein backup, keine temp-datei
    assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
    assert!(!cache.join("backups").exists());
    let parent = target.parent().unwrap();
    let leftovers: Vec<_> = std::fs::read_dir(parent)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "keine temp-datei darf liegenbleiben");
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_tool_name_mit_steuerzeichen_abgelehnt() {
    let (home, cache, steam) = wsg_env("compat-control");
    let target = steam.join("config/config.vdf");
    let before = std::fs::read_to_string(&target).unwrap();
    let mut reader = || Ok(false);

    // tool_name läuft durch is_authorized_compat_tool; ein name mit NUL
    // ist kein backendgelesener name und muss fail-closed abgelehnt werden
    let res = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("GE-Proton9-27\0x"),
        &cache,
        &steam,
        &mut reader,
    );
    assert!(res.is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
    assert!(!cache.join("backups").exists());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_uebergroesse_lehnt_ab_ohne_seiteneffekt() {
    let (home, cache, steam) = wsg_env("launch-oversize");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    std::fs::File::create(&target)
        .unwrap()
        .set_len(MAX_CONFIG_VDF_BYTES + 1)
        .unwrap();
    let mut reader = || Ok(false);

    let res = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        "-novid",
        &cache,
        &steam,
        &mut reader,
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("size-limit-exceeded"),
        "unexpected error: {err}"
    );
    // zieldatei unverändert (länge bleibt), kein backup, keine temp-datei
    assert_eq!(
        std::fs::metadata(&target).unwrap().len(),
        MAX_CONFIG_VDF_BYTES + 1
    );
    assert!(!cache.join("backups").exists());
    let parent = target.parent().unwrap();
    let leftovers: Vec<_> = std::fs::read_dir(parent)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "keine temp-datei darf liegenbleiben");
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_zu_grosser_eingabewert_lehnt_ab_ohne_seiteneffekt() {
    // N8: das 16-MiB-limit gilt nur für den read; ein beliebig großer
    // IPC-wert würde mehrfach kopiert und die config aufblähen.
    let (home, cache, steam) = wsg_env("launch-value-oversize");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    let before = std::fs::read_to_string(&target).unwrap();
    let oversized = "x".repeat(usize::try_from(MAX_PATCH_VALUE_BYTES).unwrap() + 1);
    let mut reader = || Ok(false);

    let res = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        &oversized,
        &cache,
        &steam,
        &mut reader,
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("size-limit-exceeded"),
        "unexpected error: {err}"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
    assert!(!cache.join("backups").exists());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_exakt_an_der_eingabegrenze_wird_geschrieben() {
    let (home, cache, steam) = wsg_env("launch-value-boundary");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    let boundary = "x".repeat(usize::try_from(MAX_PATCH_VALUE_BYTES).unwrap());
    let mut reader = || Ok(false);

    let res = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        &boundary,
        &cache,
        &steam,
        &mut reader,
    );

    assert_eq!(res.unwrap(), WriteResult::Written);
    assert!(std::fs::read_to_string(&target)
        .unwrap()
        .contains(&boundary));
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_lehnt_gepatchten_text_ueber_der_lesegrenze_ab() {
    // N8: der gepatchte text muss unter der lesegrenze bleiben, sonst
    // entstünde eine config, die protium selbst nicht mehr liest.
    let (home, cache, steam) = wsg_env("launch-patched-oversize");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    let head = r#""UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"Apps"
				{
					"620"
					{
						"LaunchOptions"		"alt"
					}
				}
			}
		}
	}
	"Pad"		""
}
"#;
    let pad_len = usize::try_from(MAX_CONFIG_VDF_BYTES).unwrap() - head.len() - 256;
    let padded = head.replace(
        "\"Pad\"\t\t\"\"",
        &format!("\"Pad\"\t\t\"{}\"", "p".repeat(pad_len)),
    );
    assert!(padded.len() as u64 <= MAX_CONFIG_VDF_BYTES);
    std::fs::write(&target, &padded).unwrap();
    let mut reader = || Ok(false);
    let growing = "y".repeat(usize::try_from(MAX_PATCH_VALUE_BYTES).unwrap());

    let res = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        &growing,
        &cache,
        &steam,
        &mut reader,
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("size-limit-exceeded"),
        "unexpected error: {err}"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), padded);
    assert!(!cache.join("backups").exists());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_zu_langer_name_lehnt_ab_ohne_seiteneffekt() {
    let (home, cache, steam) = wsg_env("compat-name-oversize");
    let target = steam.join("config/config.vdf");
    let before = std::fs::read_to_string(&target).unwrap();
    let oversized = "x".repeat(usize::try_from(MAX_PATCH_VALUE_BYTES).unwrap() + 1);
    let mut reader = || Ok(false);

    let res = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some(&oversized),
        &cache,
        &steam,
        &mut reader,
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("size-limit-exceeded"),
        "unexpected error: {err}"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
    assert!(!cache.join("backups").exists());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_exakt_an_der_lesegrenze_kein_read_limit_fehler() {
    let (home, cache, steam) = wsg_env("launch-boundary");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    std::fs::File::create(&target)
        .unwrap()
        .set_len(MAX_CONFIG_VDF_BYTES)
        .unwrap();
    let mut reader = || Ok(false);

    let res = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        "-novid",
        &cache,
        &steam,
        &mut reader,
    );
    // die 16-MiB-grenze selbst ist kein read-limit-fehler (der strukturbruch
    // durch das nul-padding ist erwartbar und getrennt)
    let err = res.unwrap_err();
    assert!(
        !err.contains("size-limit-exceeded"),
        "unexpected error: {err}"
    );
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_uebergroesse_lehnt_ab_ohne_seiteneffekt() {
    let (home, cache, steam) = wsg_env("compat-oversize");
    let target = steam.join("config/config.vdf");
    std::fs::File::create(&target)
        .unwrap()
        .set_len(MAX_CONFIG_VDF_BYTES + 1)
        .unwrap();
    let mut reader = || Ok(false);

    let res = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &steam,
        &mut reader,
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("size-limit-exceeded"),
        "unexpected error: {err}"
    );
    assert_eq!(
        std::fs::metadata(&target).unwrap().len(),
        MAX_CONFIG_VDF_BYTES + 1
    );
    assert!(!cache.join("backups").exists());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn write_gate_dedup_beide_aufrufer_nutzen_die_gemeinsame_pipeline() {
    // R-04: beleg des dedups. die sequenz (pfadprüfung, lock, gedeckelter read,
    // patch, größenprüfung, steam-nachprüfung, backup, persist) existiert nur
    // noch in `apply_write_gate`; beide aufrufer rufen sie auf und enthalten sie
    // selbst nicht mehr. fällt ein aufrufer auf eine eigene kopie zurück, schlägt
    // das hier fehl, bevor beide pfade auseinanderdriften (INV-1).
    let production = production_source(include_str!("steam.rs"));
    let gate = production_source(include_str!("write_gate.rs"));
    let launch_body = production
        .split("fn save_launch_options_inner<F>(")
        .nth(1)
        .expect("save_launch_options_inner muss vorhanden sein")
        .split("fn save_compat_tool_inner<F>(")
        .next()
        .expect("save_compat_tool_inner muss auf save_launch_options_inner folgen");
    let compat_body = production
        .split("fn save_compat_tool_inner<F>(")
        .nth(1)
        .expect("save_compat_tool_inner muss vorhanden sein")
        .split("pub async fn save_launch_options(")
        .next()
        .expect("die tauri-commands müssen auf die inner-funktionen folgen");
    let gate_body = gate
        .split("fn apply_write_gate<F, P>(")
        .nth(1)
        .expect("apply_write_gate muss vorhanden sein")
        .split("\n}\n")
        .next()
        .expect("apply_write_gate muss einen funktionsrumpf haben");

    for (name, body) in [("launch", launch_body), ("compat", compat_body)] {
        assert!(
            body.contains("apply_write_gate("),
            "{name}-aufrufer muss die gemeinsame pipeline nutzen"
        );
        for duplikat in [
            "read_config_text_bounded(",
            "write_backup_no_follow(",
            "lock_write_target(",
            "is_steam_config_path(",
        ] {
            assert!(
                !body.contains(duplikat),
                "{name}-aufrufer dupliziert die pipeline ({duplikat})"
            );
        }
    }
    assert_eq!(gate_body.matches("read_config_text_bounded(").count(), 1);
    assert_eq!(gate_body.matches("write_backup_no_follow(").count(), 1);
    assert_eq!(gate_body.matches("lock_write_target(").count(), 1);
    assert_eq!(
        gate_body
            .matches("ensure_size(&patched, MAX_CONFIG_VDF_BYTES")
            .count(),
        1
    );
    assert_eq!(
        [production, gate]
            .concat()
            .matches("read_config_text_bounded(canon, \"read target\")")
            .count(),
        1,
        "der gedeckelte read darf nur einmal im produktionscode stehen"
    );
}

/// Producer 2 der Restmenge (A-04): die pfadbeschaffung der tauri-commands
/// liefert keine rohe englische meldung mehr. Der fehler stammt aus der
/// tauri-runtime und ist ohne AppHandle nicht konstruierbar; der pin unten ist
/// deshalb der verhaltensbeleg (er war zuerst rot), dieser fall sichert den
/// kontrakt des eingeführten helpers.
#[test]
fn path_resolution_error_traegt_unavailable_und_das_label() {
    let message = path_resolution_error("home dir", std::io::Error::other("boom"));
    assert!(
        errcode::has_code(&message, errcode::UNAVAILABLE),
        "unexpected error: {message}"
    );
    assert!(message.contains("home dir"), "unexpected error: {message}");
}

#[test]
fn pfadbeschaffung_der_commands_ist_codiert() {
    let production = production_source(include_str!("steam.rs"));
    // der rohtext darf nicht zurückkehren: der code fehlt dann im leitfeld.
    assert!(!production.contains("cannot resolve home dir: {e}"));
    assert!(!production.contains("cannot resolve app cache dir: {e}"));
    // definition plus die drei verbleibenden beschaffungsstellen
    // (save_launch_options, save_compat_tool, list_config_backups). Der
    // Steam-Root kommt aus dem Snapshot, nicht mehr aus home_dir.
    assert_eq!(
        production.matches("path_resolution_error(").count(),
        4,
        "jede pfadbeschaffung muss den helper benutzen"
    );
}

#[test]
fn save_launch_options_prueft_vor_dem_rename_und_laesst_ziel_unveraendert() {
    let (home, cache, steam) = wsg_env("launch-rename-race");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    let before = std::fs::read_to_string(&target).unwrap();
    let mut states = [false, false, true].into_iter();
    let mut reader = || Ok(states.next().expect("process reader call"));

    let result = save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        620,
        "neu %command%",
        &cache,
        &steam,
        &mut reader,
    );

    assert_eq!(result.unwrap_err(), "steam-running");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
    assert!(
        cache.join("backups").exists(),
        "der abbruch greift nach dem backup, das backup bleibt liegen"
    );
    assert_eq!(states.next(), None);
    let mut entries: Vec<String> = std::fs::read_dir(target.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    entries.sort();
    assert_eq!(
        entries,
        vec!["localconfig.vdf".to_string()],
        "nach dem abbruch darf kein temp-rest liegen bleiben"
    );
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_steam_laeuft_abgelehnt() {
    let (home, cache, steam) = wsg_env("compat-running");
    std::fs::remove_file(steam.join("config/config.vdf")).unwrap();
    let mut reader = || Ok(true);
    let res = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &steam,
        &mut reader,
    );
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("steam-running"));
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_prueft_prozess_zweimal_und_schreibt_nicht_bei_start_race() {
    let (home, cache, steam) = wsg_env("compat-process-race");
    let target = steam.join("config/config.vdf");
    let before = std::fs::read_to_string(&target).unwrap();
    let mut states = [false, true].into_iter();
    let mut reader = || Ok(states.next().expect("process reader call"));

    let result = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &steam,
        &mut reader,
    );

    assert!(result.unwrap_err().contains("steam-running"));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
    assert!(!cache.join("backups").exists());
    assert_eq!(states.next(), None);
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_unbekannter_name_und_leerer_wert_abgelehnt() {
    let (home, cache, steam) = wsg_env("compat-invalid-name");
    for tool_name in [Some("unknown-tool"), Some("")] {
        let mut reader = || Ok(false);
        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            tool_name,
            &cache,
            &steam,
            &mut reader,
        );
        assert!(result.is_err(), "{tool_name:?} muss abgelehnt werden");
    }
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_erlaubt_valve_builtin_nur_mit_installiertem_manifest() {
    let (home, cache, steam) = wsg_env("compat-valve-installed");
    write_appmanifest(&steam.join("steamapps"), 1493710);
    let mut reader = || Ok(false);
    let result = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("proton_experimental"),
        &cache,
        &steam,
        &mut reader,
    );
    assert_eq!(result.unwrap(), WriteResult::Written);

    let mut reader = || Ok(false);
    let missing = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("proton_11"),
        &cache,
        &steam,
        &mut reader,
    );
    assert!(missing.is_err());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_verwirft_symlinkendes_custom_tool() {
    let (home, cache, steam) = wsg_env("compat-symlink-tool");
    let external = home.parent().unwrap().join("external-tool");
    std::fs::create_dir_all(&external).unwrap();
    std::fs::write(
        external.join("compatibilitytool.vdf"),
        "\"compatibilitytools\" { \"compat_tools\" { \"evil-tool\" {} } }",
    )
    .unwrap();
    std::os::unix::fs::symlink(&external, steam.join("compatibilitytools.d/evil-tool")).unwrap();

    let mut reader = || Ok(false);
    let result = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("evil-tool"),
        &cache,
        &steam,
        &mut reader,
    );
    assert!(result.is_err());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_verwirft_symlinkendes_custom_root() {
    let (home, cache, steam) = wsg_env("compat-symlink-root");
    let external = home.parent().unwrap().join("external-compat-root");
    std::fs::create_dir_all(external.join("CustomTool")).unwrap();
    std::fs::write(
        external.join("CustomTool/compatibilitytool.vdf"),
        "\"compatibilitytools\" { \"compat_tools\" { \"CustomTool\" {} } }",
    )
    .unwrap();
    let compat_root = steam.join("compatibilitytools.d");
    std::fs::remove_dir_all(&compat_root).unwrap();
    std::os::unix::fs::symlink(&external, &compat_root).unwrap();

    let mut reader = || Ok(false);
    let result = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("CustomTool"),
        &cache,
        &steam,
        &mut reader,
    );
    assert!(result.is_err());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_verwirft_defekte_custom_vdf() {
    let (home, cache, steam) = wsg_env("compat-broken-vdf");
    let vdf_path = steam
        .join("compatibilitytools.d")
        .join("GE-Proton9-27")
        .join("compatibilitytool.vdf");
    std::fs::write(vdf_path, "broken {").unwrap();

    let mut reader = || Ok(false);
    let result = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("GE-Proton9-27"),
        &cache,
        &steam,
        &mut reader,
    );
    assert!(result.is_err());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_happy_write_and_backup() {
    let (home, cache, steam) = wsg_env("compat-happy");
    let target = steam.join("config/config.vdf");
    let mut reader = || Ok(false);
    let res = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &steam,
        &mut reader,
    );
    assert_eq!(res.unwrap(), WriteResult::Written);
    let content = std::fs::read_to_string(&target).unwrap();
    assert!(content.contains("\"GE-Proton9-28\""));
    assert!(content.contains("\"config\"\t\t\"\""));
    assert!(content.contains("\"priority\"\t\t\"250\""));

    let backups: Vec<_> = std::fs::read_dir(cache.join("backups"))
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(backups.len(), 1);
    let backup_content = std::fs::read_to_string(backups[0].path()).unwrap();
    assert!(backup_content.contains("\"GE-Proton9-27\""));

    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_none_or_default_removes_entry() {
    let (home, cache, steam) = wsg_env("compat-remove");
    let target = steam.join("config/config.vdf");
    let mut reader = || Ok(false);
    let res = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        None,
        &cache,
        &steam,
        &mut reader,
    );
    assert_eq!(res.unwrap(), WriteResult::Written);
    let content = std::fs::read_to_string(&target).unwrap();
    assert!(!content.contains("\"620\""));
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_no_op_unchanged() {
    let (home, cache, steam) = wsg_env("compat-noop");
    let mut states = [false].into_iter();
    let mut reader = || Ok(states.next().expect("no-op must check once"));
    let res = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("GE-Proton9-27"),
        &cache,
        &steam,
        &mut reader,
    );
    assert_eq!(res.unwrap(), WriteResult::Unchanged);
    assert!(!cache.join("backups").exists());
    assert_eq!(states.next(), None);
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_fehlende_zieldatei_abgelehnt() {
    let (home, cache, steam) = wsg_env("compat-fehlt");
    let target = steam.join("config/config.vdf");
    std::fs::remove_file(&target).unwrap();
    let mut reader = || Ok(false);
    let res = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &steam,
        &mut reader,
    );
    assert!(res.is_err());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_fremder_root_abgelehnt() {
    let (home, cache, steam) = wsg_env("compat-fremdroot");
    let fremd = home.join(".local/share/Other");
    std::fs::create_dir_all(fremd.join("config")).unwrap();
    std::fs::write(fremd.join("config/config.vdf"), "x").unwrap();
    let before = std::fs::read_to_string(steam.join("config/config.vdf")).unwrap();
    let mut reader = || Ok(false);
    let res = save_compat_tool_inner(
        fremd.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &steam,
        &mut reader,
    );
    assert!(res.unwrap_err().contains("blocked-location"));
    assert_eq!(
        std::fs::read_to_string(steam.join("config/config.vdf")).unwrap(),
        before
    );
    assert_eq!(
        std::fs::read_to_string(fremd.join("config/config.vdf")).unwrap(),
        "x"
    );
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_autoritaet_kommt_aus_dem_zielroot_nicht_aus_dem_parameter() {
    let (home, cache, steam) = wsg_env("compat-authority-root");
    let target = steam.join("config/config.vdf");
    let before = std::fs::read_to_string(&target).unwrap();

    // Fremdes Verzeichnis mit Config-Symlink auf das echte Steam: der angeforderte
    // Root ist nicht der Snapshot-Root und wird abgelehnt, bevor ein Toolname
    // aus dem präparierten compatibilitytools.d Autorität bekommt (INV-1, INV-7).
    let fake = home.join(".local/share/fake");
    let evil_tool = fake.join("compatibilitytools.d/Evil-Tool");
    std::fs::create_dir_all(&evil_tool).unwrap();
    std::fs::write(
        evil_tool.join("compatibilitytool.vdf"),
        "\"compatibilitytools\" { \"compat_tools\" { \"Evil-Tool\" { } } }",
    )
    .unwrap();
    std::os::unix::fs::symlink(steam.join("config"), fake.join("config")).unwrap();
    let mut reader = || Ok(false);
    let rejected = save_compat_tool_inner(
        fake.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &steam,
        &mut reader,
    );
    assert!(rejected.unwrap_err().contains("blocked-location"));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), before);

    // Alias auf den echten Root: die Tool-Autorität kommt aus dem kanonischen
    // Ziel, nicht aus einem Nachbarverzeichnis des Symlink-Pfads.
    let link = home.join("steam-link");
    std::os::unix::fs::symlink(&steam, &link).unwrap();
    let mut reader = || Ok(false);
    let evil = save_compat_tool_inner(
        link.to_str().unwrap(),
        620,
        Some("Evil-Tool"),
        &cache,
        &steam,
        &mut reader,
    );
    assert!(evil.unwrap_err().contains("unknown-tool"));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), before);

    let mut reader = || Ok(false);
    let res = save_compat_tool_inner(
        link.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &steam,
        &mut reader,
    );
    assert_eq!(res.unwrap(), WriteResult::Written);
    assert!(std::fs::read_to_string(&target)
        .unwrap()
        .contains("\"GE-Proton9-28\""));
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_launch_options_serially_concurrent_writes() {
    let (home, cache, steam) = wsg_env("launch-serial");
    let target = steam.join("userdata/123/config/localconfig.vdf");
    let entered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    let (a_in_lock_tx, a_in_lock_rx) = std::sync::mpsc::channel::<()>();
    let (a_release_tx, a_release_rx) = std::sync::mpsc::channel::<()>();
    let (probe_tx, probe_rx) = std::sync::mpsc::channel::<()>();

    let a_steam = steam.clone();
    let a_cache = cache.clone();
    let a = std::thread::spawn(move || {
        let mut calls = 0;
        let mut reader = || {
            calls += 1;
            if calls == 2 {
                // der zweite prozess-check liegt hinter dem guard: A hält den
                // ziel-lock, bis der hauptthread freigibt
                a_in_lock_tx.send(()).unwrap();
                a_release_rx.recv().unwrap();
            }
            Ok(false)
        };
        save_launch_options_inner(
            a_steam.to_str().unwrap(),
            "123",
            620,
            "-novid",
            &a_cache,
            &a_steam,
            &mut reader,
        )
    });
    a_in_lock_rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("thread A muss den ziel-lock halten");

    let b_steam = steam.clone();
    let b_cache = cache.clone();
    let b_entered = entered.clone();
    let b = std::thread::spawn(move || {
        let _probe = set_write_lock_entry_probe(probe_tx);
        let mut calls = 0;
        let mut reader = || {
            calls += 1;
            if calls == 2 {
                b_entered.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(false)
        };
        save_launch_options_inner(
            b_steam.to_str().unwrap(),
            "123",
            730,
            "-threads 4",
            &b_cache,
            &b_steam,
            &mut reader,
        )
    });

    // solange A den guard hält, darf B die naht nicht erreichen (F2)
    let early = probe_rx.recv_timeout(std::time::Duration::from_millis(500));
    let entered_while_held = entered.load(std::sync::atomic::Ordering::SeqCst);
    a_release_tx.send(()).unwrap();
    let late = match early {
        // zu früh: die serialisierung greift nicht, dann nicht weiter warten
        Ok(()) => Err(std::sync::mpsc::RecvTimeoutError::Timeout),
        Err(_) => probe_rx.recv_timeout(std::time::Duration::from_secs(30)),
    };

    assert_eq!(a.join().unwrap().unwrap(), WriteResult::Written);
    assert_eq!(b.join().unwrap().unwrap(), WriteResult::Written);
    assert!(
        early.is_err(),
        "B darf den ziel-lock nicht erhalten, solange A ihn hält"
    );
    assert!(
        !entered_while_held,
        "B darf nicht im geschützten abschnitt sein"
    );
    assert!(late.is_ok(), "nach der freigabe muss B den lock erhalten");
    assert!(
        entered.load(std::sync::atomic::Ordering::SeqCst),
        "B muss den geschützten abschnitt betreten"
    );

    let content = std::fs::read_to_string(&target).unwrap();
    for (app, expected) in [("620", "-novid"), ("730", "-threads 4")] {
        let value = vdf_patch::get_vdf_value(
            &content,
            &[
                "UserLocalConfigStore",
                "Software",
                "Valve",
                "Steam",
                "Apps",
                app,
                "LaunchOptions",
            ],
        )
        .unwrap();
        assert_eq!(
            value.as_deref(),
            Some(expected),
            "AppID {app} muss im endstand stehen"
        );
    }
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_serially_concurrent_removals() {
    let (home, cache, steam) = wsg_env("compat-serial");
    let target = steam.join("config/config.vdf");
    let original = std::fs::read_to_string(&target).unwrap();
    // zweite vorhandene zuordnung, damit beide threads je eine entfernung
    // in die datei schreiben
    let both = vdf_patch::set_vdf_value(
        &original,
        &[
            "InstallConfigStore",
            "Software",
            "Valve",
            "Steam",
            "CompatToolMapping",
            "730",
            "name",
        ],
        "GE-Proton9-27",
    )
    .unwrap();
    std::fs::write(&target, both).unwrap();

    let entered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (a_in_lock_tx, a_in_lock_rx) = std::sync::mpsc::channel::<()>();
    let (a_release_tx, a_release_rx) = std::sync::mpsc::channel::<()>();
    let (probe_tx, probe_rx) = std::sync::mpsc::channel::<()>();

    let a_steam = steam.clone();
    let a_cache = cache.clone();
    let a = std::thread::spawn(move || {
        let mut calls = 0;
        let mut reader = || {
            calls += 1;
            if calls == 2 {
                a_in_lock_tx.send(()).unwrap();
                a_release_rx.recv().unwrap();
            }
            Ok(false)
        };
        save_compat_tool_inner(
            a_steam.to_str().unwrap(),
            620,
            None,
            &a_cache,
            &a_steam,
            &mut reader,
        )
    });
    a_in_lock_rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("thread A muss den ziel-lock halten");

    let b_steam = steam.clone();
    let b_cache = cache.clone();
    let b_entered = entered.clone();
    let b = std::thread::spawn(move || {
        let _probe = set_write_lock_entry_probe(probe_tx);
        let mut calls = 0;
        let mut reader = || {
            calls += 1;
            if calls == 2 {
                b_entered.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(false)
        };
        save_compat_tool_inner(
            b_steam.to_str().unwrap(),
            730,
            None,
            &b_cache,
            &b_steam,
            &mut reader,
        )
    });

    let early = probe_rx.recv_timeout(std::time::Duration::from_millis(500));
    let entered_while_held = entered.load(std::sync::atomic::Ordering::SeqCst);
    a_release_tx.send(()).unwrap();
    let late = match early {
        Ok(()) => Err(std::sync::mpsc::RecvTimeoutError::Timeout),
        Err(_) => probe_rx.recv_timeout(std::time::Duration::from_secs(30)),
    };

    assert_eq!(a.join().unwrap().unwrap(), WriteResult::Written);
    assert_eq!(b.join().unwrap().unwrap(), WriteResult::Written);
    assert!(
        early.is_err(),
        "B darf den ziel-lock nicht erhalten, solange A ihn hält"
    );
    assert!(
        !entered_while_held,
        "B darf nicht im geschützten abschnitt sein"
    );
    assert!(late.is_ok(), "nach der freigabe muss B den lock erhalten");

    let content = std::fs::read_to_string(&target).unwrap();
    for app in ["620", "730"] {
        let value = vdf_patch::get_vdf_value(
            &content,
            &[
                "InstallConfigStore",
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                app,
                "name",
            ],
        )
        .unwrap();
        assert!(value.is_none(), "zuordnung {app} muss entfernt bleiben");
    }
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

/// `.steam/steam` und `.steam/root` als Symlink-Aliase der nativen Wurzel: die
/// Discovery kanonisiert sie auf `.local/share/Steam`, und ein Write über einen
/// Alias landet in der nativen `config.vdf`, nicht unter einem zweiten Pfad.
#[cfg(target_os = "linux")]
#[test]
fn alias_root_kandidaten_schreiben_in_die_native_config() {
    use crate::commands::scope::build_environment_snapshot;
    use std::os::unix::fs::symlink;

    for (tag, alias) in [
        ("alias-steam", ".steam/steam"),
        ("alias-root", ".steam/root"),
    ] {
        let (home, cache, native) = wsg_env(tag);
        std::fs::create_dir_all(native.join("steamapps")).unwrap();
        std::fs::create_dir_all(home.join(".steam")).unwrap();
        symlink(&native, home.join(".steam/steam")).unwrap();
        symlink(&native, home.join(".steam/root")).unwrap();
        let root = home.parent().unwrap();
        let allowed = build_environment_snapshot(&home, &cache, &root.join("app-config"))
            .unwrap()
            .steam_root;
        assert_eq!(allowed, std::fs::canonicalize(&native).unwrap());

        let mut reader = || Ok(false);
        let written = save_compat_tool_inner(
            home.join(alias).to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &allowed,
            &mut reader,
        );
        assert_eq!(written.unwrap(), WriteResult::Written, "{alias}");
        let config = std::fs::read_to_string(native.join("config/config.vdf")).unwrap();
        assert!(config.contains("\"GE-Proton9-28\""), "{alias}: {config}");
        assert!(!config.contains("GE-Proton9-27"), "{alias}: {config}");

        let _ = std::fs::remove_dir_all(root);
    }
}

/// Debians `steam-installer`: `.steam/steam` zeigt auf `.steam/debian-installation`.
/// Die Discovery wählt das Ziel, das Write-Gate schreibt in dessen `config.vdf`.
#[cfg(target_os = "linux")]
#[test]
fn debian_installation_root_ist_schreibbar() {
    use crate::commands::scope::build_environment_snapshot;
    use std::os::unix::fs::symlink;

    let (home, cache, debian) = wsg_env_at("debian-root", ".steam/debian-installation");
    std::fs::create_dir_all(debian.join("steamapps")).unwrap();
    symlink(&debian, home.join(".steam/steam")).unwrap();
    let root = home.parent().unwrap();
    let allowed = build_environment_snapshot(&home, &cache, &root.join("app-config"))
        .unwrap()
        .steam_root;
    assert_eq!(allowed, std::fs::canonicalize(&debian).unwrap());

    let mut reader = || Ok(false);
    let written = save_compat_tool_inner(
        home.join(".steam/steam").to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &allowed,
        &mut reader,
    );
    assert_eq!(written.unwrap(), WriteResult::Written);
    assert!(std::fs::read_to_string(debian.join("config/config.vdf"))
        .unwrap()
        .contains("\"GE-Proton9-28\""));
    let _ = std::fs::remove_dir_all(root);
}

/// Echtes `~/.steam/steam` (kein Symlink auf `.local/share/Steam`) und ein Home,
/// dessen Pfad eine Symlink-Komponente enthält, lassen sich schreiben. Der
/// erlaubte Root ist der von der Discovery kanonisierte Snapshot-Root. Ein
/// fremder Root wird abgelehnt.
#[cfg(target_os = "linux")]
#[test]
fn write_gate_schreibt_entdeckten_root_mit_symlink_home() {
    use crate::commands::scope::build_environment_snapshot;
    use std::os::unix::fs::symlink;

    let discover_and_write = |tag: &str, relative: &str| {
        let (home, cache, steam) = wsg_env_at(tag, relative);
        std::fs::create_dir_all(steam.join("steamapps")).unwrap();
        let root = home.parent().unwrap();
        let link_home = root.join("link-home");
        symlink(&home, &link_home).unwrap();
        let allowed = build_environment_snapshot(&link_home, &cache, &root.join("app-config"))
            .unwrap()
            .steam_root;
        assert_eq!(allowed, std::fs::canonicalize(&steam).unwrap());
        let mut reader = || Ok(false);
        let written = save_compat_tool_inner(
            link_home.join(relative).to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &allowed,
            &mut reader,
        );
        assert_eq!(written.unwrap(), WriteResult::Written);
        assert!(std::fs::read_to_string(steam.join("config/config.vdf"))
            .unwrap()
            .contains("\"GE-Proton9-28\""));
        (home, cache, steam, allowed)
    };
    let (home, cache, dot_steam, allowed) = discover_and_write("discovered-root", ".steam/steam");
    let (native_home, ..) = discover_and_write("discovered-native", ".local/share/Steam");

    let root = home.parent().unwrap();
    let fremd = root.join("fremd/Steam");
    std::fs::create_dir_all(fremd.join("config")).unwrap();
    std::fs::write(fremd.join("config/config.vdf"), "fremd").unwrap();
    let before = std::fs::read_to_string(dot_steam.join("config/config.vdf")).unwrap();
    let mut reader = || Ok(false);
    let rejected = save_compat_tool_inner(
        fremd.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &allowed,
        &mut reader,
    );
    assert!(rejected.unwrap_err().contains("blocked-location"));
    assert_eq!(
        std::fs::read_to_string(dot_steam.join("config/config.vdf")).unwrap(),
        before
    );
    assert_eq!(
        std::fs::read_to_string(fremd.join("config/config.vdf")).unwrap(),
        "fremd"
    );

    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(native_home.parent().unwrap());
}

/// Ein Symlink, der den Snapshot-Ordner nach der Discovery ersetzt, darf nicht
/// zum neuen Schreibziel werden. Der gespeicherte Root bleibt der alte Pfad.
#[cfg(target_os = "linux")]
#[test]
fn write_gate_folgt_keinem_root_tausch_nach_dem_snapshot() {
    use std::os::unix::fs::symlink;

    let root = wsg_fixture("root-swap");
    let real = root.join("real");
    std::fs::create_dir_all(real.join("config")).unwrap();
    std::fs::write(real.join("config/config.vdf"), "original").unwrap();
    let allowed = std::fs::canonicalize(&real).unwrap();

    let parked = root.join("parked");
    std::fs::rename(&real, &parked).unwrap();
    let evil = root.join("evil");
    std::fs::create_dir_all(evil.join("config")).unwrap();
    std::fs::write(evil.join("config/config.vdf"), "evil").unwrap();
    symlink(&evil, &real).unwrap();

    let mut reader = || Ok(false);
    let error = save_compat_tool_inner(
        real.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &root.join("cache"),
        &allowed,
        &mut reader,
    )
    .unwrap_err();
    assert!(error.contains("blocked-location"), "{error}");
    assert_eq!(
        std::fs::read_to_string(evil.join("config/config.vdf")).unwrap(),
        "evil"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn test_parse_backup_file_name() {
    assert_eq!(
        parse_backup_file_name("localconfig-12345-1700000000.vdf"),
        Some(("localconfig".to_string(), "12345".to_string(), 1700000000))
    );
    assert_eq!(
        parse_backup_file_name("config-570-1700000001.vdf"),
        Some(("config".to_string(), "570".to_string(), 1700000001))
    );
    assert_eq!(parse_backup_file_name("invalid-name.vdf"), None);
    assert_eq!(parse_backup_file_name("localconfig-abc-17000.vdf"), None);
    assert_eq!(parse_backup_file_name("other-123-17000.vdf"), None);
    assert_eq!(
        parse_backup_file_name("localconfig-123-notanumber.vdf"),
        None
    );
    assert_eq!(parse_backup_file_name("localconfig-123-17000.txt"), None);
}

#[test]
fn test_list_config_backups_in_dir() {
    let root = wsg_fixture("test_backups_listing");
    let backup_dir = root.join("backups");
    std::fs::create_dir_all(&backup_dir).unwrap();

    let file1 = backup_dir.join("localconfig-100-1000.vdf");
    let file2 = backup_dir.join("config-200-2000.vdf");
    let invalid = backup_dir.join("ignored.txt");

    std::fs::write(&file1, b"localconfig data").unwrap();
    std::fs::write(&file2, b"config data").unwrap();
    std::fs::write(&invalid, b"random data").unwrap();

    let list = list_config_backups_in_dir(&backup_dir).unwrap();
    assert_eq!(list.len(), 2);
    // Sortiert nach timestamp absteigend (2000 vor 1000)
    assert_eq!(list[0].file_name, "config-200-2000.vdf");
    assert_eq!(list[0].kind, "config");
    assert_eq!(list[0].target_id, "200");
    assert_eq!(list[0].timestamp_ms, 2000);
    assert_eq!(list[0].size_bytes, 11);

    assert_eq!(list[1].file_name, "localconfig-100-1000.vdf");
    assert_eq!(list[1].kind, "localconfig");
    assert_eq!(list[1].target_id, "100");
    assert_eq!(list[1].timestamp_ms, 1000);
    assert_eq!(list[1].size_bytes, 16);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn list_config_backups_meldet_fehlenden_ordner_als_leer() {
    let root = wsg_fixture("test_backups_missing");
    let list = list_config_backups_in_dir(&root.join("backups")).unwrap();
    assert!(list.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

/// Ein defekter Eintrag (Verzeichnis, baumelnder Symlink) darf die Liste nicht
/// als Ganzes verhindern (INV-2).
#[test]
fn list_config_backups_ueberspringt_defekte_eintraege() {
    let root = wsg_fixture("test_backups_defekt");
    let backup_dir = root.join("backups");
    std::fs::create_dir_all(backup_dir.join("localconfig-9-9.vdf")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        backup_dir.join("fehlt.vdf"),
        backup_dir.join("config-7-7.vdf"),
    )
    .unwrap();
    std::fs::write(backup_dir.join("config-200-2000.vdf"), b"x").unwrap();

    let list = list_config_backups_in_dir(&backup_dir).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].file_name, "config-200-2000.vdf");
    let _ = std::fs::remove_dir_all(&root);
}

/// Ein symlinkter Backup-Ordner ist eine Blockade, keine leere Liste.
#[cfg(unix)]
#[test]
fn list_config_backups_lehnt_symlinkten_ordner_ab() {
    let root = wsg_fixture("test_backups_symlink");
    let real = root.join("echt");
    std::fs::create_dir_all(&real).unwrap();
    let link = root.join("backups");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    assert_eq!(list_config_backups_in_dir(&link).unwrap_err(), "blocked");
    let _ = std::fs::remove_dir_all(&root);
}
