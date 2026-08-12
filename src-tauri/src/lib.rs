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
                        // alle unbekannten schemes durch (S-08).
                        url.scheme() == "tauri"
                            || (cfg!(dev) && url.scheme() == "http" && url.host_str() == Some("localhost"))
                    })
                    .build()?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .manage(commands::download::CancelRegistry::default())
        .invoke_handler(tauri::generate_handler![
            commands::fs_ops::is_process_running,
            commands::external::open_external,
            commands::fs_ops::dir_size,
            commands::fs_ops::batch_dir_sizes,
            commands::scope::allow_library_scope,
            commands::fs_ops::canonicalize_path,
            commands::fs_ops::path_identity,
            commands::extract::extract_tarball,
            commands::download::download_file,
            commands::download::cancel_download,
            commands::download::fetch_sha512,
            commands::cleanup::remove_orphan_dir,
            commands::cleanup::remove_trash_entry,
            commands::cleanup::list_trash_entries,
            commands::steam::write_steam_file,
            commands::steam::remove_compat_tool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running protium");
}
