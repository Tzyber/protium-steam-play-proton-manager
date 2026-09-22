mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Die Reihenfolge folgt der Empfehlung des Plugins: der Einzelinstanz-
    // Waechter steht vor allen anderen Plugins. Nur Desktop, der Crate-Code
    // ist fuer Mobile per cfg ausgeschlossen.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .setup(|app| {
            #[cfg(not(mobile))]
            {
                use tauri::{
                    utils::config::{Color, WebviewUrl},
                    Manager, WebviewWindowBuilder,
                };
                // Panic-Hook vor dem Fenster: ein Panic soll lokal sichtbar
                // bleiben, auch wenn er waehrend eines Steam-Writes passiert.
                if let Ok(data_dir) = app.path().app_local_data_dir() {
                    if let Ok(log_dir) =
                        commands::scope::prepare_app_dir(&data_dir.join("logs"), "app logs")
                    {
                        commands::diagnostics::install_panic_hook(log_dir);
                    }
                }
                // fenster wird hier statt in tauri.conf gebaut, weil nur der
                // builder einen navigation-handler setzen kann: eigener origin
                // durchlassen, alles externe blocken, externe links gehören
                // in den system-browser (openExternal), nicht in die webview
                // (rechtsklick-open-link liess die app sonst auf protondb.com
                // hängen, kein zurück).
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("protium")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(960.0, 600.0)
                    .background_color(Color(10, 11, 17, 255))
                    .on_navigation(|url| {
                        // whitelist statt blacklist: nur die eigene app (bzw. der
                        // vite-dev-server) darf in die webview navigieren. alles
                        // andere, auch file:/data:/mailto:, gehört in den
                        // system-browser (openExternal). die alte blacklist liess
                        // alle unbekannten Schemes durch.
                        url.scheme() == "tauri"
                            || (cfg!(dev)
                                && url.scheme() == "http"
                                && url.host_str() == Some("localhost"))
                    })
                    .build()?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::download::CancelRegistry::default())
        .manage(commands::delete_ops::PendingDeleteRegistry::default())
        .manage(commands::scope::EnvironmentState::default())
        .invoke_handler(tauri::generate_handler![
            commands::fs_ops::is_process_running,
            commands::external::open_external,
            commands::prefix::open_prefix_folder,
            commands::fs_ops::dir_size,
            commands::fs_ops::batch_dir_sizes,
            commands::fs_ops::environment_exists,
            commands::fs_ops::environment_read_text,
            commands::fs_ops::environment_read_binary,
            commands::fs_ops::environment_read_dir,
            commands::scope::discover_steam_environment,
            commands::fs_ops::path_identity,
            commands::ge_install::ge_target_arch,
            commands::ge_install::install_ge_proton,
            commands::download::cancel_download,
            commands::delete_ops::prepare_delete,
            commands::delete_ops::execute_delete,
            commands::cleanup::list_trash_entries,
            commands::steam::save_launch_options,
            commands::steam::save_compat_tool,
            commands::steam::list_config_backups,
            commands::steam::open_backups_folder,
            commands::diagnostics::log_diagnostic,
            commands::diagnostics::open_logs_folder,
            commands::diagnostics::read_log_tail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running protium");
}
