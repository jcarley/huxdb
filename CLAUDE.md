# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What huxdb is

huxdb is a desktop database management tool modeled on Navicat (reference for features and UI: https://www.navicat.com/en/products/navicat-for-postgresql). It is a Tauri 2 app with a React 19 + TypeScript + Vite frontend and a Rust backend.

- **v1 targets PostgreSQL only.** Other database engines come in later versions, so keep engine-specific code behind a boundary that a second engine can plug into later. Don't build multi-engine abstractions before a second engine actually needs them.
- **Built one feature at a time, in iterations.** Each iteration delivers one feature end to end, not the whole Navicat feature set. Keep changes scoped to the feature in progress.
- Database connections and queries belong in the Rust backend and are exposed to the UI through Tauri commands. The frontend never talks to a database directly.

## Project state

Built so far: saved PostgreSQL connection profiles (create / edit / delete / test), the main window shell (toolbar, sidebar, details pane), and a lazily loaded object tree in the sidebar (Connection → Databases → Schemas → Tables / Views / Materialized Views / Functions). Selecting a schema's Tables group (or a table under it) shows a Navicat-style tables list in the main pane (Name, Rows, OID, Owner, System Table, Comment) under an object toolbar whose Open / Design / New / Delete / Import / Export buttons are mocked: they enable with the row selection but do nothing yet. The Views group (or a view) likewise shows a views list (Name, OID, Owner, System View, Comment) with mocked Open / Design / New / Delete / Export buttons (no Import, as in Navicat). Other selections show the connection details, and nothing runs user queries. The main toolbar has Connection, New Query (mocked, no-op), a separator, then Tables and Views: each is enabled when the tree selection is inside a schema, selects that schema's group via the explorer store's `showGroup(group)`, and shows as pressed while `isGroupSelection(selected, group)` holds.

Rust has unit tests; the frontend has no test framework, so `npm run build` (tsc strict) is its only check. No linter or formatter config beyond defaults.

## Workflow

- **Start each new feature on its own branch** named `feature/<name>` (e.g. `feature/query-editor`), created from `main` before any changes are made.
- **Don't commit.** The developer makes all commits so that every change is reviewed by a human. Leave the finished work uncommitted on the feature branch.

## Commands

```bash
npm install                 # install frontend deps (Tauri CLI is a devDependency)
npm run tauri dev           # run the desktop app (starts Vite on :1420 via beforeDevCommand)
npm run tauri build         # production bundle (runs `npm run build` first, outputs from ../dist)
npm run dev                 # frontend only in a browser — Tauri `invoke` calls will fail here
npm run build               # type-check (tsc) + Vite build; this is the frontend "lint" step

# Rust side (run from src-tauri/)
cargo check
cargo clippy
cargo test                  # single test: cargo test <name>
# Live-Postgres test is #[ignore]d; run it against a throwaway server:
docker run -d --rm --name huxdb-test-pg -e POSTGRES_PASSWORD=secret -p 55432:5432 postgres:17
HUXDB_TEST_PG_PORT=55432 cargo test -- --include-ignored
```

Vite uses a fixed port (1420, `strictPort`); if it is taken, `tauri dev` fails rather than picking another port.

## Architecture

- **Frontend (`src/`)**: `App.tsx` lays out the Navicat-style shell: `Toolbar` (one big icon button per module; add buttons there as modules are built), `Sidebar` (the object tree), and the main pane (`DetailsPane`). `DetailsPane` picks a view from the explorer's selected node: `objects/TablesView` or `objects/ViewsView` for the Tables / Views group or an object in it, otherwise `ConnectionDetails`. Both are thin wrappers over the generic `objects/ObjectListView` (loading, error/retry, Name column with icon, row selection synced to the tree) and `objects/ObjectToolbar`, passing a loader, extra columns and toolbar actions. Add new object lists the same way and route them in `DetailsPane`. Dialogs (`ConnectionDialog`, `ConfirmDeleteDialog`) are always mounted and render only when the store says so; each keys its inner form by connection id so its local state resets. `components/Modal.tsx` wraps a native `<dialog>` with daisyUI classes.
- **State**: Zustand stores in `src/stores/`. `stores/connections.ts` owns the connection list, the selected connection, and which dialog is open, so any component can open the editor or the delete prompt without passing props down.
- **Object tree**: `stores/explorer.ts` plus `components/tree/`.
  - Every node is identified by a `TreeNodeRef`. `nodeKey()` turns it into a string key that is a prefix of all its descendants' keys; parts are joined with `\u001f`. Prefix matching on these keys is how a refresh or a closed connection drops a whole subtree.
  - Connection, database and schema nodes load their children from the backend on first expand. Group and object nodes are just views of the schema's data.
  - A per-key request counter discards responses that arrive after the node was refreshed or closed.
  - Selecting a tree node stores both `selectedKey` (cheap per-row highlight checks) and `selected` (the `TreeNodeRef`, which `DetailsPane` reads), and also sets the connections store's selected connection.
  - Saving or deleting a connection calls `forget(id)` to drop its tree.
  - `TreeNode.tsx` is the generic row. `ContextMenu.tsx` is the one app-wide right-click menu (`useContextMenu().open(e, items)`).
- **IPC contract**: `src/lib/api.ts` holds typed `invoke` wrappers, and `src/lib/types.ts` mirrors the Rust structs. Rust serializes with `#[serde(rename_all = "camelCase")]` (enums use kebab-case), so TS types match Rust field names converted to camelCase. When you change a Rust model, update `types.ts` too. Commands return `Result<T, String>`, so a rejected promise carries a plain string.
- **Styling**: Tailwind CSS v4 + daisyUI v5 with the `corporate` theme, configured CSS-first in `src/App.css` (there's no `tailwind.config.js`). Icons come from `lucide-react`.
- **Backend (`src-tauri/`)**: Logic lives in the library crate `huxdb_lib` (`src/lib.rs`); `main.rs` only calls `huxdb_lib::run()`. Edition 2024.
  - `connections/model.rs`: `ConnectionConfig` with `normalized()` and `validate()`. The UI repeats these checks in `ConnectionDialog.tsx` so it can show errors per field, but Rust has the final say.
  - `connections/store.rs`: `ConnectionStore` (Tauri managed state) keeps the list behind a `Mutex` and writes `connections.json` in the app config dir (macOS: `~/Library/Application Support/com.bluetarpsoftware.huxdb/`). Each save writes a temp file and renames it into place, with `0600` permissions on Unix. Passwords are stored in plain text there by deliberate decision. A file that can't be parsed is renamed to `connections.json.corrupt`, never overwritten.
  - `connections/postgres.rs`: PostgreSQL connect options (sqlx 0.9 with tokio runtime and native-tls) and Test Connection. With no Initial Database set, huxdb connects to `postgres`, as Navicat does.
  - `explorer/`: the tree's commands (`open_connection`, `close_connection`, `list_schemas`, `list_schema_objects`) and the details pane's `list_tables` / `list_views`.
    - `sessions.rs` (`SessionManager`, managed state) keeps one lazy `PgPool` per (connection id, database), because a PostgreSQL connection can't switch databases. Saving or deleting a connection closes its pools.
    - `postgres.rs` holds the catalog queries. Names are always passed as bind parameters.
  - PostgreSQL-specific code lives only in the `postgres.rs` files; future database engines get sibling modules.
- **Adding a backend command** requires touching both sides: define a `#[tauri::command]` fn in Rust, register it in `tauri::generate_handler![...]` in `lib.rs`, then `invoke` it by name from TypeScript. Arguments are passed as a camelCase JSON object and deserialized via serde.
- **Permissions**: Tauri 2 capabilities in `src-tauri/capabilities/default.json` gate plugin/API access for the `main` window. Adding a Tauri plugin means adding the crate, `.plugin(...)` in `lib.rs`, the npm package, and its permission here.
- App identifier: `com.bluetarpsoftware.huxdb`. CSP is currently disabled (`"csp": null` in `tauri.conf.json`).
