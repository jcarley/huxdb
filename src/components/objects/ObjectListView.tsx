import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { RotateCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as api from "../../lib/api";
import { useExplorer } from "../../stores/explorer";
import type { ObjectGroup } from "../../stores/explorer";
import { useSchemaVersion } from "../../stores/tabs";
import { useContextMenu } from "../tree/ContextMenu";
import type { MenuItem } from "../tree/ContextMenu";
import { ObjectToolbar } from "./ObjectToolbar";
import type { ObjectAction } from "./ObjectToolbar";

type ListState<T> = { status: "loading" } | { status: "loaded"; rows: T[] } | { status: "error"; error: string };

/** A column after Name. */
export interface ObjectColumn<T> {
  header: string;
  align?: "right";
  cell: (row: T) => ReactNode;
  /** Shown on hover, e.g. the full text of a truncated cell. */
  title?: (row: T) => string | undefined;
  className?: string;
}

interface ObjectListViewProps<T extends { name: string }> {
  /** Object selected in the tree; the list highlights it. */
  selectedName?: string;
  /** Icon shown before each name, matching the tree. */
  icon: LucideIcon;
  /** Stable between renders; a new one reloads the list. */
  load: () => Promise<T[]>;
  /** A change reloads the list. */
  reloadKey: unknown;
  /** Clicking a row selects its node in the tree. */
  onSelect: (row: T) => void;
  /** The row's right-click menu. */
  rowMenu?: (row: T) => MenuItem[];
  columns: ObjectColumn<T>[];
  actions: ObjectAction[];
  emptyText: string;
  /** Double-clicking a row opens its object. */
  onOpen?: (row: T) => void;
}

/** What a schema's object list passes to `ObjectListView`: its rows come from
 * the catalog, reload when a designer saves there, and select in the tree. */
export function useSchemaList<T extends { name: string }>(
  { connectionId, database, schema }: { connectionId: string; database: string; schema: string },
  group: ObjectGroup,
  fetch: (connectionId: string, database: string, schema: string) => Promise<T[]>,
) {
  return {
    load: useCallback(() => fetch(connectionId, database, schema), [fetch, connectionId, database, schema]),
    reloadKey: useSchemaVersion({ connectionId, database, schema }),
    // The tree selection is the single source of truth, so the list and tree never disagree.
    onSelect: (row: T) => useExplorer.getState().select({ kind: "object", connectionId, database, schema, group, name: row.name }),
  };
}

/** Navicat-style list of one kind of object, with that kind's actions above it. */
export function ObjectListView<T extends { name: string }>({
  selectedName,
  icon: Icon,
  load,
  reloadKey,
  onSelect,
  rowMenu,
  columns,
  actions,
  emptyText,
  onOpen,
}: ObjectListViewProps<T>) {
  const [list, setList] = useState<ListState<T>>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const openMenu = useContextMenu((s) => s.open);

  useEffect(() => {
    let ignore = false;
    setList({ status: "loading" });
    load().then(
      (rows) => !ignore && setList({ status: "loaded", rows }),
      (err) => !ignore && setList({ status: "error", error: api.errorMessage(err) }),
    );
    return () => {
      ignore = true;
    };
  }, [load, reloadToken, reloadKey]);

  const reload = () => setReloadToken((t) => t + 1);
  const rows = list.status === "loaded" ? list.rows : [];
  const hasSelection = rows.some((r) => r.name === selectedName);
  const alignClass = (c: ObjectColumn<T>) => (c.align === "right" ? "text-right" : "");

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <ObjectToolbar actions={actions} hasSelection={hasSelection} onRefresh={reload} />
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
                {columns.map((c) => (
                  <th key={c.header} className={alignClass(c)}>
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.name}
                  aria-selected={row.name === selectedName}
                  className={`cursor-default ${row.name === selectedName ? "bg-primary/15" : "hover:bg-base-300/60"}`}
                  onClick={() => onSelect(row)}
                  onDoubleClick={onOpen && (() => onOpen(row))}
                  onContextMenu={
                    rowMenu &&
                    ((e) => {
                      onSelect(row);
                      openMenu(e, rowMenu(row));
                    })
                  }
                >
                  <td className="font-medium">
                    <span className="flex items-center gap-1.5">
                      <Icon className="size-4 shrink-0 text-base-content/60" strokeWidth={1.5} />
                      {row.name}
                    </span>
                  </td>
                  {columns.map((c) => (
                    <td key={c.header} className={`${alignClass(c)} ${c.className ?? ""}`} title={c.title?.(row)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} className="text-center text-base-content/50">
                    {emptyText}
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
