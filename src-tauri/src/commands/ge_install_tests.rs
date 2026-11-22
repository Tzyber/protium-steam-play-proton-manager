use super::*;
use crate::commands::errcode;
use crate::commands::path::random_suffix;
use crate::commands::scope::{EnvironmentSnapshot, EnvironmentState};
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

const GE_NAME: &str = "GE-Proton11-5-x86_64";

/// 6.9: der entpack-cap ist ein eigener cap. Der download-cap (8 GiB) ist
/// keine obergrenze für entpackte bytes; der quelltext-pin hält beide
/// extract-arme auf `MAX_UNPACK_BYTES`.
#[test]
fn ge_install_entpackt_mit_dem_unpack_cap() {
    // Der Download-Cap ist keine Obergrenze für entpackte Bytes.
    const {
        assert!(
            crate::commands::limits::MAX_UNPACK_BYTES
                < crate::commands::download::MAX_DOWNLOAD_BYTES
        )
    };
    let production = crate::commands::test_util::production_source(include_str!("ge_install.rs"));
    // import + `max_bytes` des download-speichers: `MAX_DOWNLOAD_BYTES` steht
    // nur am download, nie am extract.
    assert_eq!(
        production.matches("MAX_DOWNLOAD_BYTES").count(),
        2,
        "MAX_DOWNLOAD_BYTES gehört nur zum download"
    );
    // import + die beiden extract-arme (autorisiert und test-scope).
    assert_eq!(
        production.matches("MAX_UNPACK_BYTES").count(),
        3,
        "beide extract-arme entpacken mit dem unpack-cap"
    );
    // Der autorisierte arm reicht beide caps positional durch. Der exakte
    // aufruf-ausschnitt hält auch die reihenfolge: `u64::MAX`/`usize::MAX`
    // oder ein vertauschter cap bricht den pin.
    let arm = crate::commands::test_util::funktion_body(
        production,
        "fn extract_in_authorized_environment(",
    );
    let arm = arm.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    assert!(
        arm.contains("MAX_UNPACK_BYTES,\nMAX_ENTRIES,"),
        "unpack-arm muss beide caps durchreichen: {arm}"
    );
}

/// 6.9: auch der extract-seam reicht den eintrags-cap positional durch, statt
/// ihn offen zu lassen. `usize::MAX` an dieser stelle bricht den pin.
#[test]
fn extract_seam_reicht_den_entry_cap_durch() {
    let production = crate::commands::test_util::production_source(include_str!("extract.rs"));
    let body =
        crate::commands::test_util::funktion_body(production, "fn extract_blocking_with_tag(");
    let body = body.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    assert!(
        body.contains("max_unpack_bytes,\nMAX_ENTRIES,"),
        "seam muss den entry-cap durchreichen: {body}"
    );
}

/// P15/FR-1 (Review P2-2): Signatur-Pins dürfen nicht an Einrückung oder
/// Zeilenumbrüchen hängen; `rustfmt` bricht lange Signaturen und Feldlisten um,
/// ohne die Signatur zu ändern. Deshalb läuft jeder Vergleich über den
/// whitespace-normalisierten Text.
fn normalisiert(source: &str) -> String {
    source.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// P15/FR-2 (Review P2-1): die pipeline klopft das verschachtelte Result in
/// dieser reihenfolge flach: der äußere fehler (scope, autorisierung, cancel)
/// geht unverändert durch, der innere (extraktion) bekommt seinen code über
/// `extract_error_with_code`. Ein echter pipeline-lauf ist nicht herstellbar,
/// weil `validate_release_identity` die download-URL auf github.com pinnt und
/// der download vor der extraktion liegt (kein lokaler server); der pin hält
/// deshalb die stelle fest, die map selbst deckt
/// `extract_fehler_behalten_ihren_code_statt_unavailable` ab.
#[test]
fn extract_pipeline_mappt_nur_den_inneren_fehler_auf_seinen_code() {
    let production = crate::commands::test_util::production_source(include_str!("ge_install.rs"));
    let rumpf = normalisiert(crate::commands::test_util::funktion_body(
        production,
        "async fn install_ge_proton_inner",
    ));
    assert!(
        rumpf.contains(
            "let (extract_result, _downloaded_file) = extract_res?; \
             extract_result.map_err(extract_error_with_code)?;"
        ),
        "innerer extract-fehler läuft durch die code-map, der äußere unverändert"
    );
}

fn ge_archive(root: &Path) -> fs::File {
    let mut bytes = Vec::new();
    {
        let encoder = flate2::write::GzEncoder::new(&mut bytes, flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_path(GE_NAME).unwrap();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_cksum();
        archive.append(&header, std::io::empty()).unwrap();
        let mut file = tar::Header::new_gnu();
        file.set_path(format!("{GE_NAME}/version")).unwrap();
        file.set_size(3);
        file.set_cksum();
        archive.append(&file, &b"ok\n"[..]).unwrap();
        archive.finish().unwrap();
    }
    let source = root.join("download");
    fs::write(&source, bytes).unwrap();
    fs::File::open(&source).unwrap()
}

fn has_extract_leftovers(tools: &Path) -> bool {
    fs::read_dir(tools)
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(steam_layout::EXTRACT_PREFIX)
        })
}

/// Läuft den Authorized-Arm mit der Scope-Closure aus `install_ge_proton`;
/// `during_extract` läuft zwischen Autorisierung und Rename.
fn run_authorized_extract(
    state: &EnvironmentState,
    root: &Path,
    tools: &Path,
    during_extract: &mut dyn FnMut(),
) -> Result<Result<(), String>, String> {
    let mut handle = ge_archive(root);
    extract_in_authorized_environment(
        state,
        &|path: &Path| state.is_current_ge_install_path(path, root, tools),
        root,
        tools,
        GE_NAME,
        &mut handle,
        &CancelSignal::new(),
        during_extract,
    )
}

#[test]
fn rescan_mit_gleichem_root_waehrend_der_extraktion_installiert() {
    let root = std::env::temp_dir().join(format!("test-ge-rescan-{}", random_suffix()));
    let tools = root.join("compatibilitytools.d");
    fs::create_dir_all(&tools).unwrap();
    let state = EnvironmentState::for_test(ge_snapshot(&root));
    let generation = state.current().unwrap().generation;

    let result = run_authorized_extract(&state, &root, &tools, &mut || {
        state.replace_for_test(ge_snapshot(&root))
    });

    assert!(matches!(result, Ok(Ok(()))), "{result:?}");
    assert!(
        state.current().unwrap().generation > generation,
        "der rescan muss während der extraktion gelaufen sein"
    );
    assert!(tools.join(GE_NAME).join("version").exists());
    assert!(!has_extract_leftovers(&tools));

    let _ = fs::remove_dir_all(&root);
}

/// A-10: Lesen und Ersetzen des Snapshots aus einem anderen Thread warten
/// nicht auf das Ende der Extraktion. Ein gehaltener Mutex liefe in den
/// Timeout, statt den Test hängen zu lassen.
#[test]
fn snapshot_read_waehrend_der_extraktion_blockiert_nicht() {
    use std::sync::mpsc;
    use std::time::Duration;

    let root = std::env::temp_dir().join(format!("test-ge-read-{}", random_suffix()));
    let tools = root.join("compatibilitytools.d");
    fs::create_dir_all(&tools).unwrap();
    let state = EnvironmentState::for_test(ge_snapshot(&root));
    let (seen_tx, seen_rx) = mpsc::channel();
    let mut seen = None;

    let result = run_authorized_extract(&state, &root, &tools, &mut || {
        let (other, rescan_root, seen_tx) = (state.clone(), root.clone(), seen_tx.clone());
        thread::spawn(move || {
            other.replace_for_test(ge_snapshot(&rescan_root));
            let _ = seen_tx.send(other.current().map(|snapshot| snapshot.steam_root));
        });
        seen = Some(seen_rx.recv_timeout(Duration::from_secs(5)));
    });

    assert_eq!(seen, Some(Ok(Ok(root.clone()))));
    assert!(matches!(result, Ok(Ok(()))), "{result:?}");
    assert!(tools.join(GE_NAME).join("version").exists());

    let _ = fs::remove_dir_all(&root);
}

/// A-10: die Operation (in Produktion der finale Rename) läuft unter dem
/// Environment-Mutex. Ein paralleles `replace` wartet, bis sie fertig ist.
#[test]
fn ge_install_operation_laeuft_unter_dem_environment_mutex() {
    use std::sync::mpsc;
    use std::time::Duration;

    let root = std::env::temp_dir().join(format!("test-ge-locked-{}", random_suffix()));
    let other = root.join("other");
    let tools = root.join("compatibilitytools.d");
    fs::create_dir_all(&root).unwrap();
    let state = EnvironmentState::for_test(ge_snapshot(&root));
    let (done_tx, done_rx) = mpsc::channel();
    let (replacer, other_snapshot) = (state.clone(), ge_snapshot(&other));

    state
        .with_authorized_ge_install(&root, &tools, || {
            thread::spawn(move || {
                replacer.replace_for_test(other_snapshot);
                let _ = done_tx.send(());
            });
            assert!(
                done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
                "replace darf nicht zwischen prüfung und rename fallen"
            );
            Ok(())
        })
        .unwrap();
    done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(state.current().unwrap().steam_root, other);

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn root_wechsel_waehrend_der_extraktion_verhindert_den_rename() {
    let root = std::env::temp_dir().join(format!("test-ge-root-switch-{}", random_suffix()));
    let other = std::env::temp_dir().join(format!("test-ge-root-other-{}", random_suffix()));
    let tools = root.join("compatibilitytools.d");
    fs::create_dir_all(&tools).unwrap();
    fs::create_dir_all(&other).unwrap();
    let state = EnvironmentState::for_test(ge_snapshot(&root));

    let result = run_authorized_extract(&state, &root, &tools, &mut || {
        state.replace_for_test(ge_snapshot(&other))
    });

    let error = result.unwrap().unwrap_err();
    assert!(
        errcode::has_code(&error, errcode::BLOCKED_LOCATION),
        "root-wechsel muss vor dem rename abbrechen: {error}"
    );
    assert!(!tools.join(GE_NAME).exists());
    assert!(!has_extract_leftovers(&tools));

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

    crate::commands::download::clear_registered_download(&registry, "post-sha");
    assert!(
        registry.0.lock().unwrap().is_empty(),
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
        worker_state.with_authorized_ge_install(&worker_root, &worker_tools, || Ok(()))?;
        worker_entered.wait();
        worker_release.wait();
        extract_after_cancel_check(&worker_cancel, || {
            fs::create_dir_all(&worker_tools).map_err(|e| e.to_string())?;
            Ok(())
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

/// Körper von `install_ge_proton_inner` bis zum nächsten Command-Attribut;
/// gemeinsamer slice für die quelltext-pins der pipeline.
fn pipeline_body() -> &'static str {
    let source = include_str!("ge_install.rs");
    let start = source
        .find("pub(super) async fn install_ge_proton_inner")
        .expect("install_ge_proton_inner fehlt");
    &source[start
        ..source
            .find("#[tauri::command]")
            .expect("kein #[tauri::command] nach der pipeline")]
}

#[test]
fn install_pipeline_oeffnet_downloadpfad_nicht_erneut() {
    let body = pipeline_body();
    assert!(!body.contains("File::open(&download_path"));
    assert!(!body.contains("cleanup_download_path"));
    assert!(!body.contains("download_file_name"));
    assert!(!body.contains("download_path"));
    assert!(!body.contains("download_path_str"));
    // der disk-hash läuft über denselben owned-handle, nie über einen pfad
    assert!(body.contains("verify_file_hash_on_disk("));
    assert!(body.contains("= extract_in_authorized_environment("));
    assert!(body.contains("extract_blocking_with_tag_with_hook("));
    assert!(body.contains("&mut downloaded_file"));
}

/// R-01 (Audit 2026-11-17): `open_downloads_directory` macht mkdir,
/// canonicalize und stat und gehört wie alle Nachbarschritte der Phase in den
/// blocking-pool; auf dem Tokio-Worker würde es mitten im Download Progress
/// und Cancel auf langsamem I/O blockieren. Der Pin schlägt an, sobald der
/// Aufruf ausserhalb eines spawn_blocking_io-Abschnitts steht.
#[test]
fn open_downloads_directory_laeuft_im_blocking_pool() {
    let body = pipeline_body();
    let call = body
        .find("open_downloads_directory(")
        .expect("kein open_downloads_directory-aufruf im pipeline-koerper");
    let spawn = body[..call]
        .rfind("spawn_blocking_io(")
        .expect("kein spawn_blocking_io vor dem aufruf");
    let awaited = spawn
        + body[spawn..]
            .find(".await")
            .expect("kein .await nach dem spawn");
    assert!(
        call < awaited,
        "open_downloads_directory liegt nicht im blocking-pool: {}",
        &body[call..(call + 80).min(body.len())]
    );
}

/// R5: ein vorhandener, offen angelegter Cache und `downloads` werden beim
/// Öffnen verengt, damit ein gelöschter und neu entstandener Cache nicht offen
/// bleibt.
#[cfg(unix)]
#[test]
fn open_downloads_directory_verengt_cache_und_downloads_auf_0700() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("test-ge-downloads-mode-{}", random_suffix()));
    let cache = root.join("cache");
    let downloads = cache.join("downloads");
    fs::create_dir_all(&downloads).unwrap();
    fs::set_permissions(&cache, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&downloads, fs::Permissions::from_mode(0o755)).unwrap();
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&cache), 0o755);
    assert_eq!(mode(&downloads), 0o755);

    let (_directory, _identity) = open_downloads_directory(&cache).unwrap();

    assert_eq!(mode(&cache), 0o700);
    assert_eq!(mode(&downloads), 0o700);
    let _ = fs::remove_dir_all(&root);
}

/// B8: fehlt `downloads` in einem bereits vorhandenen, offen angelegten Cache,
/// entsteht es privat; der Bestand des Caches wird dabei mitverengt.
#[cfg(unix)]
#[test]
fn open_downloads_directory_legt_fehlendes_downloads_privat_an() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("test-ge-downloads-create-{}", random_suffix()));
    let cache = root.join("cache");
    let downloads = cache.join("downloads");
    fs::create_dir_all(&cache).unwrap();
    fs::set_permissions(&cache, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!downloads.exists(), "fixture muss ohne downloads starten");
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;

    let (_directory, _identity) = open_downloads_directory(&cache).unwrap();

    assert_eq!(mode(&cache), 0o700);
    assert_eq!(mode(&downloads), 0o700);
    let _ = fs::remove_dir_all(&root);
}

#[tokio::test]
async fn install_ge_proton_validiert_release_tag() {
    let temp_dir = std::env::temp_dir().join(format!("test-ge-tag-{}", random_suffix()));
    fs::create_dir_all(&temp_dir).unwrap();
    let cache_dir = temp_dir.join("cache");

    let res = install_ge_proton_inner(
        InstallJob {
            steam_root: temp_dir.to_str().unwrap(),
            target_arch: TargetArch::X86_64,
            release_tag: "Proton-9.0",
            download_url: "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
            download_id: "dl-1",
            cache_dir: &cache_dir,
            cancel_flag: Arc::new(CancelSignal::new()),
            dialog_locale: DialogLocale::De,
            scope_ok: Arc::new(|_: &Path| true),
            environment: ExtractEnvironment::StaticScopeOnly,
        },
        InstallSinks {
            on_progress: |_: u64, _: Option<u64>| {},
            on_phase: |_: &str, _: bool| {},
            confirm_unverified: |_: UnverifiedConfirmationRequest| std::future::ready(Ok(true)),
        },
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
        InstallJob {
            steam_root: temp_dir.to_str().unwrap(),
            target_arch: TargetArch::X86_64,
            release_tag: "GE-Proton9-27",
            download_url: "https://evil.com/GE-Proton9-27.tar.gz",
            download_id: "dl-1",
            cache_dir: &cache_dir,
            cancel_flag: Arc::new(CancelSignal::new()),
            dialog_locale: DialogLocale::De,
            scope_ok: Arc::new(|_: &Path| true),
            environment: ExtractEnvironment::StaticScopeOnly,
        },
        InstallSinks {
            on_progress: |_: u64, _: Option<u64>| {},
            on_phase: |_: &str, _: bool| {},
            confirm_unverified: |_: UnverifiedConfirmationRequest| std::future::ready(Ok(true)),
        },
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
        InstallJob {
            steam_root: temp_dir.to_str().unwrap(),
            target_arch: TargetArch::X86_64,
            release_tag: "GE-Proton9-27",
            download_url: "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
            download_id: "dl-1",
            cache_dir: &cache_dir,
            cancel_flag: Arc::new(CancelSignal::new()),
            dialog_locale: DialogLocale::De,
            scope_ok: Arc::new(|_: &Path| true),
            environment: ExtractEnvironment::StaticScopeOnly,
        },
        InstallSinks {
            on_progress: |_: u64, _: Option<u64>| {},
            on_phase: |_: &str, _: bool| {},
            confirm_unverified: |_: UnverifiedConfirmationRequest| std::future::ready(Ok(true)),
        },
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
    let leftover = tools.join(format!(
        "{}{}-leftover",
        steam_layout::EXTRACT_PREFIX,
        std::process::id()
    ));
    fs::create_dir(&leftover).unwrap();
    let cache_dir = temp_dir.join("cache");

    let res = install_ge_proton_inner(
        InstallJob {
            steam_root: temp_dir.to_str().unwrap(),
            target_arch: TargetArch::X86_64,
            release_tag: "GE-Proton9-27",
            download_url: "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
            download_id: "dl-1",
            cache_dir: &cache_dir,
            cancel_flag: Arc::new(CancelSignal::new()),
            dialog_locale: DialogLocale::De,
            scope_ok: Arc::new(|_: &Path| true),
            environment: ExtractEnvironment::StaticScopeOnly,
        },
        InstallSinks {
            on_progress: |_: u64, _: Option<u64>| {},
            on_phase: |_: &str, _: bool| {},
            confirm_unverified: |_: UnverifiedConfirmationRequest| std::future::ready(Ok(true)),
        },
    )
    .await;

    let err = res.unwrap_err();
    assert!(
        errcode::has_code(&err, errcode::INCOMPLETE),
        "crash-reste müssen als incomplete gemeldet werden: {err}"
    );
    assert!(err.contains(steam_layout::EXTRACT_PREFIX), "err: {err}");
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
        InstallJob {
            steam_root: temp_dir.to_str().unwrap(),
            target_arch: TargetArch::X86_64,
            release_tag: "GE-Proton9-27",
            download_url: "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
            download_id: "dl-1",
            cache_dir: &cache_dir,
            cancel_flag: Arc::new(CancelSignal::new()),
            dialog_locale: DialogLocale::De,
            scope_ok: Arc::new(|_: &Path| false),
            environment: ExtractEnvironment::StaticScopeOnly,
        },
        InstallSinks {
            on_progress: |_: u64, _: Option<u64>| {},
            on_phase: |_: &str, _: bool| {},
            confirm_unverified: |_: UnverifiedConfirmationRequest| std::future::ready(Ok(true)),
        },
    )
    .await;

    assert!(
        res.is_err(),
        "unscoped steam_root muss abgewiesen werden: {res:?}"
    );
    assert!(res.unwrap_err().contains("blocked-location"));

    let _ = fs::remove_dir_all(&temp_dir);
}

// ---- FR-5: existenzprüfung ohne symlink-verfolgung ----

const GE_RELEASE_URL: &str = "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-5/GE-Proton11-5-x86_64.tar.gz";

fn ge_resolve(root: &Path) -> Result<GeInstallTargets, String> {
    resolve_ge_install_targets(
        root.to_str().unwrap(),
        TargetArch::X86_64,
        "GE-Proton11-5",
        GE_RELEASE_URL,
        "dl-1",
        &|_: &Path| true,
    )
}

/// `.exists()` folgt dem symlink und sah ein totes ziel als frei; der rename
/// hätte es verdrängt. Ein vorhandener eintrag bleibt ein vorhandener eintrag.
#[cfg(unix)]
#[test]
fn resolve_zaehlt_einen_toten_symlink_als_belegtes_ziel() {
    let root = std::env::temp_dir().join(format!("test-ge-dangling-{}", random_suffix()));
    let tools = root.join("compatibilitytools.d");
    fs::create_dir_all(&tools).unwrap();
    std::os::unix::fs::symlink(tools.join("fehlt"), tools.join(GE_NAME)).unwrap();

    let error = ge_resolve(&root).err().expect("fehler erwartet");

    assert!(errcode::has_code(&error, errcode::TOOL_EXISTS), "{error}");
    let _ = fs::remove_dir_all(&root);
}

/// EACCES beim stat des ziels ist keine abwesenheit. `0o400` lässt `read_dir`
/// zu und den stat des kindes scheitern, damit genau die zielprüfung greift.
#[cfg(unix)]
#[test]
fn resolve_meldet_eacces_des_zielpfads_als_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("test-ge-target-eacces-{}", random_suffix()));
    let tools = root.join("compatibilitytools.d");
    fs::create_dir_all(&tools).unwrap();
    fs::set_permissions(&tools, fs::Permissions::from_mode(0o400)).unwrap();
    let unreadable = fs::symlink_metadata(tools.join(GE_NAME)).is_err();

    let result = ge_resolve(&root);

    fs::set_permissions(&tools, fs::Permissions::from_mode(0o700)).unwrap();
    let _ = fs::remove_dir_all(&root);
    if !unreadable {
        // root umgeht den rechtecheck des kernels; der EACCES-fall ist dann
        // nicht herstellbar (derselbe guard wie in libraryfolders_tests).
        return;
    }
    let error = result.err().expect("fehler erwartet");
    assert!(errcode::has_code(&error, errcode::UNREADABLE), "{error}");
}

/// Ein unlesbares `compatibilitytools.d` ist ein fehler, nicht "keine reste".
/// Unter root macht ein selbstreferenz-symlink aus dem fall ein belegtes ELOOP.
#[cfg(unix)]
#[test]
fn resolve_meldet_eacces_des_toolverzeichnisses_als_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("test-ge-tools-eacces-{}", random_suffix()));
    let tools = root.join("compatibilitytools.d");
    fs::create_dir_all(&tools).unwrap();
    fs::set_permissions(&tools, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read_dir(&tools).is_ok() {
        fs::set_permissions(&tools, fs::Permissions::from_mode(0o700)).unwrap();
        fs::remove_dir(&tools).unwrap();
        std::os::unix::fs::symlink(&tools, &tools).unwrap();
    }

    let error = ge_resolve(&root).err().expect("fehler erwartet");

    assert!(errcode::has_code(&error, errcode::UNREADABLE), "{error}");
    assert!(
        error.contains("read compatibilitytools.d"),
        "read_dir-zweig nicht getroffen: {error}"
    );
    let _ = fs::set_permissions(&tools, fs::Permissions::from_mode(0o700));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn eintragsfehler_im_toolverzeichnis_wird_kodiert() {
    let error = leftover_name(Err(std::io::Error::from(
        std::io::ErrorKind::PermissionDenied,
    )))
    .unwrap_err();

    assert!(errcode::has_code(&error, errcode::UNREADABLE), "{error}");
}
