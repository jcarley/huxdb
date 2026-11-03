import { Pencil, Trash2 } from "lucide-react";
import { SSL_MODES } from "../lib/types";
import { useConnections, useSelectedConnection } from "../stores/connections";
import { ConnectionIcon } from "./ConnectionIcon";

/** Main pane: summary of the selected connection, or a hint when none is selected. */
export function ConnectionDetails() {
  const connection = useSelectedConnection();
  const { openEditor, requestDelete } = useConnections();

  if (!connection) {
    return (
      <div className="flex flex-1 items-center justify-center text-base-content/50">
        Select a connection, or add one with the Connection button.
      </div>
    );
  }

  const rows: [string, string][] = [
    ["Host", connection.host],
    ["Port", String(connection.port)],
    ["Initial Database", connection.database ?? "postgres (default)"],
    ["User Name", connection.username],
    ["SSL Mode", SSL_MODES.find((m) => m.value === connection.sslMode)?.label ?? connection.sslMode],
  ];

  return (
    <section className="flex-1 overflow-y-auto p-6">
      <div className="mb-6 flex items-center gap-3">
        <ConnectionIcon color={connection.color} className="size-8" />
        <h1 className="flex-1 truncate text-xl font-semibold">{connection.name}</h1>
        <button type="button" className="btn btn-sm" onClick={() => openEditor(connection)}>
          <Pencil className="size-4" /> Edit
        </button>
        <button
          type="button"
          className="btn btn-sm btn-error btn-outline"
          onClick={() => requestDelete(connection)}
        >
          <Trash2 className="size-4" /> Delete
        </button>
      </div>

      <dl className="grid max-w-lg grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-base-content/60">{label}</dt>
            <dd className="truncate">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
