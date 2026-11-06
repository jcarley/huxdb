mod connections;
mod designer;
mod diagram;
mod editor;
mod explorer;
mod fsutil;
mod query;
mod saved_queries;

use connections::store::ConnectionStore;
use diagram::store::DiagramStore;
use editor::EditorSessions;
use explorer::sessions::SessionManager;
use query::QuerySessions;
use saved_queries::ExternalFiles;
use saved_queries::store::SavedQueryStore;
use tauri::menu::Menu;
use tauri::{AppHandle, Manager, Runtime};

const QUIT_MENU_ID: &str = "quit";

/// Tauri's default menu, except on macOS, where its Quit item ends the process
/// without closing the window, so nothing would ask about unsaved tabs.
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    #[cfg(target_os = "macos")]
    if let Some(submenu) = menu.items()?.first().and_then(|item| item.as_submenu()) {
        for item in submenu.items()? {
            if let Some(quit) = item.as_predefined_menuitem().filter(|i| i.text().is_ok_and(|text| text.starts_with("Quit"))) {
                submenu.remove(quit)?;
                submenu.append(&tauri::menu::MenuItem::with_id(app, QUIT_MENU_ID, "Quit huxdb", true, Some("CmdOrCtrl+Q"))?)?;
            }
        }
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(app_menu)
        .on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                // Through the window, so the unsaved-tabs prompt gets its say.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(ConnectionStore::load(config_dir.join("connections.json")));
            app.manage(SavedQueryStore::new(config_dir.join("queries")));
            app.manage(DiagramStore::new(config_dir.join("diagrams")));
            app.manage(ExternalFiles::default());
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
            saved_queries::list_saved_queries,
            saved_queries::saved_query_summary,
            saved_queries::load_saved_query,
            saved_queries::create_saved_query,
            saved_queries::update_saved_query,
            saved_queries::rename_saved_query,
            saved_queries::duplicate_saved_query,
            saved_queries::delete_saved_query,
            saved_queries::open_external_sql,
            saved_queries::save_external_sql_as,
            saved_queries::write_external_sql,
            diagram::diagram_candidates,
            diagram::diagram_structure,
            diagram::diagram_related,
            diagram::diagram_view_sources,
            diagram::export_diagram,
            diagram::print_diagram,
            diagram::list_diagrams,
            diagram::diagram_summary,
            diagram::load_diagram,
            diagram::create_diagram,
            diagram::update_diagram,
            diagram::rename_diagram,
            diagram::duplicate_diagram,
            diagram::delete_diagram,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
