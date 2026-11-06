import { useRef } from "react";
import { flushSync } from "react-dom";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useConnections } from "../stores/connections";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useShellPrefs } from "../stores/shellPrefs";
import { ResizablePane } from "./ResizablePane";
import { ConnectionNode } from "./tree/ConnectionNode";

/** Keeps 320 px for the main pane, past the 6 px handle, however wide the saved panel is. */
const MAX_WIDTH_CSS = "calc(100vw - 326px)";

/** Navicat-style object tree: Connection → Database → Schema → object groups → objects. */
export function Sidebar() {
  const connections = useConnections((s) => s.connections);
  const loadError = useConnections((s) => s.loadError);
  const width = useShellPrefs((s) => s.sidebarWidth);
  const collapsed = useShellPrefs((s) => s.sidebarCollapsed);
  const hideButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);

  const sorted = [...connections].sort((a, b) => a.name.localeCompare(b.name));

  // Focus follows to the button that appears, once it's no longer hidden.
  const toggle = () => {
    flushSync(() => useShellPrefs.getState().toggleSidebar());
    (collapsed ? hideButton : showButton).current?.focus();
  };

  return (
    <>
      <div className={`w-8 shrink-0 flex-col items-center border-r border-base-300 bg-base-200/50 py-1 ${collapsed ? "flex" : "hidden"}`}>
        <button ref={showButton} type="button" className="btn btn-ghost btn-xs btn-square" aria-label="Show Connections" title="Show Connections" onClick={toggle}>
          <ChevronsRight className="size-4" />
        </button>
      </div>

      {/* The tree stays mounted while collapsed, so it keeps its scroll position. */}
      <ResizablePane width={width} onWidth={useShellPrefs.getState().setSidebarWidth} min={SIDEBAR_MIN_WIDTH} max={SIDEBAR_MAX_WIDTH} handle="right" hidden={collapsed} maxWidthCss={MAX_WIDTH_CSS}>
        <aside className="flex min-h-0 flex-1 flex-col bg-base-200/50">
          <div className="flex items-center justify-between py-2 pr-1 pl-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">Connections</span>
            <button ref={hideButton} type="button" className="btn btn-ghost btn-xs btn-square" aria-label="Hide Connections" title="Hide Connections" onClick={toggle}>
              <ChevronsLeft className="size-4" />
            </button>
          </div>

          {loadError && <div className="alert alert-error mx-2 text-sm">{loadError}</div>}

          {sorted.length === 0 && !loadError ? (
            <p className="px-3 text-sm text-base-content/60">
              No connections yet. Click <strong>Connection</strong> in the toolbar to add one.
            </p>
          ) : (
            <ul role="tree" aria-label="Connections" className="flex-1 overflow-auto px-1 pb-2">
              {sorted.map((c) => (
                <ConnectionNode key={c.id} connection={c} />
              ))}
            </ul>
          )}
        </aside>
      </ResizablePane>
    </>
  );
}
