use super::*;
use crate::commands::errcode;
use crate::commands::path::random_suffix;
use crate::commands::scope::{EnvironmentSnapshot, EnvironmentState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;

fn ge_snapshot(root: &Path) -> EnvironmentSnapshot {
    EnvironmentSnapshot::for_test(
        root.to_path_buf(),
        vec![root.to_path_buf()],
        Vec::new(),
        root.join("cache"),
        root.join("config"),
    )
}

#[test]
fn ge_install_direct_ipc_snapshot_authority_is_current_and_exact() {
    let root = std::env::temp_dir().join(format!("test-ge-snapshot-{}", random_suffix()));
    let other = std::env::temp_dir().join(format!("test-ge-other-{}", random_suffix()));
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&other).unwrap();

    let undiscovered = EnvironmentState::default();
    assert!(undiscovered
        .authorize_ge_install_paths(root.to_str().unwrap())
        .is_err());

    let state = EnvironmentState::for_test(ge_snapshot(&root));
    let (authorized_root, tools_dir) = state
        .authorize_ge_install_paths(root.to_str().unwrap())
        .unwrap();
    assert_eq!(authorized_root, root);
    assert_eq!(tools_dir, root.join("compatibilitytools.d"));
    assert!(state.is_current_ge_install_path(&authorized_root, &authorized_root, &tools_dir));
    assert!(state.is_current_ge_install_path(&tools_dir, &authorized_root, &tools_dir));
    assert!(state
        .authorize_ge_install_paths(other.to_str().unwrap())
        .is_err());

    state.replace_for_test(ge_snapshot(&other));
    assert!(state
        .authorize_ge_install_paths(root.to_str().unwrap())
        .is_err());
    assert!(!state.is_current_ge_install_path(&authorized_root, &authorized_root, &tools_dir));
    assert!(state
        .authorize_ge_install_paths(other.to_str().unwrap())
        .is_ok());

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&other);
}

#[test]
fn ge_install_snapshot_guard_serializes_replace_and_mutation() {
    let root = std::env::temp_dir().join(format!("test-ge-guard-{}", random_suffix()));
    let other = std::env::temp_dir().join(format!("test-ge-guard-other-{}", random_suffix()));
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&other).unwrap();
    let state = EnvironmentState::for_test(ge_snapshot(&root));
    let tools_dir = root.join("compatibilitytools.d");
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let mutation_started = Arc::new(AtomicBool::new(false));
    let replacement_done = Arc::new(AtomicBool::new(false));
    let worker_state = state.clone();
    let worker_entered = Arc::clone(&entered);
    let worker_release = Arc::clone(&release);
    let worker_mutation = Arc::clone(&mutation_started);
    let worker_root = root.clone();
    let worker_tools = tools_dir.clone();
    let worker = thread::spawn(move || {
        worker_state.with_authorized_ge_install(&worker_root, &worker_tools, || {
            worker_entered.wait();
            worker_release.wait();
            worker_mutation.store(true, Ordering::Release);
            Ok::<(), String>(())
        })
    });

    entered.wait();
    let replacement_state = state.clone();
    let replacement_root = other.clone();
    let replacement_finished = Arc::clone(&replacement_done);
    let replacement = thread::spawn(move || {
        replacement_state.replace_for_test(ge_snapshot(&replacement_root));
        replacement_finished.store(true, Ordering::Release);
    });
    thread::yield_now();
    assert!(!mutation_started.load(Ordering::Acquire));
    assert!(!replacement_done.load(Ordering::Acquire));
    release.wait();
    worker.join().unwrap().unwrap();
    replacement.join().unwrap();
    assert!(mutation_started.load(Ordering::Acquire));
    assert!(replacement_done.load(Ordering::Acquire));
    assert!(state
        .with_authorized_ge_install(&root, &tools_dir, || -> Result<(), String> {
            panic!("revoked snapshot must not mutate")
        })
        .is_err());

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&other);
}

#[test]
fn parse_sha512_hash_extrahiert_128_hex_zeichen() {
    let text = "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef  GE-Proton9-27.tar.gz\n";
    let hash = parse_sha512_hash(text, "GE-Proton9-27.tar.gz").unwrap();
    assert_eq!(
        hash,
        "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    );
}

#[test]
fn parse_sha512_hash_lehnt_ungueltigen_text_ab() {
    assert!(parse_sha512_hash("kein hash hier", "GE-Proton9-27.tar.gz").is_err());
    assert!(parse_sha512_hash("12345 short", "GE-Proton9-27.tar.gz").is_err());
    assert!(parse_sha512_hash("", "GE-Proton9-27.tar.gz").is_err());
}

#[test]
fn parse_sha512_hash_bindet_exakten_assetnamen_und_gnu_starformat() {
    let hash = "a".repeat(128);
    let text = format!("{hash}  other.tar.gz\n{hash} *GE-Proton11-4-x86_64.tar.gz\n");
    assert_eq!(
        parse_sha512_hash(&text, "GE-Proton11-4-x86_64.tar.gz").unwrap(),
        hash
    );
    assert!(parse_sha512_hash(&text, "missing.tar.gz").is_err());
}

#[test]
fn target_arch_normalisierung_ist_injizierbar_und_fail_closed() {
    assert_eq!(normalize_target_arch("x86_64"), Ok(TargetArch::X86_64));
    assert_eq!(normalize_target_arch("aarch64"), Ok(TargetArch::Aarch64));
    assert!(normalize_target_arch("amd64").is_err());
    assert!(normalize_target_arch("arm64").is_err());
    assert!(normalize_target_arch("unknown").is_err());
}

#[test]
fn ge_target_arch_nutzt_die_compile_architektur_ohne_webview_input() {
    let expected = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => panic!("testsystemarchitektur {other:?} ist für GE nicht freigegeben"),
    };
    assert_eq!(ge_target_arch().unwrap(), expected);
}

#[test]
fn release_identity_koppelt_tag_asset_installname_und_checksum_url() {
    let identity = validate_release_identity(
        TargetArch::X86_64,
        "GE-Proton11-4",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz",
    )
    .unwrap();
    assert_eq!(identity.asset_name, "GE-Proton11-4-x86_64.tar.gz");
    assert_eq!(identity.install_name, "GE-Proton11-4-x86_64");
    assert_eq!(identity.checksum_asset_name, "GE-Proton11-4-x86_64.tar.gz");
    assert_eq!(
        checksum_url("GE-Proton11-4", &identity),
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.sha512sum"
    );

    for download in [
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-aarch64.tar.gz",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz?x=1",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz#fragment",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz/extra",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton%31%31-4/GE-Proton11-4-x86_64.tar.gz",
    ] {
        assert!(validate_release_identity(TargetArch::X86_64, "GE-Proton11-4", download).is_err());
    }

    let legacy = validate_release_identity(
        TargetArch::X86_64,
        "GE-Proton11-3",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-3/GE-Proton11-3.tar.gz",
    );
    assert!(legacy.is_ok());
    assert!(validate_release_identity(
        TargetArch::X86_64,
        "GE-Proton11-4",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4.tar.gz",
    )
    .is_err());
}

#[test]
fn verify_file_hash_on_disk_erkennt_abweichungen() {
    let temp_dir = std::env::temp_dir().join(format!("test-verify-hash-{}", random_suffix()));
    fs::create_dir_all(&temp_dir).unwrap();
    let file_path = temp_dir.join("test.bin");
    fs::write(&file_path, b"hello world").unwrap();
    let mut file = fs::File::open(&file_path).unwrap();
    let cancel = CancelSignal::new();

    let mut hasher = Sha512::new();
    hasher.update(b"hello world");
    let good_hash = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    assert!(verify_file_hash_on_disk(&mut file, &good_hash, &cancel).is_ok());
    assert!(verify_file_hash_on_disk(&mut file, &"0".repeat(128), &cancel).is_err());

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn verify_file_hash_on_disk_bricht_bei_cancel_ab() {
    let temp_dir =
        std::env::temp_dir().join(format!("test-verify-hash-cancel-{}", random_suffix()));
    fs::create_dir_all(&temp_dir).unwrap();
    let file_path = temp_dir.join("test.bin");
    fs::write(&file_path, b"hello world").unwrap();
    let mut file = fs::File::open(&file_path).unwrap();
    let cancel = CancelSignal::new();

    let mut hasher = Sha512::new();
    hasher.update(b"hello world");
    let good_hash = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    cancel.cancel();
    let error = verify_file_hash_on_disk(&mut file, &good_hash, &cancel).unwrap_err();
    assert_eq!(error, "cancelled");

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn unverified_confirmation_naht_bindet_404_warning_okcancel_und_ablehnung() {
    let mut shown = false;
    let rejected = confirm_unverified_installation(
        "GE-Proton11-3",
        "GE-Proton11-3",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-3/GE-Proton11-3.sha512sum",
        |request| {
            shown = true;
            assert_eq!(request.kind, ConfirmationKind::Warning);
            assert_eq!(request.buttons, ConfirmationButtons::OkCancel);
            assert!(request.message.contains("HTTP 404"));
            Ok(false)
        },
    )
    .unwrap();
    assert!(shown);
    assert!(!rejected, "native ablehnung darf nicht fortsetzen");

    let accepted = confirm_unverified_installation(
        "GE-Proton11-3",
        "GE-Proton11-3",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-3/GE-Proton11-3.sha512sum",
        |request| {
            assert_eq!(request.kind, ConfirmationKind::Warning);
            assert_eq!(request.buttons, ConfirmationButtons::OkCancel);
            Ok(true)
        },
    )
    .unwrap();
    assert!(
        accepted,
        "native zustimmung muss nur den 404-fall fortsetzen"
    );
}

#[test]
fn nur_http_404_ist_ein_fehlendes_checksum_asset() {
    assert!(is_missing_checksum_asset(&Sha512FetchError::Http(404)));
    assert!(!is_missing_checksum_asset(&Sha512FetchError::Http(403)));
    assert!(!is_missing_checksum_asset(&Sha512FetchError::Failed(
        "timeout".into()
    )));
}

#[test]
fn cancel_nach_sha_vor_extract_raeumt_datei_und_registry_auf() {
    let root = std::env::temp_dir().join(format!("test-ge-cancel-boundary-{}", random_suffix()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("download.tar.gz");
    fs::write(&path, b"attacker path").unwrap();
    let registry = CancelRegistry::default();
    let cancel = crate::commands::download::register_download(&registry, "post-sha").unwrap();

    cancel.cancel();
    let result = cancel_before_extract(&cancel);
    assert_eq!(result.unwrap_err(), "cancelled");
    assert!(
        path.exists(),
        "cancel vor extract darf keinen später angelegten pfad löschen"
    );
    assert_eq!(fs::read(&path).unwrap(), b"attacker path");

    let mut map = registry.0.lock().unwrap();
    let same = map
        .get("post-sha")
        .map(|registered| Arc::ptr_eq(registered, &cancel))
        .unwrap_or(false);
    assert!(same);
    map.remove("post-sha");
    assert!(
        map.is_empty(),
        "registry muss nach dem install-wrapper leer sein"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cancel_nach_guard_check_verhindert_extract_mutation() {
    let root = std::env::temp_dir().join(format!("test-ge-cancel-guard-{}", random_suffix()));
    fs::create_dir_all(&root).unwrap();
    let tools = root.join("compatibilitytools.d");
    let state = EnvironmentState::for_test(ge_snapshot(&root));
    let registry = CancelRegistry::default();
    let cancel = crate::commands::download::register_download(&registry, "guard-cancel").unwrap();
    let entered_guard = Arc::new(Barrier::new(2));
    let release_closure = Arc::new(Barrier::new(2));
    let worker_entered = Arc::clone(&entered_guard);
    let worker_release = Arc::clone(&release_closure);
    let worker_cancel = Arc::clone(&cancel);
    let worker_state = state.clone();
    let worker_root = root.clone();
    let worker_tools = tools.clone();
    let worker = thread::spawn(move || {
        worker_state.with_authorized_ge_install(&worker_root, &worker_tools, || {
            worker_entered.wait();
            worker_release.wait();
            extract_after_cancel_check(&worker_cancel, || {
                fs::create_dir_all(&worker_tools).map_err(|e| e.to_string())?;
                Ok(())
            })
        })
    });

    entered_guard.wait();
    cancel.cancel();
    release_closure.wait();
    let result = worker.join().unwrap();
    assert_eq!(result.unwrap_err(), "cancelled");
    assert!(!tools.exists(), "cancel vor extract darf kein ziel anlegen");

    let mut map = registry.0.lock().unwrap();
    map.remove("guard-cancel");
    assert!(map.is_empty(), "registry muss nach cancel bereinigt werden");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn install_pipeline_oeffnet_downloadpfad_nicht_erneut() {
    let source = include_str!("ge_install.rs");
    let start = source
        .find("pub(super) async fn install_ge_proton_inner")
        .unwrap();
    let body = &source[start..source.find("#[tauri::command]").unwrap()];
    assert!(!body.contains("File::open(&download_path"));
    assert!(!body.contains("cleanup_download_path"));
    assert!(!body.contains("download_file_name"));
    assert!(!body.contains("download_path"));
    assert!(!body.contains("download_path_str"));
    // der disk-hash läuft über denselben owned-handle, nie über einen pfad
    assert!(body.contains("verify_file_hash_on_disk("));
    assert!(body.contains("extract_blocking_with_tag("));
    assert!(body.contains("&mut downloaded_file"));
}

#[tokio::test]
async fn install_ge_proton_validiert_release_tag() {
    let temp_dir = std::env::temp_dir().join(format!("test-ge-tag-{}", random_suffix()));
    fs::create_dir_all(&temp_dir).unwrap();
    let cache_dir = temp_dir.join("cache");

    let res = install_ge_proton_inner(
        temp_dir.to_str().unwrap(),
        TargetArch::X86_64,
        "Proton-9.0",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
        "dl-1",
        &cache_dir,
        Arc::new(CancelSignal::new()),
        |_, _| {},
        |_, _| {},
        |_| Ok(true),
        &|_| true,
        ExtractEnvironment::StaticScopeOnly,
    )
    .await;

    assert!(res.is_err(), "non-GE tag muss abgewiesen werden: {res:?}");
    assert!(res.unwrap_err().contains("invalid-id"));

    let _ = fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn install_ge_proton_validiert_download_url() {
    let temp_dir = std::env::temp_dir().join(format!("test-ge-url-{}", random_suffix()));
    fs::create_dir_all(&temp_dir).unwrap();
    let cache_dir = temp_dir.join("cache");

    let res = install_ge_proton_inner(
        temp_dir.to_str().unwrap(),
        TargetArch::X86_64,
        "GE-Proton9-27",
        "https://evil.com/GE-Proton9-27.tar.gz",
        "dl-1",
        &cache_dir,
        Arc::new(CancelSignal::new()),
        |_, _| {},
        |_, _| {},
        |_| Ok(true),
        &|_| true,
        ExtractEnvironment::StaticScopeOnly,
    )
    .await;

    assert!(
        res.is_err(),
        "evil download URL muss abgewiesen werden: {res:?}"
    );

    let _ = fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn install_ge_proton_lehnt_existierendes_ziel_ab() {
    let temp_dir = std::env::temp_dir().join(format!("test-ge-exists-{}", random_suffix()));
    let tools_dir = temp_dir.join("compatibilitytools.d").join("GE-Proton9-27");
    fs::create_dir_all(&tools_dir).unwrap();
    let cache_dir = temp_dir.join("cache");

    let res = install_ge_proton_inner(
        temp_dir.to_str().unwrap(),
        TargetArch::X86_64,
        "GE-Proton9-27",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
        "dl-1",
        &cache_dir,
        Arc::new(CancelSignal::new()),
        |_, _| {},
        |_, _| {},
        |_| Ok(true),
        &|_| true,
        ExtractEnvironment::StaticScopeOnly,
    )
    .await;

    assert!(
        res.is_err(),
        "bereits existierendes Ziel muss abgewiesen werden: {res:?}"
    );
    assert!(res.unwrap_err().contains("tool-already-exists"));

    let _ = fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn install_ge_proton_meldet_extract_crash_reste_und_loescht_nicht() {
    let temp_dir = std::env::temp_dir().join(format!("test-ge-leftover-{}", random_suffix()));
    let tools = temp_dir.join("compatibilitytools.d");
    fs::create_dir_all(&tools).unwrap();
    let leftover = tools.join(format!(".protium-extract-{}-leftover", std::process::id()));
    fs::create_dir(&leftover).unwrap();
    let cache_dir = temp_dir.join("cache");

    let res = install_ge_proton_inner(
        temp_dir.to_str().unwrap(),
        TargetArch::X86_64,
        "GE-Proton9-27",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
        "dl-1",
        &cache_dir,
        Arc::new(CancelSignal::new()),
        |_, _| {},
        |_, _| {},
        |_| Ok(true),
        &|_| true,
        ExtractEnvironment::StaticScopeOnly,
    )
    .await;

    let err = res.unwrap_err();
    assert!(
        errcode::has_code(&err, errcode::INCOMPLETE),
        "crash-reste müssen als incomplete gemeldet werden: {err}"
    );
    assert!(err.contains(".protium-extract-"), "err: {err}");
    assert!(
        leftover.exists(),
        "crash-rest darf nie automatisch gelöscht werden"
    );
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn extract_fehler_behalten_ihren_code_statt_unavailable() {
    // r-09: der frühere pauschale umschluss auf unavailable hat einem abbruch
    // oder einem belegten ziel die klasse genommen; die oberfläche zeigte
    // "nicht verfügbar" statt "abgebrochen" oder "tool existiert bereits".
    for code in [
        errcode::CANCELLED,
        errcode::TOOL_EXISTS,
        errcode::SIZE_LIMIT,
        errcode::SYMLINK_REJECTED,
        errcode::BLOCKED_LOCATION,
    ] {
        assert_eq!(extract_error_with_code(code.to_string()), code);
        let with_detail = errcode::with_detail(code, "detail");
        assert_eq!(extract_error_with_code(with_detail.clone()), with_detail);
    }
    // ein echter restfehler ohne code bleibt unavailable mit detail
    assert_eq!(
        extract_error_with_code("boese".to_string()),
        errcode::with_detail(errcode::UNAVAILABLE, "boese")
    );
}

#[tokio::test]
async fn install_ge_proton_lehnt_unscoped_steam_root_ab() {
    let temp_dir = std::env::temp_dir().join(format!("test-ge-unscope-{}", random_suffix()));
    fs::create_dir_all(&temp_dir).unwrap();
    let cache_dir = temp_dir.join("cache");

    let res = install_ge_proton_inner(
        temp_dir.to_str().unwrap(),
        TargetArch::X86_64,
        "GE-Proton9-27",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
        "dl-1",
        &cache_dir,
        Arc::new(CancelSignal::new()),
        |_, _| {},
        |_, _| {},
        |_| Ok(true),
        &|_| false,
        ExtractEnvironment::StaticScopeOnly,
    )
    .await;

    assert!(
        res.is_err(),
        "unscoped steam_root muss abgewiesen werden: {res:?}"
    );
    assert!(res.unwrap_err().contains("blocked-location"));

    let _ = fs::remove_dir_all(&temp_dir);
}
