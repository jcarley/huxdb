import { useReactFlow } from "@xyflow/react";
import { Table } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDiagrams } from "../../stores/diagram";
import { useContextMenu } from "../tree/ContextMenu";
import { designTable, nodeMenu } from "./nodeMenu";

/** Close enough to read a table's rows, when it's picked from a zoomed-out list. */
const READING_ZOOM = 0.75;

/** Every object on the diagram. It doesn't subscribe to the nodes, so dragging leaves it alone. */
export function ObjectPane({ id }: { id: string }) {
  const tables = useDiagrams((s) => s.diagrams[id]?.structure?.tables);
  const selected = useDiagrams((s) => s.diagrams[id]?.selection.nodes);
  const showSchema = useDiagrams((s) => s.diagrams[id]?.options?.showSchemaNames);
  const openMenu = useContextMenu((s) => s.open);
  const flow = useReactFlow();
  const [search, setSearch] = useState("");
  const list = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (tables ?? [])
      .filter((t) => !needle || t.name.toLowerCase().includes(needle))
      .map((t) => ({ id: String(t.oid), label: showSchema ? `${t.schema}.${t.name}` : t.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [search, showSchema, tables]);

  // A table picked on the canvas may be scrolled away here.
  const single = selected?.length === 1 ? selected[0] : null;
  useEffect(() => {
    if (single) list.current?.querySelector(`[data-node="${single}"]`)?.scrollIntoView({ block: "nearest" });
  }, [single]);

  const pick = (node: string) => {
    const diagrams = useDiagrams.getState();
    diagrams.selectNode(id, node);
    const target = diagrams.diagrams[id]?.nodes.find((n) => n.id === node);
    if (target) void flow.setCenter(target.position.x + (target.width ?? 0) / 2, target.position.y + (target.height ?? 0) / 2, { zoom: Math.max(flow.getZoom(), READING_ZOOM), duration: 200 });
  };

  const picked = new Set(selected);
  return (
    <>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1 text-sm" aria-label="Objects">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            data-node={row.id}
            title={row.label}
            className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left ${picked.has(row.id) ? "bg-primary/15" : "hover:bg-base-200"}`}
            aria-pressed={picked.has(row.id)}
            onClick={() => pick(row.id)}
            onDoubleClick={() => designTable(id, row.id)}
            onContextMenu={(e) => openMenu(e, nodeMenu(id, row.id))}
          >
            <Table className="size-3.5 shrink-0 text-primary" strokeWidth={1.75} />
            <span className="truncate">{row.label}</span>
          </button>
        ))}
        {rows.length === 0 && <p className="p-2 text-xs text-base-content/60">{tables?.length ? "No objects match." : "No objects"}</p>}
      </div>
      <div className="border-t border-base-300 p-1">
        <input type="search" className="input input-xs w-full" placeholder="Search" aria-label="Search objects" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
    </>
  );
}
