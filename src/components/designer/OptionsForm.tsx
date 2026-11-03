import { useState } from "react";
import type { ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { useRoles, useSchemas, useTables, useTablespaces } from "../../lib/catalog";
import type { Lookup } from "../../lib/catalog";
import { PARTITION_STRATEGIES } from "../../lib/types";
import type { PartitionStrategy, QualifiedName } from "../../lib/types";
import { optionErrors, useTableDesigner } from "../../stores/tableDesigner";
import { ColumnPickerDialog } from "./ColumnPickerDialog";

/** Names from a lookup, plus `current` when it isn't among them (yet). */
function namesWith(lookup: Lookup, current: string | null): string[] {
  const names = lookup.status === "loaded" ? lookup.names : [];
  return current && !names.includes(current) ? [current, ...names] : names;
}

function Row({ label, htmlFor, error, note, children }: { label: string; htmlFor?: string; error?: string; note?: string; children: ReactNode }) {
  return (
    <>
      <label className="pt-1.5 text-base-content/70" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="flex flex-col gap-1">
        {children}
        {error && <span className="text-xs text-error">{error}</span>}
        {note && <span className="text-xs text-base-content/50">{note}</span>}
      </div>
    </>
  );
}

const REWRITE_NOTE = "Changing this on an existing table rewrites it and locks it while that runs.";

/** The Options tab: storage, ownership, inheritance and partitioning, as a form like Navicat's. */
export function OptionsForm({ id }: { id: string }) {
  const designer = useTableDesigner((s) => s.designers[id]);
  const setOptions = useTableDesigner((s) => s.setOptions);
  const connectionId = designer?.tab.connectionId ?? "";
  const database = designer?.tab.database ?? "";
  const roles = useRoles(connectionId, database);
  const tablespaces = useTablespaces(connectionId, database);
  if (!designer) return null;

  const { options } = designer.edited;
  const isNew = designer.original === null;
  const errors = designer.showErrors ? optionErrors(designer.edited) : {};

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="grid max-w-3xl grid-cols-[10rem_minmax(0,1fr)] items-start gap-x-4 gap-y-3 p-4 text-sm">
        <Row label="Owner" htmlFor="opt-owner">
          <select
            id="opt-owner"
            className="select select-sm w-64"
            value={options.owner ?? ""}
            onChange={(e) => setOptions(id, { owner: e.target.value || null })}
          >
            {(isNew || !options.owner) && <option value="">(current user)</option>}
            {namesWith(roles, options.owner).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Tablespace" htmlFor="opt-tablespace" note={isNew ? undefined : REWRITE_NOTE}>
          <select
            id="opt-tablespace"
            className="select select-sm w-64"
            value={options.tablespace ?? ""}
            onChange={(e) => setOptions(id, { tablespace: e.target.value || null })}
          >
            <option value="">(default)</option>
            {namesWith(tablespaces, options.tablespace).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Unlogged" note={isNew ? "Faster writes, but the table isn't crash-safe or replicated." : REWRITE_NOTE}>
          <input
            type="checkbox"
            className="checkbox checkbox-sm mt-1"
            checked={options.unlogged}
            onChange={(e) => setOptions(id, { unlogged: e.target.checked })}
          />
        </Row>

        <Row label="Fill Factor" htmlFor="opt-fill" error={errors.fillFactor} note="10–100; blank uses the default (100).">
          <input
            id="opt-fill"
            className={`input input-sm w-24 text-right tabular-nums ${errors.fillFactor ? "input-error" : ""}`}
            inputMode="numeric"
            value={options.fillFactor ?? ""}
            onChange={(e) => {
              const text = e.target.value.trim();
              setOptions(id, { fillFactor: /^\d+$/.test(text) ? Number(text) : null });
            }}
          />
        </Row>

        <Row label="Inherits from" error={errors.inherits}>
          <InheritsList id={id} parents={options.inherits} disabled={options.partitionBy !== null} />
        </Row>

        <Row label="Partition" error={errors.partitionBy}>
          {isNew ? (
            <PartitionEditor id={id} />
          ) : (
            <span className="pt-1.5 font-mono text-xs">
              {options.partitionKey
                ? `PARTITION BY ${options.partitionKey}`
                : options.partitionOf
                  ? `Partition of ${options.partitionOf}`
                  : "Not partitioned"}
            </span>
          )}
        </Row>
      </div>
    </div>
  );
}

function InheritsList({ id, parents, disabled }: { id: string; parents: QualifiedName[]; disabled: boolean }) {
  const designer = useTableDesigner((s) => s.designers[id]);
  const setOptions = useTableDesigner((s) => s.setOptions);
  if (!designer) return null;
  const set = (inherits: QualifiedName[]) => setOptions(id, { inherits });
  const { schema } = designer.tab;

  return (
    <div className="flex flex-col gap-1.5">
      {parents.map((p, i) => (
        <ParentRow
          key={i}
          connectionId={designer.tab.connectionId}
          database={designer.tab.database}
          value={p}
          onChange={(q) => set(parents.map((old, j) => (j === i ? q : old)))}
          onRemove={() => set(parents.filter((_, j) => j !== i))}
        />
      ))}
      <button type="button" className="btn btn-ghost btn-sm w-fit" disabled={disabled} onClick={() => set([...parents, { schema, name: "" }])}>
        <Plus className="size-4" /> Add parent table
      </button>
      {disabled && <span className="text-xs text-base-content/50">A partitioned table can't inherit from other tables.</span>}
    </div>
  );
}

function ParentRow({ connectionId, database, value, onChange, onRemove }: { connectionId: string; database: string; value: QualifiedName; onChange: (q: QualifiedName) => void; onRemove: () => void }) {
  const schemas = useSchemas(connectionId, database);
  const tables = useTables(connectionId, database, value.schema);
  return (
    <div className="join">
      <select className="select select-sm join-item w-48" value={value.schema} aria-label="Parent schema" onChange={(e) => onChange({ schema: e.target.value, name: "" })}>
        {namesWith(schemas, value.schema).map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <select className="select select-sm join-item w-56" value={value.name} aria-label="Parent table" onChange={(e) => onChange({ ...value, name: e.target.value })}>
        <option value="">{tables.status === "loading" ? "Loading…" : ""}</option>
        {namesWith(tables, value.name).map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-sm join-item" onClick={onRemove} aria-label={`Remove ${value.name || "parent"}`}>
        <X className="size-4" />
      </button>
    </div>
  );
}

/** PARTITION BY for a new table: a strategy and its key columns or expressions. */
function PartitionEditor({ id }: { id: string }) {
  const designer = useTableDesigner((s) => s.designers[id]);
  const setOptions = useTableDesigner((s) => s.setOptions);
  const [picking, setPicking] = useState(false);
  if (!designer) return null;
  const partition = designer.edited.options.partitionBy;
  const fields = designer.edited.columns.map((c) => c.name.trim()).filter(Boolean);

  return (
    <div className="flex items-center gap-2">
      <select
        className="select select-sm w-32"
        value={partition?.strategy ?? ""}
        aria-label="Partition strategy"
        onChange={(e) => {
          const strategy = e.target.value as PartitionStrategy | "";
          setOptions(id, { partitionBy: strategy ? { strategy, keys: partition?.keys ?? [] } : null });
        }}
      >
        <option value="">None</option>
        {PARTITION_STRATEGIES.map((s) => (
          <option key={s} value={s}>
            {s.toUpperCase()}
          </option>
        ))}
      </select>
      {partition && (
        <>
          <span className="font-mono text-xs">({partition.keys.join(", ")})</span>
          <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>
            Keys…
          </button>
        </>
      )}
      {picking && partition && (
        <ColumnPickerDialog
          title="Partition Keys"
          available={fields}
          value={partition.keys.map((column) => ({ column }))}
          withExpressions
          onSave={(keys) => setOptions(id, { partitionBy: { ...partition, keys: keys.map((k) => k.column) } })}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
