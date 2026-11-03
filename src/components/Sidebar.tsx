import { useConnections } from "../stores/connections";
import { ConnectionNode } from "./tree/ConnectionNode";
import { ContextMenu } from "./tree/ContextMenu";

/** Navicat-style object tree: Connection → Database → Schema → object groups → objects. */
export function Sidebar() {
  const connections = useConnections((s) => s.connections);
  const loadError = useConnections((s) => s.loadError);

  const sorted = [...connections].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-base-300 bg-base-200/50">
      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-base-content/60">
        Connections
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

      <ContextMenu />
    </aside>
  );
}
