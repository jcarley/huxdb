mod connections;
mod designer;
mod editor;
mod explorer;
mod query;

use connections::store::ConnectionStore;
use editor::EditorSessions;
use explorer::sessions::SessionManager;
use query::QuerySessions;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("connections.json");
            app.manage(ConnectionStore::load(path));
            app.manage(SessionManager::default());
            app.manage(EditorSessions::default());
            app.manage(QuerySessions::default());
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
            explorer::completion_catalog,
            explorer::list_tables,
            explorer::list_views,
            designer::load_table_design,
            designer::list_table_columns,
            designer::list_roles,
            designer::list_tablespaces,
            designer::list_trigger_functions,
            designer::preview_table_ddl,
            designer::save_table_design,
            designer::load_view_design,
            designer::preview_view_ddl,
            designer::save_view_design,
            designer::preview_view_rows,
            designer::explain_view,
            editor::session_begin,
            editor::session_end,
            editor::session_cancel,
            editor::session_close,
            editor::data_fetch_page,
            editor::data_count,
            editor::data_apply,
            query::query_split,
            query::query_run,
            query::query_cancel,
            query::query_end,
            query::query_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
