//! Diagrams: reads a database's structure for the canvas, and keeps saved diagrams as files.
//! Nothing here changes the database. The frontend side is `src/stores/diagram.ts` and
//! `src/stores/savedDiagrams.ts`.

pub mod export;
mod postgres;
pub mod store;

use postgres::{DiagramCandidate, DiagramStructure, ViewColumnSource};
use store::{DiagramContent, DiagramInfo, DiagramStore, DiagramSummary, SavedDiagram};
use std::path::PathBuf;
use std::time::Duration;

use export::{ExportProgress, ExportRequest, PdfPage};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::connections::store::ConnectionStore;
use crate::explorer::pool_for;
use crate::explorer::sessions::SessionManager;

/// The tables a diagram of this database can hold, for the picker.
#[tauri::command]
pub async fn diagram_candidates(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
) -> Result<Vec<DiagramCandidate>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::list_candidates(&pool).await
}

/// The chosen tables and the foreign keys between them.
#[tauri::command]
pub async fn diagram_structure(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    oids: Vec<i64>,
) -> Result<DiagramStructure, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::load_structure(&pool, &oids).await
}

/// Tables one foreign key away from these, for Add Related Tables.
#[tauri::command]
pub async fn diagram_related(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    oids: Vec<i64>,
) -> Result<Vec<i64>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::related_tables(&pool, &oids).await
}

/// Which table columns a view's output columns come from, on demand because it prepares the
/// view's query.
#[tauri::command]
pub async fn diagram_view_sources(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    oid: i64,
) -> Result<Vec<ViewColumnSource>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::view_sources(&pool, oid).await
}

#[tauri::command]
pub fn list_diagrams(store: State<'_, DiagramStore>, connection_id: String) -> Result<Vec<DiagramInfo>, String> {
    store.list(&connection_id)
}

/// For the prompt when deleting a connection.
#[tauri::command]
pub fn diagram_summary(store: State<'_, DiagramStore>, connection_id: String) -> Result<DiagramSummary, String> {
    store.summary(&connection_id)
}

#[tauri::command]
pub fn load_diagram(store: State<'_, DiagramStore>, connection_id: String, id: String) -> Result<SavedDiagram, String> {
    store.load(&connection_id, &id)
}

#[tauri::command]
pub fn create_diagram(store: State<'_, DiagramStore>, connection_id: String, name: String, database: String, content: DiagramContent) -> Result<DiagramInfo, String> {
    store.create(&connection_id, &name, &database, content)
}

/// With `expected_modified_ms`, a file changed since then is refused with `CHANGED_MARKER`.
#[tauri::command]
pub fn update_diagram(store: State<'_, DiagramStore>, connection_id: String, id: String, content: DiagramContent, expected_modified_ms: Option<u64>) -> Result<DiagramInfo, String> {
    store.update(&connection_id, &id, content, expected_modified_ms)
}

#[tauri::command]
pub fn rename_diagram(store: State<'_, DiagramStore>, connection_id: String, id: String, name: String) -> Result<DiagramInfo, String> {
    store.rename(&connection_id, &id, &name)
}

#[tauri::command]
pub fn duplicate_diagram(store: State<'_, DiagramStore>, connection_id: String, id: String) -> Result<DiagramInfo, String> {
    store.duplicate(&connection_id, &id)
}

#[tauri::command]
pub fn delete_diagram(store: State<'_, DiagramStore>, connection_id: String, id: String) -> Result<(), String> {
    store.delete(&connection_id, &id)
}

/// Asks where to save; `None` if the dialog was cancelled.
async fn ask_where(app: &AppHandle, filter: (&str, &[&str]), file_name: String) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog().file().add_filter(filter.0, filter.1).set_file_name(file_name).save_file(move |path| {
        let _ = sender.send(path);
    });
    crate::saved_queries::picked(receiver).await
}

fn reporter(on_event: Channel<ExportProgress>) -> impl FnMut(u32, u32) {
    move |done, total| {
        let _ = on_event.send(ExportProgress { done, total });
    }
}

/// Renders the diagram and saves it where the user chooses; resolves to the path, or `None` if
/// the dialog was cancelled. The webview never names the path.
#[tauri::command]
pub async fn export_diagram(app: AppHandle, request: ExportRequest, suggested_name: String, on_event: Channel<ExportProgress>) -> Result<Option<String>, String> {
    let run = |f: Box<dyn FnOnce() -> Result<(), String> + Send>| async move {
        tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
    };
    let (filter, extension): ((&str, &[&str]), &str) = match &request {
        ExportRequest::Svg { .. } => (("SVG image", &["svg"]), "svg"),
        ExportRequest::Png { .. } => (("PNG image", &["png"]), "png"),
        ExportRequest::Pdf { .. } => (("PDF document", &["pdf"]), "pdf"),
    };
    // A PNG that can't be made is refused before the dialog, not after the user picked a file.
    let png = match &request {
        ExportRequest::Png { svg, scale } => {
            let (svg, scale) = (svg.clone(), *scale);
            let tree = tauri::async_runtime::spawn_blocking(move || {
                let tree = export::parse(&svg)?;
                export::png_size(&tree, scale)?;
                Ok::<_, String>(tree)
            })
            .await
            .map_err(|e| e.to_string())??;
            Some((tree, scale))
        }
        _ => None,
    };
    let Some(path) = ask_where(&app, filter, export::file_name(&suggested_name, extension)).await? else { return Ok(None) };
    let target = path.clone();
    let mut progress = reporter(on_event);
    match (request, png) {
        (ExportRequest::Svg { svg }, _) => run(Box::new(move || export::save_bytes(&target, svg.as_bytes()))).await?,
        (ExportRequest::Png { .. }, Some((tree, scale))) => {
            run(Box::new(move || export::save_png(&target, &tree, scale, &mut progress))).await?
        }
        (ExportRequest::Pdf { pages }, _) => {
            run(Box::new(move || export::save_bytes(&target, &export::pdf(&pages, &mut progress)?))).await?
        }
        (ExportRequest::Png { .. }, None) => return Err("The image could not be prepared.".into()),
    }
    Ok(Some(path.display().to_string()))
}

/// Print: renders a PDF into the app's cache folder and opens it in the system viewer, which has
/// the print dialog. The folder is the user's own (a shared temp folder lets another user block
/// Print, or point a symlink at files the sweep would delete). Files stay (a viewer may hold the
/// newest), and older ones are swept first.
#[tauri::command]
pub async fn print_diagram(app: AppHandle, pages: Vec<PdfPage>, suggested_name: String, on_event: Channel<ExportProgress>) -> Result<(), String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("print");
    let stem = export::file_name(&suggested_name, "pdf");
    let stem = stem.strip_suffix(".pdf").unwrap_or(&stem);
    let short = uuid::Uuid::new_v4().simple().to_string();
    let path = dir.join(format!("{stem}-{}.pdf", &short[..8]));
    let target = path.clone();
    let mut progress = reporter(on_event);
    tauri::async_runtime::spawn_blocking(move || {
        export::sweep_print_files(&dir, Duration::from_secs(86_400));
        export::save_bytes(&target, &export::pdf(&pages, &mut progress)?)
    })
    .await
    .map_err(|e| e.to_string())??;
    app.opener().open_path(path.display().to_string(), None::<&str>).map_err(|e| {
        format!("Could not open {}: {e}. A PDF viewer is needed to print.", path.display())
    })
}
