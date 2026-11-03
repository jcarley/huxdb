import { useEffect, useState } from "react";
import { RotateCw, Table } from "lucide-react";
import * as api from "../../lib/api";
import type { TableInfo } from "../../lib/types";
import { useExplorer } from "../../stores/explorer";
import { ObjectToolbar } from "./ObjectToolbar";

type ListState =
  | { status: "loading" }
  | { status: "loaded"; tables: TableInfo[] }
  | { status: "error"; error: string };

interface TablesViewProps {
  connectionId: string;
  database: string;
  schema: string;
  /** Table selected in the tree; the list highlights it. */
  selectedName?: string;
}

/** Navicat-style object list of a schema's tables, with the table actions above it. */
export function TablesView({ connectionId, database, schema, selectedName }: TablesViewProps) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let ignore = false;
    setList({ status: "loading" });
    api.listTables(connectionId, database, schema).then(
      (tables) => !ignore && setList({ status: "loaded", tables }),
      (err) => !ignore && setList({ status: "error", error: api.errorMessage(err) }),
    );
    return () => {
      ignore = true;
    };
  }, [connectionId, database, schema, reloadToken]);

  const reload = () => setReloadToken((t) => t + 1);
  // The tree selection is the single source of truth, so the list and tree never disagree.
  const selectRow = (name: string) =>
    useExplorer.getState().select({ kind: "object", connectionId, database, schema, group: "tables", name });
  const tables = list.status === "loaded" ? list.tables : [];
  const hasSelection = tables.some((t) => t.name === selectedName);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <ObjectToolbar hasSelection={hasSelection} onRefresh={reload} />
      <div className="min-h-0 flex-1 overflow-auto">
        {list.status === "loading" && (
          <div className="flex justify-center p-6">
            <span className="loading loading-spinner loading-md" />
          </div>
        )}
        {list.status === "error" && (
          <div className="flex flex-col items-center gap-3 p-6 text-sm">
            <p className="text-error select-text">{list.error}</p>
            <button type="button" className="btn btn-sm" onClick={reload}>
              <RotateCw className="size-4" /> Retry
            </button>
          </div>
        )}
        {list.status === "loaded" && (
          <table className="table table-sm table-pin-rows">
            <thead>
              <tr>
                <th>Name</th>
                <th className="text-right">Rows</th>
                <th className="text-right">OID</th>
                <th>Owner</th>
                <th>System Table</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr
                  key={t.name}
                  aria-selected={t.name === selectedName}
                  className={`cursor-default ${t.name === selectedName ? "bg-primary/15" : "hover:bg-base-300/60"}`}
                  onClick={() => selectRow(t.name)}
                >
                  <td className="font-medium">
                    <span className="flex items-center gap-1.5">
                      <Table className="size-4 shrink-0 text-base-content/60" strokeWidth={1.5} />
                      {t.name}
                    </span>
                  </td>
                  <td className="text-right tabular-nums">{t.rows?.toLocaleString() ?? ""}</td>
                  <td className="text-right tabular-nums">{t.oid}</td>
                  <td>{t.owner}</td>
                  <td>{t.systemTable ? "Yes" : "No"}</td>
                  <td className="max-w-xs truncate" title={t.comment ?? undefined}>
                    {t.comment}
                  </td>
                </tr>
              ))}
              {tables.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-base-content/50">
                    No tables
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
