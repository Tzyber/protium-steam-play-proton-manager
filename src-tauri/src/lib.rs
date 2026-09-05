mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(not(mobile))]
            {
                use tauri::{
                    utils::config::{Color, WebviewUrl},
                    WebviewWindowBuilder,
                };
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running protium");
}
