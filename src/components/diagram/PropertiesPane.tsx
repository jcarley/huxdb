import { KeyRound, Link2, LoaderCircle } from "lucide-react";
import { relationshipFacts, relationshipNotes } from "../../lib/diagramCardinality";
import { ANNOTATION_FONT_SIZES, isAnnotationId } from "../../lib/diagramAnnotations";
import { foreignKeyRule, matchLabel } from "../../lib/diagramFlow";
import { foreignKeyKey, objectKind, objectLabel, tableKey } from "../../lib/diagramDrift";
import { dependencyId } from "../../lib/diagramLayout";
import { EXPRESSION_NOTE, FUNCTION_NOTE, sourceLabel } from "../../lib/diagramTrace";
import type { DiagramAnnotation, DiagramColor, DiagramForeignKey, DiagramOptions, DiagramTable } from "../../lib/types";
import { useDiagrams } from "../../stores/diagram";
import { ColorPicker } from "./ColorPicker";
import { sharedColor } from "./colorStyles";

const FONT_SIZES = [9, 10, 11, 12, 13, 14, 16];

const CHECKBOXES: { option: keyof DiagramOptions; label: string }[] = [
  { option: "showObjectComments", label: "Show object comments" },
  { option: "showFieldComments", label: "Show field comments" },
  { option: "showNotNull", label: "Show field NOT NULL" },
  { option: "showSchemaNames", label: "Show schema names" },
  { option: "showRelationshipNames", label: "Show relationship names" },
  { option: "blackAndWhite", label: "Black and white" },
];

function DiagramProperties({ id, options }: { id: string; options: DiagramOptions }) {
  const { setOptions } = useDiagrams.getState();
  return (
    <div className="p-2 text-sm">
      <h3 className="mb-2 font-semibold">Diagram</h3>
      <label className="mb-2 flex items-center justify-between gap-2">
        Font size
        <select className="select select-xs w-16" value={options.fontSize} onChange={(e) => void setOptions(id, { fontSize: Number(e.target.value) })}>
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      {CHECKBOXES.map(({ option, label }) => (
        <label key={option} className="flex items-center gap-2 py-0.5">
          <input type="checkbox" className="checkbox checkbox-xs" checked={!!options[option]} onChange={(e) => void setOptions(id, { [option]: e.target.checked })} />
          {label}
        </label>
      ))}
    </div>
  );
}

/** A view's trace while it loads or after it fails; its sources show under each column once read. */
function TraceStatus({ id, oid }: { id: string; oid: number }) {
  const trace = useDiagrams((s) => s.diagrams[id]?.traces[oid]);
  if (trace?.status === "ready") return trace.columns.some((c) => !c.source) ? <p className="mt-2 text-xs text-base-content/60">{EXPRESSION_NOTE}</p> : null;
  if (trace?.status === "error")
    return (
      <div className="mt-2 text-xs">
        <p className="text-error break-words">{trace.error}</p>
        <button type="button" className="btn btn-xs mt-1" onClick={() => void useDiagrams.getState().traceView(id, oid)}>
          Retry
        </button>
      </div>
    );
  return <LoaderCircle className="mt-2 size-4 animate-spin text-base-content/50" aria-label="Reading sources" />;
}

/** The colour of one table, or of a selection if they all share one. */
function ObjectColor({ id, nodes }: { id: string; nodes: string[] }) {
  const value = useDiagrams((s) => {
    const d = s.diagrams[id];
    const keys = (d?.structure?.tables ?? []).filter((t) => nodes.includes(String(t.oid))).map(tableKey);
    return sharedColor(keys.map((k) => d?.colors.objects[k] ?? null));
  });
  return (
    <div className="mt-2 text-xs">
      <div className="mb-1 text-base-content/60">Colour</div>
      <ColorPicker allowNone value={value === "mixed" ? null : value} mixed={value === "mixed"} onChange={(color) => useDiagrams.getState().setObjectColor(id, nodes, color)} />
    </div>
  );
}

function LineColor({ id, fk }: { id: string; fk: DiagramForeignKey }) {
  const value = useDiagrams((s) => {
    const d = s.diagrams[id];
    const child = d?.structure?.tables.find((t) => t.oid === fk.childOid);
    return child ? (d?.colors.lines[foreignKeyKey(fk, child)] ?? null) : null;
  });
  return (
    <div className="mt-2 text-xs">
      <div className="mb-1 text-base-content/60">Colour</div>
      <ColorPicker allowNone value={value} onChange={(color) => useDiagrams.getState().setLineColor(id, String(fk.oid), color)} />
    </div>
  );
}

function AnnotationProperties({ id, annotation: a }: { id: string; annotation: DiagramAnnotation }) {
  const { updateAnnotation, bringToFront, sendToBack, deleteAnnotations } = useDiagrams.getState();
  const note = a.kind === "note";
  return (
    <div className="p-2 text-sm">
      <h3 className="mb-2 font-semibold">{note ? "Note" : "Label"}</h3>
      <label className="mb-2 flex items-center justify-between gap-2">
        Font size
        <select className="select select-xs w-16" value={a.fontSize} onChange={(e) => updateAnnotation(id, a.id, { fontSize: Number(e.target.value) })}>
          {ANNOTATION_FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 py-0.5">
        <input type="checkbox" className="checkbox checkbox-xs" checked={a.bold} onChange={(e) => updateAnnotation(id, a.id, { bold: e.target.checked })} />
        Bold
      </label>
      <label className="flex items-center gap-2 py-0.5">
        <input type="checkbox" className="checkbox checkbox-xs" checked={a.italic} onChange={(e) => updateAnnotation(id, a.id, { italic: e.target.checked })} />
        Italic
      </label>
      {note && (
        <div className="mt-2 text-xs">
          <div className="mb-1 text-base-content/60">Colour</div>
          <ColorPicker allowNone value={a.color} onChange={(color: DiagramColor | null) => updateAnnotation(id, a.id, { color })} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1">
        <button type="button" className="btn btn-xs" onClick={() => bringToFront(id, [a.id])}>
          Bring to Front
        </button>
        <button type="button" className="btn btn-xs" onClick={() => sendToBack(id, [a.id])}>
          Send to Back
        </button>
        <button type="button" className="btn btn-xs" onClick={() => deleteAnnotations(id, [a.id])}>
          Delete
        </button>
      </div>
      <p className="mt-3 text-xs text-base-content/60">Saved with the diagram. It doesn&apos;t change the database.</p>
    </div>
  );
}

function TableProperties({ id, table, foreignKeys, showSchema }: { id: string; table: DiagramTable; foreignKeys: DiagramForeignKey[]; showSchema: boolean }) {
  const kind = objectKind(table);
  const routine = kind === "function" || kind === "procedure";
  const view = kind === "view" || kind === "materialized-view";
  const trace = useDiagrams((s) => s.diagrams[id]?.traces[table.oid]);
  return (
    <div className="p-2 text-sm select-text">
      <h3 className="font-semibold break-all">{table.name}</h3>
      <p className="text-xs text-base-content/60">
        {table.schema}, {routine ? kind : `${table.columns.length} ${table.columns.length === 1 ? "column" : "columns"}`}
      </p>
      {table.comment && <p className="mt-1 whitespace-pre-wrap">{table.comment}</p>}
      <ul className="mt-2 text-xs">
        {table.columns.map((c, i) => (
          <li key={i} className="flex items-center gap-1 py-0.5" title={c.comment ?? undefined}>
            {c.primaryKey ? <KeyRound className="size-3 shrink-0 text-warning" /> : foreignKeys.some((fk) => fk.childOid === table.oid && fk.childColumns.includes(c.name)) ? <Link2 className="size-3 shrink-0 text-base-content/40" /> : <span className="w-3 shrink-0" />}
            <span className="min-w-0 truncate">
              {c.name}
              <span className="text-base-content/50">
                : {c.dataType}
                {c.notNull ? " NOT NULL" : ""}
              </span>
              {trace?.status === "ready" && <span className="block text-base-content/60">{sourceLabel(trace.columns.find((t) => t.column === c.name)?.source ?? null, showSchema)}</span>}
            </span>
          </li>
        ))}
      </ul>
      <ObjectColor id={id} nodes={[String(table.oid)]} />
      {view && <TraceStatus id={id} oid={table.oid} />}
      {routine && <p className="mt-2 text-xs text-base-content/60">{FUNCTION_NOTE}</p>}
    </div>
  );
}

function DependencyProperties({ view, source }: { view?: DiagramTable; source?: DiagramTable }) {
  return (
    <div className="p-2 text-sm select-text">
      <h3 className="font-semibold">Dependency</h3>
      <p className="mt-2 text-xs break-words">
        {view ? objectLabel(view) : "?"} reads {source ? objectLabel(source) : "?"}
      </p>
    </div>
  );
}

function ForeignKeyProperties({ id, fk, child, parent }: { id: string; fk: DiagramForeignKey; child?: DiagramTable; parent?: DiagramTable }) {
  const rows: [string, string][] = [
    ["From", `${child?.name}(${fk.childColumns.join(", ")})`],
    ["To", `${parent?.name}(${fk.parentColumns.join(", ")})`],
    ["Match", matchLabel(fk.matchType)],
    ["On update", foreignKeyRule(fk.onUpdate)],
    ["On delete", foreignKeyRule(fk.onDelete)],
    ...(fk.uniqueVia ? ([["Unique via", fk.uniqueVia]] as [string, string][]) : []),
  ];
  return (
    <div className="p-2 text-sm select-text">
      <h3 className="font-semibold break-all">{fk.name}</h3>
      <p className="text-xs text-base-content/60">Foreign key</p>
      <ul className="mt-2 text-xs">
        {relationshipFacts(fk, child?.name ?? "child", parent?.name ?? "parent").map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-base-content/60">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-2 flex flex-col gap-1 text-xs text-base-content/60">
        {relationshipNotes(fk).map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <LineColor id={id} fk={fk} />
    </div>
  );
}

/** Diagram options, or what's selected. */
export function PropertiesPane({ id }: { id: string }) {
  const options = useDiagrams((s) => s.diagrams[id]?.options);
  const structure = useDiagrams((s) => s.diagrams[id]?.structure);
  const selection = useDiagrams((s) => s.diagrams[id]?.selection);
  const annotation = useDiagrams((s) => (selection?.nodes.length === 1 && isAnnotationId(selection?.nodes[0]) ? s.diagrams[id]?.annotations.find((a) => a.id === selection?.nodes[0]) : undefined));
  if (!options || !structure || !selection) return null;

  const table = (oid: number) => structure.tables.find((t) => t.oid === oid);
  const fk = selection.foreignKey;
  const dependency = selection.edge ? structure.dependencies?.find((d) => dependencyId(d) === selection.edge) : undefined;
  // An annotation's id isn't a number, so it must be answered before the table lookup.
  const selected = selection.nodes.length === 1 && !annotation ? table(Number(selection.nodes[0])) : undefined;
  const objects = selection.nodes.filter((n) => !isAnnotationId(n));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" aria-label="Properties">
      {fk ? (
        <ForeignKeyProperties id={id} fk={fk} child={table(fk.childOid)} parent={table(fk.parentOid)} />
      ) : dependency ? (
        <DependencyProperties view={table(dependency.dependentOid)} source={table(dependency.sourceOid)} />
      ) : annotation ? (
        <AnnotationProperties id={id} annotation={annotation} />
      ) : selected ? (
        <TableProperties id={id} table={selected} foreignKeys={structure.foreignKeys} showSchema={options.showSchemaNames} />
      ) : selection.nodes.length > 1 ? (
        <div className="p-2">
          <p className="text-sm text-base-content/60">{selection.nodes.length} objects selected</p>
          {objects.length > 0 && <ObjectColor id={id} nodes={objects} />}
        </div>
      ) : (
        <DiagramProperties id={id} options={options} />
      )}
    </div>
  );
}
