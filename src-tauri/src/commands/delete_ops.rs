// Interne Delete-Operationen und Replay-Schutz (Paket 19 / S-06b / S-06c).
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::commands::steam::{inspect_deletion_target, DeleteConsequence};

pub const DELETE_TOKEN_TTL_SECS: u64 = 60;
pub const MAX_PENDING_DELETES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfirmationKind {
    Warning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfirmationButtons {
    OkCancel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfirmationRequest {
    title: String,
    message: String,
    kind: ConfirmationKind,
    buttons: ConfirmationButtons,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDeleteRequest {
    pub target_type: String, // "orphan" | "trash" | "compatTool"
    pub path: String,
    pub steam_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeleteInfo {
    pub token: String,
    pub expires_at: u64,
    pub target_type: String,
    pub target_path: String,
    pub consequences: Vec<DeleteConsequence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub success: bool,
    pub deleted_path: String,
}

#[derive(Debug, Clone)]
pub struct PendingDelete {
    pub created_at: u64,
    pub expires_at: u64,
    pub target_type: String,
    pub target_path: String,
    pub canonical_path: PathBuf,
    pub steam_root: PathBuf,
    pub dev: u64,
    pub ino: u64,
    pub consequences: Vec<DeleteConsequence>,
}

#[derive(Default, Clone)]
pub struct PendingDeleteRegistry(pub Arc<Mutex<HashMap<String, PendingDelete>>>);

pub(super) fn generate_os_random_128() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("cannot read OS CSPRNG: {e}"))?;
    let mut hex = String::with_capacity(32);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", b);
    }
    Ok(hex)
}

pub(super) fn prepare_delete_inner(
    registry: &PendingDeleteRegistry,
    request: &PrepareDeleteRequest,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    is_steam_running_fn: impl Fn() -> Result<bool, String>,
) -> Result<PendingDeleteInfo, String> {
    let steam_running = is_steam_running_fn()?;
    if request.target_type != "trash" && steam_running {
        return Err("steam is running, deletion refused".into());
    }

    let inspection = inspect_deletion_target(
        &request.steam_root,
        &request.target_type,
        &request.path,
        scope_ok,
    )?;

    let token = generate_os_random_128()?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let expires_at = now_ms + DELETE_TOKEN_TTL_SECS * 1000;

    let pending = PendingDelete {
        created_at: now_ms,
        expires_at,
        target_type: request.target_type.clone(),
        target_path: request.path.clone(),
        canonical_path: PathBuf::from(&inspection.canonical_path),
        steam_root: PathBuf::from(&request.steam_root),
        dev: inspection.dev,
        ino: inspection.ino,
        consequences: inspection.consequences.clone(),
    };

    let mut map = registry
        .0
        .lock()
        .map_err(|e| format!("mutex lock error: {e}"))?;

    map.retain(|_, v| v.expires_at > now_ms);

    if map.len() >= MAX_PENDING_DELETES {
        let oldest_token = map
            .iter()
            .min_by(|(token_a, a), (token_b, b)| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| token_a.cmp(token_b))
            })
            .map(|(token, _)| token.clone())
            .ok_or_else(|| "pending deletion registry is unexpectedly empty".to_string())?;
        map.remove(&oldest_token);
    }

    map.insert(token.clone(), pending);

    Ok(PendingDeleteInfo {
        token,
        expires_at,
        target_type: request.target_type.clone(),
        target_path: request.path.clone(),
        consequences: inspection.consequences,
    })
}

pub(crate) fn execute_delete_with_confirmation(
    registry: &PendingDeleteRegistry,
    token: &str,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    is_steam_running_fn: impl Fn() -> Result<bool, String>,
    confirm_fn: impl FnOnce(&PendingDelete) -> Result<bool, String>,
) -> Result<DeleteResult, String> {
    let pending = {
        let mut map = registry
            .0
            .lock()
            .map_err(|e| format!("mutex lock error: {e}"))?;
        map.remove(token)
            .ok_or_else(|| "invalid deletion token".to_string())?
    };

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if now_ms > pending.expires_at {
        return Err("deletion token expired".into());
    }

    let steam_running = is_steam_running_fn()?;
    if pending.target_type != "trash" && steam_running {
        return Err("steam is running, deletion refused".into());
    }

    inspect_pending_target(&pending, scope_ok)?;

    let confirmed = confirm_fn(&pending)?;
    if !confirmed {
        return Ok(DeleteResult {
            success: false,
            deleted_path: pending.target_path,
        });
    }

    let steam_running = is_steam_running_fn()?;
    if pending.target_type != "trash" && steam_running {
        return Err("steam is running, deletion refused".into());
    }

    inspect_pending_target(&pending, scope_ok)?;

    match pending.target_type.as_str() {
        "orphan" => {
            let canon_str = pending.canonical_path.to_string_lossy();
            let suffix = crate::commands::scope::suffix_after_steamapps(&canon_str)?;
            let (typ, app_id_str) = crate::commands::scope::parse_compat_id(
                suffix
                    .split_once('/')
                    .ok_or_else(|| "invalid suffix structure".to_string())?,
            )?;
            match typ {
                "shadercache" => {
                    fs::remove_dir_all(&pending.canonical_path)
                        .map_err(|e| format!("cannot remove shadercache: {e}"))?;
                }
                "compatdata" => {
                    let lib_str = crate::commands::scope::library_of(&canon_str)?;
                    let trash_dir = Path::new(lib_str).join("steamapps").join(".protium-trash");
                    fs::create_dir_all(&trash_dir)
                        .map_err(|e| format!("cannot create trash dir: {e}"))?;
                    let trash_name = format!("compatdata_{app_id_str}_{now_ms}");
                    let trash_target = trash_dir.join(&trash_name);
                    fs::rename(&pending.canonical_path, &trash_target)
                        .map_err(|e| format!("cannot move to trash: {e}"))?;
                }
                _ => return Err("unsupported orphan type".into()),
            }
        }
        "trash" => {
            fs::remove_dir_all(&pending.canonical_path)
                .map_err(|e| format!("cannot remove trash item: {e}"))?;
        }
        "compatTool" => {
            fs::remove_dir_all(&pending.canonical_path)
                .map_err(|e| format!("cannot remove compat tool: {e}"))?;
        }
        _ => return Err(format!("unknown target type: {}", pending.target_type)),
    }

    Ok(DeleteResult {
        success: true,
        deleted_path: pending.target_path,
    })
}

fn confirmation_request(pending: &PendingDelete) -> ConfirmationRequest {
    let title = "Protium: Löschung bestätigen";
    let mut msg = String::new();
    for c in &pending.consequences {
        msg.push_str(&format!("• {}\n  Pfad: {}\n", c.description, c.path));
        if let Some(apps) = &c.affected_app_ids {
            let apps_str: Vec<String> = apps.iter().map(|a| a.to_string()).collect();
            msg.push_str(&format!(
                "  Betroffene Spiele (App-IDs): {}\n",
                apps_str.join(", ")
            ));
        }
    }
    msg.push_str("\nMöchten Sie diese Aktion wirklich unwiderruflich ausführen?");

    ConfirmationRequest {
        title: title.to_string(),
        message: msg,
        kind: ConfirmationKind::Warning,
        buttons: ConfirmationButtons::OkCancel,
    }
}

fn confirm_pending_delete(
    pending: &PendingDelete,
    show: impl FnOnce(ConfirmationRequest) -> Result<bool, String>,
) -> Result<bool, String> {
    show(confirmation_request(pending))
}

fn show_native_confirmation_dialog(
    app: &tauri::AppHandle,
    pending: &PendingDelete,
) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    confirm_pending_delete(pending, |request| {
        Ok(app
            .dialog()
            .message(&request.message)
            .title(&request.title)
            .kind(match request.kind {
                ConfirmationKind::Warning => MessageDialogKind::Warning,
            })
            .buttons(match request.buttons {
                ConfirmationButtons::OkCancel => MessageDialogButtons::OkCancel,
            })
            .blocking_show())
    })
}

fn inspect_pending_target(
    pending: &PendingDelete,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
) -> Result<(), String> {
    let steam_root = pending
        .steam_root
        .to_str()
        .ok_or_else(|| "steam root is not valid UTF-8".to_string())?;
    let inspection = crate::commands::steam::inspect_deletion_target(
        steam_root,
        &pending.target_type,
        &pending.target_path,
        scope_ok,
    )?;
    let canonical = pending.canonical_path.to_string_lossy();
    if inspection.dev != pending.dev || inspection.ino != pending.ino {
        return Err("target identity changed (dev/ino mismatch), deletion refused".into());
    }
    if inspection.target_type != pending.target_type
        || inspection.target_path != pending.target_path
        || inspection.canonical_path != canonical
        || inspection.consequences != pending.consequences
    {
        return Err("deletion target state changed, deletion refused".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, PendingDeleteRegistry>,
    request: PrepareDeleteRequest,
) -> Result<PendingDeleteInfo, String> {
    use tauri_plugin_fs::FsExt;
    let app2 = app.clone();
    let registry = (*state).clone();
    crate::commands::spawn_blocking_io(move || {
        prepare_delete_inner(
            &registry,
            &request,
            &|p| app2.fs_scope().is_allowed(p),
            || crate::commands::fs_ops::is_process_running_sync("steam"),
        )
    })
    .await
}

#[tauri::command]
pub async fn execute_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, PendingDeleteRegistry>,
    token: String,
) -> Result<DeleteResult, String> {
    use tauri_plugin_fs::FsExt;
    let app2 = app.clone();
    let registry = (*state).clone();
    crate::commands::spawn_blocking_io(move || {
        execute_delete_with_confirmation(
            &registry,
            &token,
            &|p| app2.fs_scope().is_allowed(p),
            || crate::commands::fs_ops::is_process_running_sync("steam"),
            |pending| show_native_confirmation_dialog(&app2, pending),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_util::wsg_fixture;
    use std::sync::atomic::{AtomicBool, Ordering};

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

    fn execute_confirmed(
        registry: &PendingDeleteRegistry,
        token: &str,
        is_steam_running: impl Fn() -> Result<bool, String>,
    ) -> Result<DeleteResult, String> {
        execute_delete_with_confirmation(registry, token, &|_| true, is_steam_running, |_| Ok(true))
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
            manifest_dir.join("src/commands/delete_ops.rs"),
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
    fn produktionswrapper_bindet_nur_native_confirmation() {
        let source = include_str!("delete_ops.rs");
        let start = source
            .find("pub async fn execute_delete(")
            .expect("tauri execute wrapper must exist");
        let command = &source[start..source.find("#[cfg(test)]").expect("tests follow wrapper")];
        assert!(command.contains("token: String"));
        assert!(command.contains("execute_delete_with_confirmation"));
        assert!(command.contains("show_native_confirmation_dialog"));
        assert!(!command.contains("Ok(true)"));
        assert!(!command.contains("bool"));
        assert!(!command.contains("invoke"));
        assert!(!command.contains("webview"));
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
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();
        assert_eq!(info.target_type, "orphan");
        assert_eq!(info.consequences.len(), 1);
        assert_eq!(info.consequences[0].action, "trash");

        // 2. Execute 1st time -> Success
        let res = execute_delete_with_confirmation(
            &registry,
            &info.token,
            &|_| true,
            || Ok(false),
            |_| Ok(true),
        )
        .unwrap();
        assert!(res.success);
        assert!(!compatdata.exists());

        // 3. Execute 2nd time (Replay) -> Fails with invalid token
        let res_replay = execute_delete_with_confirmation(
            &registry,
            &info.token,
            &|_| true,
            || Ok(false),
            |_| Ok(true),
        );
        assert!(res_replay.is_err());
        assert!(res_replay.unwrap_err().contains("invalid deletion token"));

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
            consequences: vec![],
        };
        map.insert("expired123".to_string(), expired_pending);
        drop(map);

        let res = execute_delete_with_confirmation(
            &registry,
            "expired123",
            &|_| true,
            || Ok(false),
            |_| Ok(true),
        );
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

        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        // Steam läuft beim Execute -> Abbruch
        let res = execute_delete_with_confirmation(
            &registry,
            &info.token,
            &|_| true,
            || Ok(true),
            |_| Ok(true),
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("steam is running"));
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

        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();
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
    fn dialog_ablehnung_loescht_nichts() {
        let root = wsg_fixture("delete-ops-cancel");
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

        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        // Dialog abgelehnt (false) -> success: false, Ordner existiert weiter
        let res = execute_delete_with_confirmation(
            &registry,
            &info.token,
            &|_| true,
            || Ok(false),
            |_| Ok(false),
        )
        .unwrap();
        assert!(!res.success);
        assert!(compatdata.exists());

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

        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        // Ersetze Ordner durch neuen Ordner (neues Inode)
        std::fs::remove_dir_all(&compatdata).unwrap();
        std::fs::create_dir_all(&compatdata).unwrap();

        let res = execute_delete_with_confirmation(
            &registry,
            &info.token,
            &|_| true,
            || Ok(false),
            |_| Ok(true),
        );
        let error = res.unwrap_err();
        assert!(
            error.contains("identity changed"),
            "unexpected error: {error}"
        );

        // Symlink mutation
        let info2 = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();
        std::fs::remove_dir_all(&compatdata).unwrap();
        let target_real = root.join("real");
        std::fs::create_dir_all(&target_real).unwrap();
        std::os::unix::fs::symlink(&target_real, &compatdata).unwrap();

        let res2 = execute_delete_with_confirmation(
            &registry,
            &info2.token,
            &|_| true,
            || Ok(false),
            |_| Ok(true),
        );
        assert!(res2.is_err());
        assert!(res2.unwrap_err().contains("symlink"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn neues_gueltiges_manifest_zwischen_prepare_und_execute_blockiert_orphan_delete() {
        let (root, steam) = orphan_fixture("delete-ops-live-manifest-valid");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

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
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

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
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

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
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

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
    fn delete_prepare_lehnt_appid_oberhalb_signed_int32_ab() {
        let root = wsg_fixture("delete-appid-too-large");
        let steam = root.join("steam");
        let target = steam.join("steamapps/compatdata/2147483648");
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

        let result = prepare_delete_inner(
            &PendingDeleteRegistry::default(),
            &request,
            &|_| true,
            || Ok(false),
        );
        assert!(result.is_err(), "delete darf keine zu große appid annehmen");
        assert!(target.exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn neuer_non_steam_shortcut_zwischen_prepare_und_execute_blockiert_orphan_delete() {
        let (root, steam) = orphan_fixture("delete-ops-live-shortcut");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        let shortcuts = steam.join("userdata/123/config");
        std::fs::create_dir_all(&shortcuts).unwrap();
        write_shortcuts_fixture(&shortcuts.join("shortcuts.vdf"), 999999);

        let result = execute_confirmed(&registry, &info.token, || Ok(false));
        assert!(result.is_err(), "new shortcut must block orphan deletion");
        assert!(steam.join("steamapps/compatdata/999999").exists());
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
        let info = prepare_delete_inner(&registry, &request, &|_| true, || Ok(false)).unwrap();

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
        let info = prepare_delete_inner(&registry, &request, &|_| true, || Ok(false)).unwrap();

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
        let info = prepare_delete_inner(&registry, &request, &|_| true, || Ok(false)).unwrap();

        std::fs::create_dir_all(steam.join("config")).unwrap();
        std::fs::write(steam.join("config/config.vdf"), "\"broken\" {").unwrap();

        let result = execute_confirmed(&registry, &info.token, || Ok(false));
        assert!(result.is_err(), "broken compat config must block delete");
        assert!(target.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn steam_start_waehrend_dialog_blockiert_frisch_nach_dialog() {
        let (root, steam) = orphan_fixture("delete-ops-live-steam-race");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();
        let running = Arc::new(AtomicBool::new(false));
        let running_in_dialog = Arc::clone(&running);

        let result = execute_delete_with_confirmation(
            &registry,
            &info.token,
            &|_| true,
            || Ok(running.load(Ordering::SeqCst)),
            |_| {
                running_in_dialog.store(true, Ordering::SeqCst);
                Ok(true)
            },
        );
        assert!(
            result.is_err(),
            "steam start during dialog must block mutation"
        );
        assert!(steam.join("steamapps/compatdata/999999").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn live_aenderung_waehrend_dialog_wird_unmittelbar_vor_mutation_erkannt() {
        let (root, steam) = orphan_fixture("delete-ops-live-dialog-change");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();
        let manifest_path = steam.join("steamapps/appmanifest_999999.acf");

        let result = execute_delete_with_confirmation(
            &registry,
            &info.token,
            &|_| true,
            || Ok(false),
            |_| {
                std::fs::write(
                    &manifest_path,
                    "\"AppState\"\n{\n\t\"appid\"\t\t\"999999\"\n}\n",
                )
                .unwrap();
                Ok(true)
            },
        );
        assert!(
            result.is_err(),
            "dialog-time live drift must block mutation"
        );
        assert!(steam.join("steamapps/compatdata/999999").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bestaetigungsclosure_bindet_warning_okcancel_und_pending_daten() {
        let pending = PendingDelete {
            created_at: 1,
            expires_at: u64::MAX,
            target_type: "orphan".to_string(),
            target_path: "/steamapps/compatdata/999999".to_string(),
            canonical_path: PathBuf::from("/steamapps/compatdata/999999"),
            steam_root: PathBuf::from("/steam"),
            dev: 1,
            ino: 2,
            consequences: vec![DeleteConsequence {
                path: "/steamapps/compatdata/999999".to_string(),
                action: "trash".to_string(),
                description: "prefix in den Papierkorb verschieben".to_string(),
                affected_app_ids: Some(vec![999999]),
            }],
        };
        let seen = Arc::new(Mutex::new(None));
        let seen_in_closure = Arc::clone(&seen);
        let result = confirm_pending_delete(&pending, |request| {
            *seen_in_closure.lock().unwrap() = Some(request);
            Ok(true)
        })
        .unwrap();

        assert!(result);
        let request = seen.lock().unwrap().clone().unwrap();
        assert_eq!(request.kind, ConfirmationKind::Warning);
        assert_eq!(request.buttons, ConfirmationButtons::OkCancel);
        assert_eq!(request.title, "Protium: Löschung bestätigen");
        assert!(request.message.contains(&pending.target_path));
        assert!(request
            .message
            .contains(&pending.consequences[0].description));
        assert!(request.message.contains("999999"));
    }
}
