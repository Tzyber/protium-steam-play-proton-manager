use super::*;
use crate::commands::test_util::{production_source, write_appmanifest, wsg_fixture};

fn wsg_env(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let root = wsg_fixture(tag);
    let home = root.join("fakehome");
    let steam = home.join(".local/share/Steam");
    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::create_dir_all(steam.join("userdata/123/config")).unwrap();
    let config_vdf = r#""InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"620"
					{
						"name"		"GE-Proton9-27"
					}
				}
			}
		}
	}
}
"#;
    let local_vdf = r#""UserLocalConfigStore"
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
						"LaunchOptions"		"gamemoderun %command%"
					}
				}
			}
		}
	}
}
"#;
    std::fs::write(steam.join("config/config.vdf"), config_vdf).unwrap();
    std::fs::write(steam.join("userdata/123/config/localconfig.vdf"), local_vdf).unwrap();
    for tool_name in ["GE-Proton9-27", "GE-Proton9-28"] {
        let tool_dir = steam.join("compatibilitytools.d").join(tool_name);
        std::fs::create_dir_all(&tool_dir).unwrap();
        let tool_vdf =
            format!("\"compatibilitytools\" {{ \"compat_tools\" {{ \"{tool_name}\" {{ }} }} }}");
        std::fs::write(tool_dir.join("compatibilitytool.vdf"), tool_vdf).unwrap();
    }
    let cache = root.join("cache");
    std::fs::create_dir_all(&cache).unwrap();
    (home, cache, steam)
}

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
        &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
        &mut reader
    )
    .is_err());
    assert!(save_launch_options_inner(
        steam.to_str().unwrap(),
        "0",
        620,
        "-novid",
        &cache,
        &home,
        &mut reader
    )
    .is_err());
    assert!(save_launch_options_inner(
        steam.to_str().unwrap(),
        "123",
        0,
        "-novid",
        &cache,
        &home,
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
            &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
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
fn write_gate_bleibt_crash_durable_gesichert() {
    // statischer schutz: die dokumentierte write-gate-garantie (atomarer
    // rename PLUS durable inhalte) darf nicht still auf temp+rename
    // ohne fsync zurückfallen. seit N1 muss die sequenz zusätzlich
    // descriptorgebunden sein: keine pfadbasierten operationen mehr.
    let source = include_str!("steam.rs");
    let production = production_source(source);
    let persist_body = production
        .split("fn persist_atomic_with_ops")
        .nth(1)
        .expect("persist_atomic_with_ops must exist in production source")
        .split("fn persist_atomic<")
        .next()
        .expect("persist_atomic_with_ops must be defined before persist_atomic");

    let tmp_sync = persist_body.find("(ops.sync_file)(&mut file)");
    let check = persist_body.find("(ops.before_rename)()");
    let rename = persist_body.find("(ops.rename)(dir_fd, tmp_name, dir_fd, target_name)");
    assert!(
        tmp_sync.is_some() && check.is_some() && rename.is_some(),
        "temp-sync, letzte prüfung und rename müssen vorhanden sein"
    );
    assert!(
        tmp_sync.unwrap() < rename.unwrap(),
        "temp-sync muss vor dem rename laufen"
    );
    assert!(
        check.unwrap() < rename.unwrap(),
        "die letzte prüfung muss unmittelbar vor dem rename laufen"
    );
    assert!(
        persist_body.contains("(ops.sync_parent)(dir_fd)"),
        "parent-fsync muss über den gebundenen deskriptor laufen"
    );
    assert!(
        persist_body.contains("fd::create_exclusive_at") && persist_body.contains("fd::unlink_at"),
        "temp-anlage und aufräumen müssen über die deskriptor-helfer laufen"
    );
    for verboten in ["fs::File::create", "fs::rename", "fs::remove_file"] {
        assert!(
            !persist_body.contains(verboten),
            "pfadbasierte operation im persist-pfad: {verboten}"
        );
    }
    // beide write-pfade nutzen die gemeinsame funktion
    assert_eq!(
        production
            .matches("persist_atomic(&canon, patched.as_bytes(), process_reader)")
            .count(),
        2,
        "beide write-pfade müssen persist_atomic nutzen"
    );
    // backup ist ebenfalls sync_alled (darf den stromausfall nicht als leere kopie überleben)
    assert!(
        production.contains("and_then(|()| file.sync_all())"),
        "backup-write muss sync_all enthalten"
    );
    assert!(
        production.contains("sync_directory(dir_fd.as_raw_fd())"),
        "backup-directory-entry muss über den gebundenen descriptor synchronisiert werden"
    );
    assert!(
        production.contains("let mut sync_directory = sync_dir_fd"),
        "produktiver backup-pfad muss den echten descriptor-fsync verwenden"
    );
    // die deskriptor-helfer selbst liegen in fd.rs; neu angelegte verzeichnisse
    // syncen ihren parent, und der directory-fsync ist kein follow-open
    let fd_source = include_str!("fd.rs");
    assert!(
        fd_source.contains("sync_dir_fd(parent_fd)"),
        "neu angelegte verzeichnisse müssen ihren parent synchronisieren"
    );
    assert!(
        fd_source.contains("libc::fsync(fd)"),
        "directory-fsync darf nicht auf einem pfad-basierten follow-open beruhen"
    );
    let backup_call = production
        .find("write_backup_no_follow(&backup_rel, backup_dir, &original)?;")
        .expect("backup muss vor dem target-write abgeschlossen werden");
    let target_call = production
        .find("let write_result = persist_atomic(&canon, patched.as_bytes(), process_reader);")
        .expect("target-write muss im write-gate vorhanden sein");
    assert!(
        backup_call < target_call,
        "ein backup-fehler darf keinen nachfolgenden target-write erreichen"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn persist_atomic_temp_sync_fehler_laesst_ziel_unveraendert_und_raeumt_temp() {
    let root = wsg_fixture("persist-temp-sync-error");
    let target = root.join("config.vdf");
    let tmp_name = OsStr::new(".config.vdf.tmp");
    std::fs::write(&target, "alt").unwrap();
    let dir = open_absolute_dir(&root).unwrap();

    let mut sync_file =
        |_file: &mut std::fs::File| Err(std::io::Error::other("injected temp sync failure"));
    let mut before_rename =
        || -> Result<(), String> { panic!("prüfung darf vor temp-sync nicht erreicht werden") };
    let mut rename = |_from_dir: RawFd, _from: &OsStr, _to_dir: RawFd, _to: &OsStr| {
        panic!("rename darf vor temp-sync nicht erreicht werden")
    };
    let mut sync_parent = |_fd: RawFd| panic!("parent-sync darf vor rename nicht erreicht werden");

    let error = persist_atomic_with_ops(
        dir.as_raw_fd(),
        tmp_name,
        OsStr::new("config.vdf"),
        b"neu",
        &mut PersistOps {
            sync_file: &mut sync_file,
            before_rename: &mut before_rename,
            rename: &mut rename,
            sync_parent: &mut sync_parent,
        },
    )
    .unwrap_err();

    assert!(matches!(error, PersistAtomicError::BeforeRename(_)));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt");
    assert!(!root.join(tmp_name).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn persist_atomic_rename_fehler_laesst_ziel_unveraendert_und_raeumt_temp() {
    let root = wsg_fixture("persist-rename-error");
    let target = root.join("config.vdf");
    let tmp_name = OsStr::new(".config.vdf.tmp");
    std::fs::write(&target, "alt").unwrap();
    let dir = open_absolute_dir(&root).unwrap();

    let mut sync_file = |file: &mut std::fs::File| file.sync_all();
    let mut before_rename = || -> Result<(), String> { Ok(()) };
    let mut rename = |_from_dir: RawFd, _from: &OsStr, _to_dir: RawFd, _to: &OsStr| {
        Err(std::io::Error::other("injected rename failure"))
    };
    let mut sync_parent =
        |_fd: RawFd| panic!("parent-sync darf nach fehlgeschlagenem rename nicht erreicht werden");

    let error = persist_atomic_with_ops(
        dir.as_raw_fd(),
        tmp_name,
        OsStr::new("config.vdf"),
        b"neu",
        &mut PersistOps {
            sync_file: &mut sync_file,
            before_rename: &mut before_rename,
            rename: &mut rename,
            sync_parent: &mut sync_parent,
        },
    )
    .unwrap_err();

    assert!(matches!(error, PersistAtomicError::BeforeRename(_)));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt");
    assert!(!root.join(tmp_name).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn persist_atomic_parent_sync_fehler_signalisiert_moegliche_mutation() {
    let root = wsg_fixture("persist-parent-sync-error");
    let target = root.join("config.vdf");
    let tmp_name = OsStr::new(".config.vdf.tmp");
    std::fs::write(&target, "alt").unwrap();
    let dir = open_absolute_dir(&root).unwrap();

    let mut sync_file = |file: &mut std::fs::File| file.sync_all();
    let mut before_rename = || -> Result<(), String> { Ok(()) };
    let mut rename = |from_dir: RawFd, from: &OsStr, to_dir: RawFd, to: &OsStr| {
        fd::rename_at(from_dir, from, to_dir, to)
    };
    let mut sync_parent = |_fd: RawFd| Err(std::io::Error::other("injected parent sync failure"));

    let error = persist_atomic_with_ops(
        dir.as_raw_fd(),
        tmp_name,
        OsStr::new("config.vdf"),
        b"neu",
        &mut PersistOps {
            sync_file: &mut sync_file,
            before_rename: &mut before_rename,
            rename: &mut rename,
            sync_parent: &mut sync_parent,
        },
    )
    .unwrap_err();

    assert!(matches!(error, PersistAtomicError::AfterRename(_)));
    // Der Code muss durchkommen, sonst zeigt die Oberflaeche "nichts veraendert".
    assert!(
        error.to_string().starts_with("write-may-have-applied"),
        "unexpected error: {error}"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "neu");
    assert!(!root.join(tmp_name).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_folgt_keinem_vorbereiteten_temp_symlink() {
    // N1: der Temp-pfad ist vorhersagbar genug, um ihn vorzubereiten. O_EXCL
    // verhindert das folgen und damit das truncaten einer fremddatei.
    let root = wsg_fixture("persist-temp-symlink");
    let target = root.join("config.vdf");
    let victim = root.join("opfer.vdf");
    std::fs::write(&target, "alt").unwrap();
    std::fs::write(&victim, "opfer").unwrap();
    let link_parent = root.clone();
    PERSIST_TEMP_PROBE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |tmp_name: &OsStr| {
            std::os::unix::fs::symlink("opfer.vdf", link_parent.join(tmp_name)).unwrap();
        }));
    });
    let mut reader = || Ok(false);
    let error = persist_atomic(&target, b"neu", &mut reader).unwrap_err();
    PERSIST_TEMP_PROBE.with(|slot| *slot.borrow_mut() = None);

    assert!(matches!(error, PersistAtomicError::BeforeRename(_)));
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "opfer");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt");
    // ziel, opferdatei und der fremde symlink bleiben liegen: einen eintrag,
    // den dieser vorgang nicht angelegt hat, räumt er auch nicht weg
    let entries: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap())
        .collect();
    assert_eq!(entries.len(), 3);
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.file_type().unwrap().is_symlink())
            .count(),
        1,
        "der vorbereitete symlink bleibt unangetastet liegen"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_meldet_parent_tausch_ohne_fremdmutation() {
    // N1: der Parent wird im Bindefenster zwischen Stat und Open getauscht.
    // Die Identitätsprüfung plus O_NOFOLLOW muss fail-closed enden.
    let root = wsg_fixture("persist-parent-swap");
    let parent = root.join("steamdata");
    std::fs::create_dir_all(&parent).unwrap();
    let target = parent.join("config.vdf");
    std::fs::write(&target, "alt").unwrap();
    let moved = root.join("echt");
    let fremd = root.join("fremd");
    std::fs::create_dir_all(&fremd).unwrap();
    std::fs::write(fremd.join("config.vdf"), "fremd").unwrap();

    let (swap_parent, swap_moved, swap_fremd) = (parent.clone(), moved.clone(), fremd.clone());
    PERSIST_BIND_PROBE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(&swap_parent, &swap_moved).unwrap();
            std::os::unix::fs::symlink(&swap_fremd, &swap_parent).unwrap();
        }));
    });
    let mut reader = || Ok(false);
    let error = persist_atomic(&target, b"neu", &mut reader).unwrap_err();
    PERSIST_BIND_PROBE.with(|slot| *slot.borrow_mut() = None);

    assert!(matches!(error, PersistAtomicError::BeforeRename(_)));
    assert_eq!(
        std::fs::read_to_string(fremd.join("config.vdf")).unwrap(),
        "fremd",
        "das fremde verzeichnis darf nicht beschrieben werden"
    );
    assert_eq!(
        std::fs::read_to_string(moved.join("config.vdf")).unwrap(),
        "alt"
    );
    assert_eq!(
        std::fs::read_dir(&moved).unwrap().count(),
        1,
        "im echten verzeichnis darf kein temp-rest liegen bleiben"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_meldet_einen_parent_tausch_gegen_ein_echtes_verzeichnis() {
    // Der Symlink-Fall wird schon von O_NOFOLLOW abgewiesen. Hier wird der
    // Parent gegen ein ECHTES anderes Verzeichnis getauscht, damit die
    // dev/ino-Prüfung selbst greift (nur so ist sie gedeckt).
    let root = wsg_fixture("persist-parent-swap-real");
    let parent = root.join("steamdata");
    std::fs::create_dir_all(&parent).unwrap();
    let target = parent.join("config.vdf");
    std::fs::write(&target, "alt").unwrap();
    let moved = root.join("echt");
    let fremd = root.join("fremd");
    std::fs::create_dir_all(&fremd).unwrap();
    std::fs::write(fremd.join("config.vdf"), "fremd").unwrap();

    let (swap_parent, swap_moved, swap_fremd) = (parent.clone(), moved.clone(), fremd.clone());
    PERSIST_BIND_PROBE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(&swap_parent, &swap_moved).unwrap();
            std::fs::rename(&swap_fremd, &swap_parent).unwrap();
        }));
    });
    let mut reader = || Ok(false);
    let error = persist_atomic(&target, b"neu", &mut reader).unwrap_err();
    PERSIST_BIND_PROBE.with(|slot| *slot.borrow_mut() = None);

    assert!(
        error
            .to_string()
            .contains("changed while opening descriptor"),
        "unexpected error: {error}"
    );
    // nach dem tausch liegt das untergeschobene verzeichnis unter dem
    // originalnamen des parents; es darf nicht beschrieben worden sein
    assert_eq!(
        std::fs::read_to_string(parent.join("config.vdf")).unwrap(),
        "fremd",
        "das untergeschobene verzeichnis darf nicht beschrieben werden"
    );
    assert_eq!(
        std::fs::read_to_string(moved.join("config.vdf")).unwrap(),
        "alt"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_ersetzt_einen_zwischendurch_gesetzten_ziel_symlink_ohne_zu_folgen() {
    // N1: das Ziel wird unmittelbar vor dem Rename durch einen Symlink auf eine
    // fremddatei ersetzt. rename ersetzt den link selbst und folgt ihm nicht.
    let root = wsg_fixture("persist-target-symlink");
    let target = root.join("config.vdf");
    let victim = root.join("opfer.vdf");
    std::fs::write(&target, "alt").unwrap();
    std::fs::write(&victim, "opfer").unwrap();
    let (link_parent, link_target) = (root.clone(), target.clone());
    PERSIST_RENAME_PROBE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            std::fs::remove_file(&link_target).unwrap();
            std::os::unix::fs::symlink("opfer.vdf", link_parent.join("config.vdf")).unwrap();
        }));
    });
    let mut reader = || Ok(false);
    let result = persist_atomic(&target, b"neu", &mut reader);
    PERSIST_RENAME_PROBE.with(|slot| *slot.borrow_mut() = None);

    assert!(result.is_ok(), "rename muss den link selbst ersetzen");
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        "opfer",
        "die verlinkte fremddatei darf unberührt bleiben"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "neu");
    assert!(!std::fs::symlink_metadata(&target).unwrap().is_symlink());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_bricht_vor_dem_rename_ab_wenn_steam_startet() {
    // N2: der letzte check liegt unmittelbar vor der irreversiblen mutation.
    let root = wsg_fixture("persist-steam-start");
    let target = root.join("config.vdf");
    std::fs::write(&target, "alt").unwrap();

    let mut reader = || Ok(true);
    let error = persist_atomic(&target, b"neu", &mut reader).unwrap_err();

    assert_eq!(error.to_string(), "steam-running");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt");
    assert_eq!(
        std::fs::read_dir(&root).unwrap().count(),
        1,
        "nach dem abbruch darf kein temp-rest liegen bleiben"
    );
    let _ = std::fs::remove_dir_all(root);
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
        &home,
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

#[cfg(target_os = "linux")]
#[test]
fn write_backup_directory_sync_fehler_raeumt_backup_auf() {
    let root = wsg_fixture("backup-directory-sync-error");
    let backup_dir = root.join("cache");
    let backup_path = backup_dir.join("backups/original.vdf");
    let target = root.join("steam-config.vdf");
    std::fs::create_dir_all(&backup_dir).unwrap();
    std::fs::write(&target, "ziel-unveraendert").unwrap();

    let mut sync_calls = 0;
    let mut sync_directory = |_fd: RawFd| {
        sync_calls += 1;
        if sync_calls == 1 {
            Err(std::io::Error::other(
                "injected backup directory sync failure",
            ))
        } else {
            Ok(())
        }
    };
    let error = write_backup_no_follow_with_sync(
        Path::new("backups/original.vdf"),
        &backup_dir,
        "backup-inhalt",
        &mut sync_directory,
    )
    .unwrap_err();

    assert!(error.contains("backup directory sync"));
    assert_eq!(
        sync_calls, 2,
        "cleanup muss den directory-entry erneut syncen"
    );
    assert!(!backup_path.exists());
    assert!(
        std::fs::read_dir(backup_path.parent().unwrap())
            .unwrap()
            .next()
            .is_none(),
        "nach einem backup-fsync-fehler darf kein backup-rest liegenbleiben"
    );
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "ziel-unveraendert"
    );
    let _ = std::fs::remove_dir_all(root);
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
        &home,
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
        &home,
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
            &home,
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
        &home,
        &mut reader,
    );
    assert_eq!(result.unwrap(), WriteResult::Written);

    let mut reader = || Ok(false);
    let missing = save_compat_tool_inner(
        steam.to_str().unwrap(),
        620,
        Some("proton_11"),
        &cache,
        &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
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
        &home,
        &mut reader,
    );
    assert!(res.is_err());
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn save_compat_tool_fremder_root_abgelehnt() {
    let (home, cache, _steam) = wsg_env("compat-fremdroot");
    let fremd = home.join(".local/share/Other");
    std::fs::create_dir_all(fremd.join("config")).unwrap();
    std::fs::write(fremd.join("config/config.vdf"), "x").unwrap();
    let mut reader = || Ok(false);
    let res = save_compat_tool_inner(
        fremd.to_str().unwrap(),
        620,
        Some("GE-Proton9-28"),
        &cache,
        &home,
        &mut reader,
    );
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("not-a-steam-config"));
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn write_gate_backup_zwischenpfad_symlink_abgelehnt_ohne_zielveraenderung() {
    let (home, cache, steam) = wsg_env("backup-intermediate-symlink");
    let target = steam.join("config/config.vdf");
    let external_dir = home.parent().unwrap().join("externes-backup-dir");
    let external_file = external_dir.join("1.vdf");
    std::fs::create_dir_all(&external_dir).unwrap();
    std::fs::write(&external_file, "extern-unveraendert").unwrap();

    let backup_parent = cache.join("backups");
    let backup = backup_parent.join("1.vdf");
    std::fs::create_dir_all(&backup_parent).unwrap();
    std::fs::remove_dir(&backup_parent).unwrap();
    std::os::unix::fs::symlink(&external_dir, &backup_parent).unwrap();

    let relative = backup.strip_prefix(&cache).unwrap();
    let res = write_backup_no_follow(relative, &cache, "neu");

    assert!(
        res.is_err(),
        "zwischenpfad-symlink muss abgelehnt werden: {res:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&external_file).unwrap(),
        "extern-unveraendert"
    );
    assert!(std::fs::read_to_string(&target)
        .unwrap()
        .contains("GE-Proton9-27"));
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn write_gate_backup_root_swap_auf_symlink_abgelehnt_ohne_zielveraenderung() {
    let (home, cache, steam) = wsg_env("backup-root-swap");
    let target = steam.join("config/config.vdf");
    let external_dir = home.parent().unwrap().join("externes-backup-root");
    let external_file = external_dir.join("1.vdf");
    std::fs::create_dir_all(&external_dir).unwrap();
    std::fs::write(&external_file, "extern-unveraendert").unwrap();

    let backup_parent = cache.join("backups");
    let backup = backup_parent.join("1.vdf");
    std::fs::create_dir_all(&backup_parent).unwrap();
    std::fs::remove_dir_all(&cache).unwrap();
    std::os::unix::fs::symlink(&external_dir, &cache).unwrap();

    let relative = backup.strip_prefix(&cache).unwrap();
    let res = write_backup_no_follow(relative, &cache, "neu");

    assert!(
        res.is_err(),
        "geswapte backup-root symlink muss abgelehnt werden: {res:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&external_file).unwrap(),
        "extern-unveraendert"
    );
    assert!(std::fs::read_to_string(&target)
        .unwrap()
        .contains("GE-Proton9-27"));
    let _ = std::fs::remove_file(&cache);
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn write_gate_muster_erkennung_flatpak_und_snap() {
    let root = wsg_fixture("muster");
    let home = root.join("fakehome");
    let flatpak =
        home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam/config/config.vdf");
    let snap = home.join("snap/steam/common/.local/share/Steam/config/config.vdf");
    assert!(is_steam_config_path(&flatpak, &home));
    assert!(is_steam_config_path(&snap, &home));
    assert!(!is_steam_config_path(&home.join("etc/evil"), &home));
    assert!(!is_steam_config_path(
        &home.join(".local/share/Steam/userdata/abc/config/localconfig.vdf"),
        &home
    ));
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_akzeptiert_kanonisierten_steam_symlink_alias() {
    use std::os::unix::fs::symlink;

    let root = wsg_fixture("symlink-alias");
    let home = root.join("fakehome");
    let native_root = home.join(".local/share/Steam");
    let config = native_root.join("config/config.vdf");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(&config, "\"InstallConfigStore\" {}\n").unwrap();
    std::fs::create_dir_all(home.join(".steam")).unwrap();
    let alias = home.join(".steam/steam");
    symlink(&native_root, &alias).unwrap();

    let canonical = std::fs::canonicalize(alias.join("config/config.vdf")).unwrap();
    assert!(is_steam_config_path(&canonical, &home));

    let _ = std::fs::remove_dir_all(&root);
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
    let a_home = home.clone();
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
            &a_home,
            &mut reader,
        )
    });
    a_in_lock_rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("thread A muss den ziel-lock halten");

    let b_steam = steam.clone();
    let b_cache = cache.clone();
    let b_home = home.clone();
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
            &b_home,
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
    let a_home = home.clone();
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
            &a_home,
            &mut reader,
        )
    });
    a_in_lock_rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("thread A muss den ziel-lock halten");

    let b_steam = steam.clone();
    let b_cache = cache.clone();
    let b_home = home.clone();
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
            &b_home,
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

#[test]
fn write_lock_for_target_teilt_pro_pfad_und_trennt_pfade() {
    let root = wsg_fixture("write-lock-registry");
    let first = write_lock_for_target(&root.join("a.vdf"));
    let second = write_lock_for_target(&root.join("a.vdf"));
    let other = write_lock_for_target(&root.join("b.vdf"));

    assert!(
        std::ptr::eq(first, second),
        "gleicher pfad muss dieselbe sperre treffen"
    );
    assert!(
        !std::ptr::eq(first, other),
        "verschiedene pfade brauchen getrennte sperren"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn write_lock_blockiert_bis_der_guard_faellt() {
    let root = wsg_fixture("write-lock-guard");
    let canon = root.join("config.vdf");
    let entered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    let guard = lock_write_target(&canon);
    let waiter_canon = canon.clone();
    let waiter_entered = entered.clone();
    // handshake statt sleep: der waiter meldet, dass er den lock anfordert,
    // erst danach ist `!entered` aussagekräftig.
    let (asking_tx, asking_rx) = std::sync::mpsc::channel::<()>();
    let waiter = std::thread::spawn(move || {
        asking_tx.send(()).unwrap();
        let _guard = lock_write_target(&waiter_canon);
        waiter_entered.store(true, std::sync::atomic::Ordering::SeqCst);
    });

    asking_rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("der waiter muss den lock anfordern");
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert!(
        !entered.load(std::sync::atomic::Ordering::SeqCst),
        "der wartende thread darf erst nach dem drop weiterlaufen"
    );
    drop(guard);
    waiter.join().unwrap();
    assert!(
        entered.load(std::sync::atomic::Ordering::SeqCst),
        "nach dem drop muss die sperre frei sein"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// Die Discovery kennt fünf Wurzel-Kandidaten, das Write-Gate drei kanonische.
/// Dieser Test belegt, dass die zwei zusätzlichen Kandidaten (`.steam/steam`,
/// `.steam/root`) per canonicalize auf einen der drei kollabieren. Ein neuer
/// Kandidat in `scope::ROOT_CANDIDATES`, der das nicht tut, lässt das
/// Write-Gate stillschweigend für diese Installation aussperren.
#[cfg(target_os = "linux")]
#[test]
fn root_kandidaten_kollabieren_auf_die_write_gate_wurzeln() {
    use crate::commands::scope::ROOT_CANDIDATES;
    use std::os::unix::fs::symlink;

    let root = wsg_fixture("root-candidates");
    let home = root.join("fakehome");
    let native = home.join(".local/share/Steam");
    let flatpak = home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam");
    let snap = home.join("snap/steam/common/.local/share/Steam");

    // vollständiges kandidaten-verzeichnis wie in einer echten installation:
    // native wurzel existiert, die beiden alias-pfade zeigen per symlink darauf.
    std::fs::create_dir_all(native.join("config")).unwrap();
    std::fs::write(
        native.join("config/config.vdf"),
        "\"InstallConfigStore\" {}\n",
    )
    .unwrap();
    std::fs::create_dir_all(flatpak.join("config")).unwrap();
    std::fs::create_dir_all(snap.join("config")).unwrap();
    let dot_steam = home.join(".steam");
    std::fs::create_dir_all(&dot_steam).unwrap();
    symlink(&native, dot_steam.join("steam")).unwrap();
    symlink(&native, dot_steam.join("root")).unwrap();

    let canonical_roots = [&native, &flatpak, &snap];
    for relative in ROOT_CANDIDATES {
        let candidate = home.join(relative);
        if !candidate.exists() {
            // fehlende kandidaten sind normal (nicht jede installation hat alle)
            continue;
        }
        let canonical = std::fs::canonicalize(&candidate).unwrap();
        assert!(
            canonical_roots.iter().any(|known| canonical == **known),
            "kandidat {relative} kollabiert auf {canonical:?}, keine write-gate-wurzel"
        );
        assert!(is_steam_config_path(
            &canonical.join("config/config.vdf"),
            &home
        ));
    }

    // negativfall: eine unbekannte wurzel erkennt das write-gate nicht.
    let unknown = home.join("custom/Steam");
    std::fs::create_dir_all(unknown.join("config")).unwrap();
    assert!(!is_steam_config_path(
        &unknown.join("config/config.vdf"),
        &home
    ));

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

#[cfg(target_os = "linux")]
#[test]
fn config_read_folgt_keinem_vorbereiteten_symlink() {
    // r-01: im fenster zwischen pfadprüfung und read kann die config gegen
    // einen symlink getauscht werden. der read darf ihm nicht folgen: fremder
    // inhalt darf weder gelesen noch ins backup gelangen.
    let root = wsg_fixture("config-read-symlink");
    let dir = root.join("userdata/123/config");
    std::fs::create_dir_all(&dir).unwrap();
    let victim = root.join("opfer.vdf");
    std::fs::write(&victim, "fremder inhalt").unwrap();
    let link = dir.join("localconfig.vdf");
    std::os::unix::fs::symlink(&victim, &link).unwrap();

    let error = read_config_text_bounded(&link, "read target").unwrap_err();

    assert!(error.contains("read target"), "unexpected error: {error}");
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        "fremder inhalt",
        "die verlinkte fremddatei darf nicht angetastet werden"
    );
    // gegenprobe: die echte datei bleibt über dieselbe funktion lesbar
    let real = dir.join("localconfig-echt.vdf");
    std::fs::write(&real, "\"UserLocalConfigStore\"").unwrap();
    assert_eq!(
        read_config_text_bounded(&real, "read target").unwrap(),
        "\"UserLocalConfigStore\""
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn config_read_ist_an_den_gebundenen_parent_angebunden() {
    // r-01: statischer beleg: der linux-config-read öffnet die datei per
    // O_NOFOLLOW aus einem gebundenen parent und nicht mehr pfadbasiert. der
    // genaue tauschzeitpunkt im fenster ist ohne injektionshaken nicht
    // belegbar (prüflücke), der direkte symlink-fall darüber deckt die
    // no-follow-kette ab.
    let production = production_source(include_str!("steam.rs"));
    let linux_read = production
        .split("fn read_config_text_bounded")
        .nth(1)
        .expect("read_config_text_bounded muss vorhanden sein")
        .split("#[cfg(not(target_os = \"linux\"))]")
        .next()
        .expect("nicht-linux-variante muss markiert sein");
    assert!(
        linux_read.contains("open_file_at(parent_fd.as_raw_fd(), file_name)"),
        "config-read muss die datei aus dem gebundenen parent öffnen"
    );
    assert!(
        !linux_read.contains("std::fs::File::open"),
        "config-read darf nicht pfadbasiert öffnen"
    );
}
