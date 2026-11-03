import { useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { ConnectionConfig } from "../lib/types";
import { useConnections } from "../stores/connections";
import { ConnectionIcon } from "./ConnectionIcon";

// Approximate context-menu size (w-40, two items), used to keep it inside the window.
const MENU_WIDTH = 168;
const MENU_HEIGHT = 88;

interface MenuState {
  x: number;
  y: number;
  connection: ConnectionConfig;
}

export function Sidebar() {
  const { connections, selectedId, loadError, select, openEditor, requestDelete } = useConnections();
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Close the context menu on any click, right-click, scroll, blur, or Escape. The
  // contextmenu/scroll listeners use capture so they run before a row's onContextMenu,
  // which then reopens the menu at the new spot.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const sorted = [...connections].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-base-300 bg-base-200/50">
      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-base-content/60">
        Connections
      </div>

      {loadError && <div className="alert alert-error mx-2 text-sm">{loadError}</div>}

      {sorted.length === 0 && !loadError ? (
        <p className="px-3 text-sm text-base-content/60">
          No connections yet. Click <strong>Connection</strong> in the toolbar to add one.
        </p>
      ) : (
        <ul className="menu menu-sm w-full flex-1 flex-nowrap overflow-y-auto">
          {sorted.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={selectedId === c.id ? "menu-active" : ""}
                onClick={() => select(c.id)}
                onDoubleClick={() => openEditor(c)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  select(c.id);
                  setMenu({
                    x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH),
                    y: Math.min(e.clientY, window.innerHeight - MENU_HEIGHT),
                    connection: c,
                  });
                }}
              >
                <ConnectionIcon color={c.color} />
                <span className="truncate">{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {menu && (
        <ul
          className="menu menu-sm fixed z-50 w-40 rounded-box border border-base-300 bg-base-100 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          <li>
            <button type="button" onClick={() => openEditor(menu.connection)}>
              <Pencil className="size-4" /> Edit Connection…
            </button>
          </li>
          <li>
            <button type="button" className="text-error" onClick={() => requestDelete(menu.connection)}>
              <Trash2 className="size-4" /> Delete Connection
            </button>
          </li>
        </ul>
      )}
    </aside>
  );
}
