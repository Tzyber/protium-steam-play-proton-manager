use super::*;
use crate::commands::test_util::{production_source, wsg_fixture};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn orphan_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let root = wsg_fixture(tag);
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let steamapps = steam.join("steamapps");
    let compatdata = steamapps.join("compatdata/999999");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&compatdata).unwrap();

    let lf_vdf = format!(
        "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
        steam.display()
    );
    std::fs::write(config_dir.join("libraryfolders.vdf"), lf_vdf).unwrap();
    (root, steam)
}

fn orphan_request(steam: &std::path::Path) -> PrepareDeleteRequest {
    PrepareDeleteRequest {
        target_type: "orphan".to_string(),
        path: steam
            .join("steamapps/compatdata/999999")
            .to_str()
            .unwrap()
            .to_string(),
        steam_root: steam.to_str().unwrap().to_string(),
    }
}

/// Snapshot, der genau diese Wurzel als Steam-Root führt. Ersetzt das frühere
/// permissive Prädikat, damit die Root-Bindung aus F1 wirklich greift.
fn snapshot_for(steam_root: &std::path::Path) -> EnvironmentSnapshot {
    EnvironmentSnapshot::for_test(
        std::fs::canonicalize(steam_root).unwrap(),
        Vec::new(),
        Vec::new(),
        std::path::PathBuf::from("/nonexistent-cache"),
        std::path::PathBuf::from("/nonexistent-config"),
    )
}

fn prepare_with_snapshot(
    registry: &PendingDeleteRegistry,
    request: &PrepareDeleteRequest,
    is_steam_running_fn: impl Fn() -> Result<bool, String>,
) -> Result<PendingDeleteInfo, String> {
    let snapshot = snapshot_for(std::path::Path::new(&request.steam_root));
    prepare_delete_inner(registry, request, &snapshot, is_steam_running_fn)
}

fn execute_confirmed(
    registry: &PendingDeleteRegistry,
    token: &str,
    is_steam_running: impl Fn() -> Result<bool, String>,
) -> Result<DeleteResult, String> {
    execute_delete_pipeline(registry, token, &|_| true, is_steam_running)
}

fn execute_delete_after_inspection(
    registry: &PendingDeleteRegistry,
    token: &str,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    is_steam_running_fn: impl Fn() -> Result<bool, String>,
    before_claim_fn: impl FnOnce(),
) -> Result<DeleteResult, String> {
    execute_delete_pipeline_inner(
        registry,
        token,
        scope_ok,
        is_steam_running_fn,
        before_claim_fn,
        || {},
    )
}

/// Wie `execute_delete_after_inspection`, aber mit Haken zwischen Claim und
/// Identitätsprüfung des Claims.
fn execute_delete_after_claim(
    registry: &PendingDeleteRegistry,
    token: &str,
    after_claim_fn: impl FnOnce(),
) -> Result<DeleteResult, String> {
    execute_delete_pipeline_inner(
        registry,
        token,
        &|_| true,
        || Ok(false),
        || {},
        after_claim_fn,
    )
}

fn write_shortcuts_fixture(path: &std::path::Path, app_id: u32) {
    let mut bytes = vec![0x00];
    bytes.extend_from_slice(b"shortcuts\0");
    bytes.extend_from_slice(&[0x00]);
    bytes.extend_from_slice(b"0\0");
    bytes.extend_from_slice(&[0x02]);
    bytes.extend_from_slice(b"appid\0");
    bytes.extend_from_slice(&app_id.to_le_bytes());
    bytes.extend_from_slice(&[0x08, 0x08]);
    std::fs::write(path, bytes).unwrap();
}

#[test]
fn prepare_bindet_den_steam_root_exakt_an_den_snapshot() {
    // F1: die externe library ist autorisiert, aber nicht der steam-root. Mit
    // ihr als request-root läse die inspektion ein fremdes userdata, sähe die
    // shortcuts des echten roots nicht und hielte einen echten shortcut für
    // einen orphan. Der root-vergleich muss das vor der inspektion beenden.
    let (root, steam) = orphan_fixture("prepare-root-binding");
    let library = root.join("library-external");
    let target = library.join("steamapps/compatdata/999999");
    std::fs::create_dir_all(&target).unwrap();
    let shortcuts = steam.join("userdata/123/config");
    std::fs::create_dir_all(&shortcuts).unwrap();
    write_shortcuts_fixture(&shortcuts.join("shortcuts.vdf"), 999999);

    let snapshot = EnvironmentSnapshot::for_test(
        std::fs::canonicalize(&steam).unwrap(),
        vec![std::fs::canonicalize(&library).unwrap()],
        Vec::new(),
        std::path::PathBuf::from("/nonexistent-cache"),
        std::path::PathBuf::from("/nonexistent-config"),
    );
    let request = PrepareDeleteRequest {
        target_type: "orphan".to_string(),
        path: target.to_string_lossy().into_owned(),
        steam_root: library.to_string_lossy().into_owned(),
    };
    let registry = PendingDeleteRegistry::default();

    let error = prepare_delete_inner(&registry, &request, &snapshot, || Ok(false)).unwrap_err();

    assert!(
        error.contains("blocked-location"),
        "unexpected error: {error}"
    );
    assert!(
        error.contains("not the current environment root"),
        "unexpected error: {error}"
    );
    assert!(target.exists(), "nichts darf angefasst worden sein");

    // gegenprobe: derselbe fall mit dem echten root erreicht die inspektion
    // und wird dort als nicht-verwaister shortcut abgelehnt
    let honest = orphan_request(&steam);
    let error = prepare_delete_inner(&registry, &honest, &snapshot, || Ok(false)).unwrap_err();
    assert!(error.contains("not-an-orphan"), "unexpected error: {error}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn prepare_lehnt_einen_nicht_aufloesbaren_steam_root_ab() {
    let root = wsg_fixture("prepare-root-missing");
    let snapshot = snapshot_for(&root);
    let request = PrepareDeleteRequest {
        target_type: "orphan".to_string(),
        path: root
            .join("steamapps/compatdata/999999")
            .to_string_lossy()
            .into_owned(),
        steam_root: root.join("gibt-es-nicht").to_string_lossy().into_owned(),
    };

    let error = prepare_delete_inner(
        &PendingDeleteRegistry::default(),
        &request,
        &snapshot,
        || Ok(false),
    )
    .unwrap_err();

    assert!(error.contains("not-found"), "unexpected error: {error}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn token_generierung_ist_128_bit_hex() {
    let token1 = generate_os_random_128().unwrap();
    let token2 = generate_os_random_128().unwrap();
    assert_eq!(token1.len(), 32);
    assert_eq!(token2.len(), 32);
    assert_ne!(token1, token2);
    assert!(token1.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn tokenquelle_bleibt_plattformunabhaengig_und_os_gesichert() {
    let source = include_str!("delete_ops.rs");
    assert!(source.contains("getrandom::fill"));
    assert!(!source.contains(&["/dev/", "urandom"].concat()));
    assert!(!source.contains(&["cfg(", "not(unix))"].concat()));
    assert!(!source.contains(&["as_", "nanos"].concat()));
}

#[test]
fn destruktive_mutation_laueft_nur_ueber_claim() {
    let production = production_source(include_str!("delete_ops.rs"));
    assert!(production.contains("renameat2_no_replace"));
    assert!(!production.contains("fs::rename(&pending.canonical_path"));
    assert!(!production.contains("fs::remove_dir_all(&pending.canonical_path"));
}

fn collect_source_files(root: &std::path::Path, files: &mut Vec<(std::path::PathBuf, String)>) {
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_source_files(&path, files);
        } else if matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("rs" | "ts" | "vue")
        ) {
            files.push((path.clone(), std::fs::read_to_string(path).unwrap()));
        }
    }
}

#[test]
fn dialog_sicherheitsgrenze_bleibt_statisch_geschlossen() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut source_files = Vec::new();
    collect_source_files(&manifest_dir.join("src"), &mut source_files);
    collect_source_files(&manifest_dir.join("../src"), &mut source_files);

    let forbidden = [
        ["dialog", ":"].concat(),
        ["@tauri-apps/plugin-", "dialog"].concat(),
        ["zen", "ity"].concat(),
        ["k", "dialog"].concat(),
        ["PROTIUM", "_TEST_CONFIRM"].concat(),
    ];
    let capabilities =
        std::fs::read_to_string(manifest_dir.join("capabilities/default.json")).unwrap();
    assert!(!capabilities.contains(&forbidden[0]));
    for (path, content) in &source_files {
        for pattern in forbidden.iter().skip(1) {
            assert!(
                !content.contains(pattern),
                "forbidden dialog hook in {}",
                path.display()
            );
        }
    }

    let rust_plugin = ["tauri", "_plugin_", "dialog"].concat();
    let allowed = [
        manifest_dir.join("src/commands/ge_install.rs"),
        manifest_dir.join("src/lib.rs"),
    ];
    for (path, content) in source_files
        .iter()
        .filter(|(path, _)| path.extension().and_then(|ext| ext.to_str()) == Some("rs"))
    {
        if content.contains(&rust_plugin) {
            assert!(
                allowed.iter().any(|candidate| candidate == path),
                "dialog plugin outside delete adapter: {}",
                path.display()
            );
        }
    }
}

#[test]
fn produktionswrapper_bindet_nur_löschpipeline() {
    let source = production_source(include_str!("delete_ops.rs"));
    let start = source
        .find("pub async fn execute_delete(")
        .expect("tauri execute wrapper must exist");
    let command = &source[start..];
    assert!(command.contains("token: String"));
    assert!(command.contains("execute_delete_pipeline"));
    // die bestätigung kommt aus dem webview-dialog des hauptfensters; der
    // wrapper selbst darf nie bejahen oder fenster bauen.
    assert!(!command.contains("Ok(true)"));
    assert!(!command.contains("bool"));
    assert!(!command.contains("invoke"));
    assert!(!command.contains("webview"));
    assert!(!command.contains("confirm"));
    assert!(!command.contains("WebviewWindow"));
}

#[test]
fn prepare_und_execute_happy_path_und_replay_schutz() {
    let root = wsg_fixture("delete-ops-replay");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let steamapps = steam.join("steamapps");
    let compatdata = steamapps.join("compatdata/999999");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&compatdata).unwrap();

    let lf_vdf = format!(
        "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
        steam.display()
    );
    std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

    let registry = PendingDeleteRegistry::default();
    let req = PrepareDeleteRequest {
        target_type: "orphan".to_string(),
        path: compatdata.to_str().unwrap().to_string(),
        steam_root: steam.to_str().unwrap().to_string(),
    };

    // 1. Prepare
    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();
    assert_eq!(info.target_type, "orphan");
    assert_eq!(info.consequences.len(), 1);
    assert_eq!(info.consequences[0].action, "trash");

    // 2. Execute 1st time -> Erfolg ist ein Ok (kein bool-flag)
    let res = execute_delete_pipeline(&registry, &info.token, &|_| true, || Ok(false)).unwrap();
    assert_eq!(res.deleted_path, compatdata.to_string_lossy());
    assert!(!compatdata.exists());

    // N3: der orphan landet im papierkorb der gebundenen library, nicht daneben
    let trash_entries: Vec<String> = std::fs::read_dir(steamapps.join(".protium-trash"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(trash_entries.len(), 1);
    assert!(
        trash_entries[0].starts_with("compatdata_999999_"),
        "unerwarteter papierkorbeintrag: {trash_entries:?}"
    );

    // 3. Execute 2nd time (Replay) -> Fails with invalid token
    let res_replay = execute_delete_pipeline(&registry, &info.token, &|_| true, || Ok(false));
    assert!(res_replay.is_err());
    assert!(res_replay.unwrap_err().contains("invalid-id"));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn abgelaufenes_token_wird_abgelehnt() {
    let registry = PendingDeleteRegistry::default();
    let mut map = registry.0.lock().unwrap();
    let expired_pending = PendingDelete {
        created_at: 0,
        expires_at: 1000, // weit in der Vergangenheit
        target_type: "orphan".to_string(),
        target_path: "/tmp/foo".to_string(),
        canonical_path: PathBuf::from("/tmp/foo"),
        steam_root: PathBuf::from("/tmp/steam"),
        dev: 0,
        ino: 0,
        target_handle: None,
        parent_handle: None,
        target_name: None,
        consequences: vec![],
    };
    map.insert("expired123".to_string(), expired_pending);
    drop(map);

    let res = execute_delete_pipeline(&registry, "expired123", &|_| true, || Ok(false));
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("expired"));
}

#[test]
fn steam_laeuft_zwischen_prepare_und_execute_blockiert_loeschung() {
    let root = wsg_fixture("delete-ops-steam-running");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let steamapps = steam.join("steamapps");
    let compatdata = steamapps.join("compatdata/999999");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&compatdata).unwrap();

    let lf_vdf = format!(
        "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
        steam.display()
    );
    std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

    let registry = PendingDeleteRegistry::default();
    let req = PrepareDeleteRequest {
        target_type: "orphan".to_string(),
        path: compatdata.to_str().unwrap().to_string(),
        steam_root: steam.to_str().unwrap().to_string(),
    };

    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();

    // Steam läuft beim Execute -> Abbruch
    let res = execute_delete_pipeline(&registry, &info.token, &|_| true, || Ok(true));
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("steam-running"));
    assert!(compatdata.exists());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn registry_groesse_bleibt_auf_32_und_verdrängt_aeltesten() {
    let root = wsg_fixture("delete-ops-limit");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let steamapps = steam.join("steamapps");
    let compatdata = steamapps.join("compatdata/999999");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&compatdata).unwrap();

    let lf_vdf = format!(
        "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
        steam.display()
    );
    std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

    let registry = PendingDeleteRegistry::default();
    let mut map = registry.0.lock().unwrap();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    for i in 0..MAX_PENDING_DELETES {
        let token = format!("token_{i}");
        map.insert(
            token.clone(),
            PendingDelete {
                created_at: now_ms.saturating_sub(MAX_PENDING_DELETES as u64 - i as u64),
                expires_at: now_ms + 100_000,
                target_type: "orphan".to_string(),
                target_path: compatdata.to_str().unwrap().to_string(),
                canonical_path: compatdata.clone(),
                steam_root: steam.clone(),
                dev: 0,
                ino: 0,
                target_handle: None,
                parent_handle: None,
                target_name: None,
                consequences: vec![],
            },
        );
    }
    drop(map);

    let req = PrepareDeleteRequest {
        target_type: "orphan".to_string(),
        path: compatdata.to_str().unwrap().to_string(),
        steam_root: steam.to_str().unwrap().to_string(),
    };

    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();
    let map = registry.0.lock().unwrap();
    assert_eq!(map.len(), MAX_PENDING_DELETES);
    assert!(!map.contains_key("token_0"));
    assert!(map.contains_key(&info.token));
    let inserted = map.get(&info.token).unwrap();
    assert_eq!(
        inserted.expires_at - inserted.created_at,
        DELETE_TOKEN_TTL_SECS * 1000
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn ino_mismatch_oder_symlink_mutation_zwischen_prepare_und_execute_wird_abgelehnt() {
    let root = wsg_fixture("delete-ops-inode");
    let steam = root.join("steam");
    let config_dir = steam.join("config");
    let steamapps = steam.join("steamapps");
    let compatdata = steamapps.join("compatdata/999999");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&compatdata).unwrap();

    let lf_vdf = format!(
        "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
        steam.display()
    );
    std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

    let registry = PendingDeleteRegistry::default();
    let req = PrepareDeleteRequest {
        target_type: "orphan".to_string(),
        path: compatdata.to_str().unwrap().to_string(),
        steam_root: steam.to_str().unwrap().to_string(),
    };

    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();

    // Ersetze Ordner durch neuen Ordner (neues Inode)
    std::fs::remove_dir_all(&compatdata).unwrap();
    std::fs::create_dir_all(&compatdata).unwrap();

    // Simuliere deterministisch das auf Linux mögliche Inode-Recycling:
    // der neue Pfad bekommt absichtlich dieselbe gespeicherte `(dev, ino)`-
    // Identität. Eine reine Metadatenprüfung dürfte hier nicht löschen.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let replacement = std::fs::metadata(&compatdata).unwrap();
        let mut pending = registry.0.lock().unwrap();
        let entry = pending.get_mut(&info.token).unwrap();
        entry.dev = replacement.dev();
        entry.ino = replacement.ino();
    }

    let res = execute_delete_pipeline(&registry, &info.token, &|_| true, || Ok(false));
    let error = res.unwrap_err();
    assert!(
        error.contains("target-changed"),
        "unexpected error: {error}"
    );

    // Symlink mutation
    let info2 = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();
    std::fs::remove_dir_all(&compatdata).unwrap();
    let target_real = root.join("real");
    std::fs::create_dir_all(&target_real).unwrap();
    std::os::unix::fs::symlink(&target_real, &compatdata).unwrap();

    let res2 = execute_delete_pipeline(&registry, &info2.token, &|_| true, || Ok(false));
    assert!(res2.is_err());
    assert!(res2.unwrap_err().contains("symlink"));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn replacement_nach_letzter_inspektion_wird_vor_mutation_geclaimt_und_nicht_geloescht() {
    let (root, steam) = orphan_fixture("delete-ops-after-inspection-race");
    let registry = PendingDeleteRegistry::default();
    let req = orphan_request(&steam);
    let target = steam.join("steamapps/compatdata/999999");
    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();

    let result = execute_delete_after_inspection(
        &registry,
        &info.token,
        &|_| true,
        || Ok(false),
        || {
            std::fs::remove_dir_all(&target).unwrap();
            std::fs::create_dir_all(&target).unwrap();
            std::fs::write(target.join("replacement-marker"), b"must survive").unwrap();
        },
    );

    let error = result.unwrap_err();
    assert!(
        error.contains("target changed before mutation"),
        "error: {error}"
    );
    // das replacement wurde geclaimt, aber nicht gelöscht: der
    // claim-restore benennt es unbeschadet auf den originalnamen zurück.
    assert!(target.exists());
    assert!(target.join("replacement-marker").exists());
    assert!(!claim_leftovers(target.parent().unwrap()));
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn trash_revalidierung_lehnt_verschachteltes_ziel_vor_claim_ab() {
    let root = wsg_fixture("delete-ops-trash-boundary");
    let steam = root.join("steam");
    let trash_dir = steam.join("steamapps/.protium-trash");
    let target = trash_dir.join("compatdata_123_1700000000000");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("replacement-marker"), b"must survive").unwrap();

    let registry = PendingDeleteRegistry::default();
    let request = PrepareDeleteRequest {
        target_type: "trash".to_string(),
        path: target.to_string_lossy().into_owned(),
        steam_root: steam.to_string_lossy().into_owned(),
    };
    let info = prepare_with_snapshot(&registry, &request, || Ok(false)).unwrap();

    let nested_parent = trash_dir.join("nested");
    let nested_target = nested_parent.join("compatdata_123_1700000000000");
    std::fs::create_dir_all(&nested_parent).unwrap();
    std::fs::rename(&target, &nested_target).unwrap();

    {
        let mut pending = registry.0.lock().unwrap();
        let entry = pending.get_mut(&info.token).unwrap();
        entry.target_path = nested_target.to_string_lossy().into_owned();
        entry.canonical_path = nested_target.clone();
        entry.parent_handle = Some(open_delete_target_handle(&nested_parent).unwrap());
        entry.target_name = Some(nested_target.file_name().unwrap().to_os_string());
        entry.consequences[0].path = nested_target.to_string_lossy().into_owned();
    }

    let claim_called = Arc::new(AtomicBool::new(false));
    let claim_called_for_hook = Arc::clone(&claim_called);
    let result = execute_delete_after_inspection(
        &registry,
        &info.token,
        &|_| true,
        || Ok(false),
        move || {
            claim_called_for_hook.store(true, Ordering::SeqCst);
        },
    );
    let error = result.unwrap_err();
    // A-04: die ablehnung eines verschachtelten ziels trägt jetzt ihren code
    // statt des rohtexts ("must be a direct child of .protium-trash").
    assert!(
        errcode::has_code(&error, errcode::NOT_AN_ORPHAN),
        "error: {error}"
    );
    assert!(!claim_called.load(Ordering::SeqCst));
    assert!(nested_target.join("replacement-marker").exists());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn neues_gueltiges_manifest_zwischen_prepare_und_execute_blockiert_orphan_delete() {
    let (root, steam) = orphan_fixture("delete-ops-live-manifest-valid");
    let registry = PendingDeleteRegistry::default();
    let req = orphan_request(&steam);
    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();

    std::fs::write(
        steam.join("steamapps/appmanifest_999999.acf"),
        "\"AppState\"\n{\n\t\"appid\"\t\t\"999999\"\n}\n",
    )
    .unwrap();

    let result = execute_confirmed(&registry, &info.token, || Ok(false));
    assert!(
        result.is_err(),
        "live manifest must block stale orphan delete"
    );
    assert!(steam.join("steamapps/compatdata/999999").exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn neues_unlesbares_manifest_zwischen_prepare_und_execute_blockiert_fail_closed() {
    let (root, steam) = orphan_fixture("delete-ops-live-manifest-unreadable");
    let registry = PendingDeleteRegistry::default();
    let req = orphan_request(&steam);
    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();

    std::fs::create_dir(steam.join("steamapps/appmanifest_999999.acf")).unwrap();

    let result = execute_confirmed(&registry, &info.token, || Ok(false));
    assert!(result.is_err(), "unreadable manifest must block deletion");
    assert!(steam.join("steamapps/compatdata/999999").exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn neues_defektes_manifest_zwischen_prepare_und_execute_blockiert_fail_closed() {
    let (root, steam) = orphan_fixture("delete-ops-live-manifest-broken");
    let registry = PendingDeleteRegistry::default();
    let req = orphan_request(&steam);
    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();

    std::fs::write(
        steam.join("steamapps/appmanifest_999999.acf"),
        "\"AppState\" { \"appid\" \"999999\"",
    )
    .unwrap();

    let result = execute_confirmed(&registry, &info.token, || Ok(false));
    assert!(result.is_err(), "broken manifest must block deletion");
    assert!(steam.join("steamapps/compatdata/999999").exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn neues_dateiname_appid_inkonsistentes_manifest_blockiert_fail_closed() {
    let (root, steam) = orphan_fixture("delete-ops-live-manifest-mismatch");
    let registry = PendingDeleteRegistry::default();
    let req = orphan_request(&steam);
    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();

    std::fs::write(
        steam.join("steamapps/appmanifest_999999.acf"),
        "\"AppState\"\n{\n\t\"appid\"\t\t\"570\"\n}\n",
    )
    .unwrap();

    let result = execute_confirmed(&registry, &info.token, || Ok(false));
    assert!(
        result.is_err(),
        "manifest identity drift must block deletion"
    );
    assert!(steam.join("steamapps/compatdata/999999").exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn delete_prepare_erlaubt_non_steam_shortcut_appid() {
    // bit-31-appids (non-steam-shortcuts) sind legitime u32-ids:
    // compatdata/<id> kann sein, darf der orphan-pfad nicht ablehnen.
    let root = wsg_fixture("delete-appid-non-steam");
    let steam = root.join("steam");
    let target = steam.join("steamapps/compatdata/2207218128");
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
    let request = PrepareDeleteRequest {
        target_type: "orphan".to_string(),
        path: target.to_string_lossy().into_owned(),
        steam_root: steam.to_string_lossy().into_owned(),
    };

    let result = prepare_with_snapshot(&PendingDeleteRegistry::default(), &request, || Ok(false));
    assert!(
        result.is_ok(),
        "delete darf bit-31-appids nicht ablehnen: {:?}",
        result.err()
    );
    assert!(target.exists()); // prepare löscht noch nicht

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn neuer_non_steam_shortcut_zwischen_prepare_und_execute_blockiert_orphan_delete() {
    let (root, steam) = orphan_fixture("delete-ops-live-shortcut");
    let registry = PendingDeleteRegistry::default();
    let req = orphan_request(&steam);
    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();

    let shortcuts = steam.join("userdata/123/config");
    std::fs::create_dir_all(&shortcuts).unwrap();
    write_shortcuts_fixture(&shortcuts.join("shortcuts.vdf"), 999999);

    let result = execute_confirmed(&registry, &info.token, || Ok(false));
    assert!(result.is_err(), "new shortcut must block orphan deletion");
    assert!(steam.join("steamapps/compatdata/999999").exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn manifest_replacement_nach_openat_in_prepare_wird_vor_execute_erkannt() {
    let (root, steam) = orphan_fixture("delete-ops-manifest-after-openat");
    let target = steam.join("steamapps/compatdata/999999");
    let manifest = steam.join("steamapps/appmanifest_570.acf");
    std::fs::write(&manifest, "\"AppState\" { \"appid\" \"570\" }").unwrap();
    let replacement = manifest.clone();
    let mut hook = move |stage, _: Option<&mut std::fs::File>| {
        if stage == crate::commands::delete_inspect::DeleteReadStage::ManifestAfterOpen {
            std::fs::rename(&replacement, replacement.with_extension("bound")).unwrap();
            std::fs::write(&replacement, "\"AppState\" { \"appid\" \"999999\" }").unwrap();
        }
    };

    let registry = PendingDeleteRegistry::default();
    let info = prepare_delete_inner_with_hook(
        &registry,
        &orphan_request(&steam),
        &|_| true,
        || Ok(false),
        &mut hook,
    )
    .unwrap();

    assert!(execute_confirmed(&registry, &info.token, || Ok(false)).is_err());
    assert!(target.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn shortcut_replacement_nach_openat_in_prepare_wird_vor_execute_erkannt() {
    let (root, steam) = orphan_fixture("delete-ops-shortcut-after-openat");
    let target = steam.join("steamapps/compatdata/999999");
    let shortcuts = steam.join("userdata/123/config/shortcuts.vdf");
    std::fs::create_dir_all(shortcuts.parent().unwrap()).unwrap();
    write_shortcuts_fixture(&shortcuts, 42);
    let replacement = shortcuts.clone();
    let mut hook = move |stage, _: Option<&mut std::fs::File>| {
        if stage == crate::commands::delete_inspect::DeleteReadStage::ShortcutsAfterOpen {
            std::fs::rename(&replacement, replacement.with_extension("bound")).unwrap();
            write_shortcuts_fixture(&replacement, 999999);
        }
    };

    let registry = PendingDeleteRegistry::default();
    let info = prepare_delete_inner_with_hook(
        &registry,
        &orphan_request(&steam),
        &|_| true,
        || Ok(false),
        &mut hook,
    )
    .unwrap();

    assert!(execute_confirmed(&registry, &info.token, || Ok(false)).is_err());
    assert!(target.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn neue_gueltige_compat_mapping_aendert_folgen_und_blockiert_delete() {
    let root = wsg_fixture("delete-ops-live-compat-valid");
    let steam = root.join("steam");
    let target = steam.join("compatibilitytools.d/GE-Proton9-27");
    std::fs::create_dir_all(&target).unwrap();
    let registry = PendingDeleteRegistry::default();
    let request = PrepareDeleteRequest {
        target_type: "compatTool".to_string(),
        path: target.to_str().unwrap().to_string(),
        steam_root: steam.to_str().unwrap().to_string(),
    };
    let info = prepare_with_snapshot(&registry, &request, || Ok(false)).unwrap();

    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::write(
        steam.join("config/config.vdf"),
        "\"InstallConfigStore\" { \"Software\" { \"Valve\" { \"Steam\" { \"CompatToolMapping\" { \"620\" { \"name\" \"GE-Proton9-27\" } } } } } }",
    )
    .unwrap();

    let result = execute_confirmed(&registry, &info.token, || Ok(false));
    assert!(
        result.is_err(),
        "changed compat consequences must block delete"
    );
    assert!(target.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn config_replacement_nach_openat_in_prepare_wird_vor_execute_erkannt() {
    let root = wsg_fixture("delete-ops-config-after-openat");
    let steam = root.join("steam");
    let target = steam.join("compatibilitytools.d/GE-Proton9-27");
    let config = steam.join("config/config.vdf");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(
        &config,
        "\"InstallConfigStore\" { \"Software\" { \"Valve\" { \"Steam\" { \"CompatToolMapping\" { \"620\" { \"name\" \"Other\" } } } } } }",
    )
    .unwrap();
    let replacement = config.clone();
    let mut hook = move |stage, _: Option<&mut std::fs::File>| {
        if stage == crate::commands::delete_inspect::DeleteReadStage::ConfigAfterOpen {
            std::fs::rename(&replacement, replacement.with_extension("bound")).unwrap();
            std::fs::write(
                &replacement,
                "\"InstallConfigStore\" { \"Software\" { \"Valve\" { \"Steam\" { \"CompatToolMapping\" { \"620\" { \"name\" \"GE-Proton9-27\" } } } } } }",
            )
            .unwrap();
        }
    };
    let request = PrepareDeleteRequest {
        target_type: "compatTool".to_string(),
        path: target.to_string_lossy().into_owned(),
        steam_root: steam.to_string_lossy().into_owned(),
    };

    let registry = PendingDeleteRegistry::default();
    let info =
        prepare_delete_inner_with_hook(&registry, &request, &|_| true, || Ok(false), &mut hook)
            .unwrap();

    assert!(execute_confirmed(&registry, &info.token, || Ok(false)).is_err());
    assert!(target.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn neue_unlesbare_compat_config_blockiert_fail_closed() {
    let root = wsg_fixture("delete-ops-live-compat-unreadable");
    let steam = root.join("steam");
    let target = steam.join("compatibilitytools.d/GE-Proton9-27");
    std::fs::create_dir_all(&target).unwrap();
    let registry = PendingDeleteRegistry::default();
    let request = PrepareDeleteRequest {
        target_type: "compatTool".to_string(),
        path: target.to_str().unwrap().to_string(),
        steam_root: steam.to_str().unwrap().to_string(),
    };
    let info = prepare_with_snapshot(&registry, &request, || Ok(false)).unwrap();

    std::fs::create_dir_all(steam.join("config/config.vdf")).unwrap();

    let result = execute_confirmed(&registry, &info.token, || Ok(false));
    assert!(
        result.is_err(),
        "unreadable compat config must block delete"
    );
    assert!(target.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn neue_defekte_compat_config_blockiert_fail_closed() {
    let root = wsg_fixture("delete-ops-live-compat-broken");
    let steam = root.join("steam");
    let target = steam.join("compatibilitytools.d/GE-Proton9-27");
    std::fs::create_dir_all(&target).unwrap();
    let registry = PendingDeleteRegistry::default();
    let request = PrepareDeleteRequest {
        target_type: "compatTool".to_string(),
        path: target.to_str().unwrap().to_string(),
        steam_root: steam.to_str().unwrap().to_string(),
    };
    let info = prepare_with_snapshot(&registry, &request, || Ok(false)).unwrap();

    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::write(steam.join("config/config.vdf"), "\"broken\" {").unwrap();

    let result = execute_confirmed(&registry, &info.token, || Ok(false));
    let error = match result {
        Ok(_) => panic!("broken compat config must block delete"),
        Err(error) => error,
    };
    // Pin (heute grün): der fehler aus dem eintrags-scanner trägt seinen code
    // bereits im leitfeld. Die lücke sitzt im tokenizer-zweig, der eigene test
    // steht direkt darunter.
    assert!(
        errcode::has_code(&error, errcode::UNREADABLE),
        "unerwarteter fehler: {error}"
    );
    assert!(target.exists());
    let _ = std::fs::remove_dir_all(root);
}

/// Producer 7 (A-04): der tokenizer-fehler trug `unreadable` bereits, wurde aber
/// mit einem rohtext-kontext verdeckt (`cannot tokenize config.vdf: …`), sodass
/// die oberfläche nur „unbekannt" sah. Der fall oben läuft über den scanner
/// (`unbalanced braces`), dieser über den tokenizer.
#[cfg(target_os = "linux")]
#[test]
fn unterminierte_compat_config_traegt_den_io_code() {
    let root = wsg_fixture("delete-ops-live-compat-unterminated");
    let steam = root.join("steam");
    let target = steam.join("compatibilitytools.d/GE-Proton9-27");
    std::fs::create_dir_all(&target).unwrap();
    let registry = PendingDeleteRegistry::default();
    let request = PrepareDeleteRequest {
        target_type: "compatTool".to_string(),
        path: target.to_str().unwrap().to_string(),
        steam_root: steam.to_str().unwrap().to_string(),
    };
    let info = prepare_with_snapshot(&registry, &request, || Ok(false)).unwrap();

    std::fs::create_dir_all(steam.join("config")).unwrap();
    std::fs::write(steam.join("config/config.vdf"), "\"unterminated").unwrap();

    let error = match execute_confirmed(&registry, &info.token, || Ok(false)) {
        Ok(_) => panic!("unterminated compat config must block delete"),
        Err(error) => error,
    };
    assert!(
        errcode::has_code(&error, errcode::UNREADABLE),
        "unerwarteter fehler: {error}"
    );
    assert!(target.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn steam_start_zwischen_den_checks_blockiert_mutation() {
    let (root, steam) = orphan_fixture("delete-ops-live-steam-race");
    let registry = PendingDeleteRegistry::default();
    let req = orphan_request(&steam);
    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();
    // erster steam-check: läuft nicht; zweiter: läuft, die pipeline
    // prüft zweimal (vor und nach der inspection), der start zwischen
    // den checks muss die mutation blockieren.
    let checks = Arc::new(AtomicUsize::new(0));
    let check_run = Arc::clone(&checks);
    let result = execute_delete_pipeline(&registry, &info.token, &|_| true, move || {
        Ok(check_run.fetch_add(1, Ordering::SeqCst) == 1)
    });
    assert!(
        result.is_err(),
        "steam start between checks must block mutation"
    );
    assert!(steam.join("steamapps/compatdata/999999").exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn live_aenderung_zwischen_checks_wird_unmittelbar_vor_mutation_erkannt() {
    let (root, steam) = orphan_fixture("delete-ops-live-dialog-change");
    let registry = PendingDeleteRegistry::default();
    let req = orphan_request(&steam);
    let info = prepare_with_snapshot(&registry, &req, || Ok(false)).unwrap();
    let manifest_path = steam.join("steamapps/appmanifest_999999.acf");
    // die änderung passiert im ersten steam-check (zwischen erster und
    // zweiter inspection): die zweite inspection muss sie sehen.
    let written = Arc::new(AtomicBool::new(false));
    let write_done = Arc::clone(&written);
    let result = execute_delete_pipeline(&registry, &info.token, &|_| true, move || {
        if !write_done.swap(true, Ordering::SeqCst) {
            std::fs::write(
                &manifest_path,
                "\"AppState\"\n{\n\t\"appid\"\t\t\"999999\"\n}\n",
            )
            .unwrap();
        }
        Ok(false)
    });
    assert!(
        result.is_err(),
        "live drift between checks must block mutation"
    );
    assert!(steam.join("steamapps/compatdata/999999").exists());
    let _ = std::fs::remove_dir_all(root);
}

/// Regression: Scheitert die Mutation NACH dem Claim, muss das Ziel unter
/// seinem Originalnamen zurückkommen. Fehlerinjektion ohne Rechtetricks
/// (läuft damit auch als root): `.protium-trash` liegt als reguläre Datei
/// im Weg, `create_dir_all` scheitert deterministisch.
#[cfg(target_os = "linux")]
#[test]
fn fehlgeschlagene_mutation_stellt_originalnamen_wieder_her() {
    let (root, steam) = orphan_fixture("delete-ops-restore-after-failure");
    let target = steam.join("steamapps/compatdata/999999");
    std::fs::write(target.join("savegame-marker"), b"must survive").unwrap();
    std::fs::write(steam.join("steamapps/.protium-trash"), b"blockiert").unwrap();

    let registry = PendingDeleteRegistry::default();
    let info = prepare_with_snapshot(&registry, &orphan_request(&steam), || Ok(false)).unwrap();

    let error =
        execute_delete_pipeline(&registry, &info.token, &|_| true, || Ok(false)).unwrap_err();
    assert!(error.contains("cannot create trash dir"), "error: {error}");

    assert!(
        target.exists(),
        "Ziel muss unter dem Originalnamen zurück sein"
    );
    assert!(target.join("savegame-marker").exists());
    assert!(
        !claim_leftovers(target.parent().unwrap()),
        "kein .protium-delete-claim-* darf zurückbleiben"
    );

    let _ = std::fs::remove_dir_all(root);
}

/// Review C: der Claim-Name ist im Verzeichnis sichtbar. Wird er zwischen
/// Claim und Mutation durch ein gleichnamiges Fremdverzeichnis ersetzt, muss
/// die Identitaetspruefung fail-closed enden, der Ersatz bleibt erhalten.
#[cfg(target_os = "linux")]
#[test]
fn claim_identitaet_wird_unmittelbar_vor_der_mutation_geprueft() {
    let (root, steam) = orphan_fixture("delete-ops-claim-identity");
    let target = steam.join("steamapps/compatdata/999999");
    std::fs::write(target.join("savegame-marker"), b"must survive").unwrap();
    let parent = target.parent().unwrap().to_path_buf();

    let registry = PendingDeleteRegistry::default();
    let info = prepare_with_snapshot(&registry, &orphan_request(&steam), || Ok(false)).unwrap();

    // im fenster nach dem claim: das geclaimte verzeichnis beiseite schieben und
    // ein gleichnamiges fremdverzeichnis an seine stelle setzen
    let swap_parent = parent.clone();
    let claim_path = Arc::new(Mutex::new(None));
    let claim_path_for_hook = Arc::clone(&claim_path);
    let result = execute_delete_after_claim(&registry, &info.token, move || {
        let entry = std::fs::read_dir(&swap_parent)
            .unwrap()
            .map(|entry| entry.unwrap())
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".protium-delete-claim-")
            })
            .expect("claim-verzeichnis fehlt");
        let path = entry.path();
        *claim_path_for_hook.lock().unwrap() = Some(path.clone());
        std::fs::rename(&path, swap_parent.join("beiseite")).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("fremd-marker"), b"fremd").unwrap();
    });

    assert!(
        result.unwrap_err().contains("target-changed"),
        "der ersetzte claim muss abgelehnt werden"
    );

    // nichts wurde geloescht: der fremde marker liegt noch da, entweder unter
    // dem claim-namen oder unter dem originalnamen (der restore-guard benennt
    // best effort zurueck und ueberschreibt dabei nichts)
    let original_path = parent.join("999999");
    let foreign_marker = claim_path
        .lock()
        .unwrap()
        .clone()
        .expect("claim-pfad wurde nicht gesehen");
    assert!(
        foreign_marker.join("fremd-marker").exists() || original_path.join("fremd-marker").exists(),
        "der fremde ersatz darf nicht geloescht werden"
    );
    assert!(
        parent.join("beiseite").join("savegame-marker").exists(),
        "das echte ziel muss erhalten bleiben"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// N3: der library-parent wird im bindefenster ausgetauscht. Die kette
/// library, steamapps, papierkorb muss fail-closed enden und darf im fremden
/// verzeichnis keinen papierkorb anlegen.
#[cfg(target_os = "linux")]
#[test]
fn trash_anlage_bleibt_an_die_gebundene_library_gebunden() {
    let root = wsg_fixture("delete-ops-trash-binding");
    let library = root.join("steam");
    std::fs::create_dir_all(library.join("steamapps")).unwrap();
    let moved = root.join("echte-library");
    let fremd = root.join("fremd");
    std::fs::create_dir_all(&fremd).unwrap();

    let (swap_library, swap_moved, swap_fremd) = (library.clone(), moved.clone(), fremd.clone());
    let mut hook = move || {
        std::fs::rename(&swap_library, &swap_moved).unwrap();
        std::os::unix::fs::symlink(&swap_fremd, &swap_library).unwrap();
    };

    let error = open_trash_dir(Path::new(&library), &mut hook).unwrap_err();

    assert!(error.contains("descriptor open"), "error: {error}");
    assert!(
        !fremd.join("steamapps").join(TRASH_DIR_NAME).exists(),
        "im fremden verzeichnis darf kein papierkorb entstehen"
    );
    assert!(
        !moved.join("steamapps").join(TRASH_DIR_NAME).exists(),
        "der papierkorb entsteht erst im gebundenen verzeichnis, hier gar nicht"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// Regression: Wird zwischen letzter Inspektion und Claim ein Replacement
/// untergeschoben, claimt Protium es und erkennt den Identity-Mismatch.
/// Der Claim-Restore benennt das Replacement best-effort per NOREPLACE auf
/// den Originalnamen zurück, fremde Daten bleiben am sichtbaren Ort
/// statt unter .protium-delete-claim-*.
#[cfg(target_os = "linux")]
#[test]
fn claim_mismatch_benennt_replacement_zurueck() {
    let (root, steam) = orphan_fixture("delete-ops-restore-replacement");
    let target = steam.join("steamapps/compatdata/999999");
    let registry = PendingDeleteRegistry::default();
    let info = prepare_with_snapshot(&registry, &orphan_request(&steam), || Ok(false)).unwrap();

    let error = execute_delete_after_inspection(
        &registry,
        &info.token,
        &|_| true,
        || Ok(false),
        || {
            std::fs::remove_dir_all(&target).unwrap();
            std::fs::create_dir_all(&target).unwrap();
            std::fs::write(target.join("replacement-marker"), b"must survive").unwrap();
        },
    )
    .unwrap_err();

    assert!(
        error.contains("target changed before mutation"),
        "error: {error}"
    );
    assert!(
        errcode::has_code(&error, errcode::TARGET_CHANGED),
        "unerwarteter fehler: {error}"
    );
    assert!(
        target.exists(),
        "Replacement muss am Originalnamen zurück sein"
    );
    assert!(target.join("replacement-marker").exists());
    assert!(
        !claim_leftovers(target.parent().unwrap()),
        "kein .protium-delete-claim-* darf zurückbleiben"
    );

    let _ = std::fs::remove_dir_all(root);
}

/// Fall 2: Ist der Originalname beim Restore-Versuch erneut belegt, darf
/// NOREPLACE nichts überschreiben: das neue Original bleibt unberührt,
/// der Claim-Rest bleibt liegen und wird später vom Cleanup erkannt.
#[cfg(target_os = "linux")]
#[test]
fn claim_restore_ueberschreibt_neues_original_nicht() {
    let (root, steam) = orphan_fixture("delete-ops-restore-blocked");
    let target = steam.join("steamapps/compatdata/999999");
    let registry = PendingDeleteRegistry::default();
    let info = prepare_with_snapshot(&registry, &orphan_request(&steam), || Ok(false)).unwrap();
    let registry_guard = registry.0.lock().unwrap();
    let pending = registry_guard.get(&info.token).unwrap();
    let claim = claim_delete_target(pending).unwrap();

    // originalnamen erneut belegen, bevor der restore zurückbenennen will
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("new-marker"), b"must survive").unwrap();

    drop(ClaimRestoreGuard {
        parent: pending.parent_handle.as_ref().unwrap(),
        claim_name: claim.name.as_os_str(),
        original_name: pending.target_name.as_deref().unwrap(),
        armed: true,
    });

    assert!(
        target.join("new-marker").exists(),
        "neu entstandener Originalpfad muss unberührt bleiben"
    );
    assert!(
        claim_leftovers(target.parent().unwrap()),
        "claim-rest muss liegen bleiben, wenn der originalname belegt ist"
    );

    let _ = std::fs::remove_dir_all(root);
}

fn claim_leftovers(dir: &std::path::Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(".protium-delete-claim-"))
            })
        })
        .unwrap_or(false)
}

#[test]
fn rename_mutationen_synchronisieren_quell_und_zielverzeichnis() {
    // r-08: papierkorb-move und claim-restore brauchen nach der mutation ein
    // verzeichnis-fsync. die fsync-fehlerpfade sind ohne injektionshaken nicht
    // testbar (prüflücke); dieser statische beleg fällt beim verlust der
    // syncs auf.
    let production = production_source(include_str!("delete_ops.rs"));

    let trash_move = production
        .find("cannot move to trash")
        .expect("papierkorb-move muss vorhanden sein");
    let target_sync = production[trash_move..]
        .find("sync_dir_fd(trash_parent.as_raw_fd())")
        .map(|offset| trash_move + offset)
        .expect("papierkorb-move braucht ein ziel-verzeichnis-fsync");
    let source_sync = production[trash_move..]
        .find("sync_dir_fd(source_parent.as_raw_fd())")
        .map(|offset| trash_move + offset)
        .expect("papierkorb-move braucht ein quell-verzeichnis-fsync");
    assert!(
        target_sync < source_sync,
        "zielverzeichnis muss vor dem quellverzeichnis synchronisiert werden"
    );

    let restore = production
        .find("impl Drop for ClaimRestoreGuard")
        .expect("claim-restore muss vorhanden sein");
    let drop_body = &production[restore..];
    let drop_end = drop_body
        .find("\n    }")
        .expect("claim-restore braucht einen funktionskörper");
    assert!(
        drop_body[..drop_end].contains("sync_dir_fd(self.parent.as_raw_fd())"),
        "claim-restore braucht ein verzeichnis-fsync im rückweg"
    );
}
