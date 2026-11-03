mod connections;
mod designer;
mod explorer;

use connections::store::ConnectionStore;
use explorer::sessions::SessionManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("connections.json");
            app.manage(ConnectionStore::load(path));
            app.manage(SessionManager::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connections::list_connections,
            connections::save_connection,
            connections::delete_connection,
            connections::test_connection,
            explorer::open_connection,
            explorer::close_connection,
            explorer::list_schemas,
            explorer::list_schema_objects,
            explorer::list_tables,
            explorer::list_views,
            designer::load_table_design,
            designer::preview_table_ddl,
            designer::save_table_design,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
