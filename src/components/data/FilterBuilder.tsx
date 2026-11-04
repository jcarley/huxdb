import { Fragment } from "react";
import { Plus, X } from "lucide-react";
import { isComplete, isFilled, newCondition, newGroup, operatorsFor, operatorsForAny, removeNode, sameFilter, updateNode, valueKind, withColumn, withOperator } from "../../lib/filterTree";
import type { Operator } from "../../lib/filterTree";
import type { DataColumn, FilterCondition, FilterCustom, FilterGroup, FilterNode } from "../../lib/types";
import { pendingCount, specLocked, useDataEditor } from "../../stores/dataEditor";

interface Builder {
  columns: DataColumn[];
  edit: (id: string, change: (node: FilterNode) => FilterNode) => void;
  remove: (id: string) => void;
  apply: () => void;
}

/** The docked filter pane: a tree of conditions and bracket groups, edited as a
 * draft until Apply. Subscribes to the draft alone, so typing leaves the grid be. */
export function FilterBuilder({ id }: { id: string }) {
  const draft = useDataEditor((s) => s.editors[id]?.filterDraft);
  const applied = useDataEditor((s) => s.editors[id]?.spec.filter ?? null);
  const columns = useDataEditor((s) => s.editors[id]?.source?.columns);
  const locked = useDataEditor((s) => specLocked(s.editors[id]));
  const pending = useDataEditor((s) => !!s.editors[id] && pendingCount(s.editors[id]) > 0);
  if (!draft || !columns) return null;

  const store = useDataEditor.getState();
  const builder: Builder = {
    columns,
    edit: (node, change) => store.setDraft(id, (d) => updateNode(d, node, change)),
    remove: (node) => store.setDraft(id, (d) => removeNode(d, node)),
    apply: () => store.applyDraft(id),
  };
  const complete = isComplete(draft);
  const changed = !sameFilter(draft, applied);
  const hint = pending ? "Commit or cancel your changes first" : !complete ? "Fill in the marked values, or turn those conditions off" : undefined;

  return (
    <div className="h-44 max-h-[60vh] min-h-20 shrink-0 resize-y overflow-auto border-b border-base-300 bg-base-200/30 text-xs">
      <div className="flex flex-col gap-1 p-2">
        <GroupBody group={draft} builder={builder} />
        <div className="flex items-center gap-2 pr-4">
          <div className="flex-1" />
          {changed && <span className="text-base-content/60">Unapplied changes</span>}
          <button type="button" className="btn btn-primary btn-xs" title={hint} disabled={locked || !complete || !changed} onClick={builder.apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/** A group's rows, with its operator between them, and its add buttons. */
function GroupBody({ group, builder }: { group: FilterGroup; builder: Builder }) {
  const add = (child: FilterNode) => builder.edit(group.id, (node) => (node.kind === "group" ? { ...node, children: [...node.children, child] } : node));
  const setOp = (op: FilterGroup["op"]) => builder.edit(group.id, (node) => (node.kind === "group" ? { ...node, op } : node));
  const first = builder.columns[0];

  return (
    <div className="flex flex-col gap-1">
      {group.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <span className="pl-6 font-mono text-[0.65rem] text-base-content/60">{group.op.toUpperCase()}</span>}
          {child.kind === "group" ? <GroupRow group={child} builder={builder} /> : <ConditionRow node={child} builder={builder} />}
        </Fragment>
      ))}
      <div className="flex items-center gap-1">
        <button type="button" className="btn btn-ghost btn-xs font-normal" disabled={!first} onClick={() => add(newCondition(first))}>
          <Plus className="size-3" /> Condition
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-xs font-normal"
          disabled={!first}
          onClick={() => add(newGroup(group.op === "and" ? "or" : "and", [newCondition(first)]))}
        >
          <Plus className="size-3" /> Group
        </button>
        <label className="ml-1 flex items-center gap-1 text-base-content/70">
          Join with
          <select className="select select-xs w-16" aria-label="Join conditions with" value={group.op} onChange={(e) => setOp(e.target.value as FilterGroup["op"])}>
            <option value="and">AND</option>
            <option value="or">OR</option>
          </select>
        </label>
      </div>
    </div>
  );
}

/** A bracket group: its toggles, then its contents indented behind a bracket. */
function GroupRow({ group, builder }: { group: FilterGroup; builder: Builder }) {
  return (
    <div className={group.disabled ? "opacity-50" : ""}>
      <div className="flex items-center gap-1">
        <NodeToggles node={group} builder={builder} />
        <span className="text-base-content/60">Group</span>
      </div>
      <div className="mt-1 ml-6 border-l-2 border-base-300 pl-2">
        <GroupBody group={group} builder={builder} />
      </div>
    </div>
  );
}

/** The enable checkbox, the NOT toggle and the remove button, which every row has. */
function NodeToggles({ node, builder }: { node: FilterNode; builder: Builder }) {
  return (
    <>
      <input
        type="checkbox"
        className="checkbox checkbox-xs"
        aria-label="Enabled"
        title="Enabled"
        checked={!node.disabled}
        onChange={(e) => builder.edit(node.id, (n) => ({ ...n, disabled: !e.target.checked }))}
      />
      <button
        type="button"
        className={`btn btn-xs font-mono ${node.negated ? "btn-neutral" : "btn-ghost text-base-content/50"}`}
        aria-pressed={node.negated}
        title="Negate (NOT)"
        onClick={() => builder.edit(node.id, (n) => ({ ...n, negated: !n.negated }))}
      >
        NOT
      </button>
      <button type="button" className="btn btn-ghost btn-xs btn-square order-last" aria-label="Remove" title="Remove" onClick={() => builder.remove(node.id)}>
        <X className="size-3.5" />
      </button>
    </>
  );
}

function ConditionRow({ node, builder }: { node: FilterCondition | FilterCustom; builder: Builder }) {
  const { columns } = builder;
  const column = node.kind === "condition" ? columns.find((c) => c.name === node.column) : undefined;
  const setCondition = (change: (c: FilterCondition) => FilterCondition) =>
    builder.edit(node.id, (n) => (n.kind === "condition" ? change(n) : n));
  const setOperator = (op: Operator) =>
    builder.edit(node.id, (n) => (n.kind === "group" ? n : withOperator(n, op, columns)));

  return (
    <div className={`flex items-center gap-1 ${node.disabled ? "opacity-50" : ""}`}>
      <NodeToggles node={node} builder={builder} />
      {node.kind === "condition" && (
        <select
          className="select select-xs w-40 shrink-0"
          aria-label="Column"
          value={node.column}
          onChange={(e) => {
            const next = columns.find((c) => c.name === e.target.value);
            if (next) setCondition((c) => withColumn(c, next));
          }}
        >
          {!column && <option value={node.column}>{node.column}</option>}
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      <select
        className="select select-xs w-28 shrink-0"
        aria-label="Operator"
        value={node.kind === "custom" ? "custom" : node.op}
        onChange={(e) => setOperator(e.target.value as Operator)}
      >
        {(node.kind === "custom" ? operatorsForAny(columns) : operatorsFor(column)).map(({ op, label }) => (
          <option key={op} value={op}>
            {label}
          </option>
        ))}
      </select>
      <ValueInputs node={node} setCondition={setCondition} builder={builder} />
    </div>
  );
}

function ValueInputs({
  node,
  setCondition,
  builder,
}: {
  node: FilterCondition | FilterCustom;
  setCondition: (change: (c: FilterCondition) => FilterCondition) => void;
  builder: Builder;
}) {
  // Disabled rows don't count as incomplete; an unfilled enabled one is marked.
  const missing = !isFilled(node);
  const input = (label: string, value: string, onChange: (text: string) => void, mono = false) => (
    <input
      className={`input input-xs min-w-24 flex-1 ${mono ? "font-mono" : ""} ${missing && value === "" ? "input-warning" : ""}`}
      aria-label={label}
      value={value}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && builder.apply()}
    />
  );

  if (node.kind === "custom") {
    const setSql = (sql: string) => builder.edit(node.id, (n) => (n.kind === "custom" ? { ...n, sql } : n));
    return input("SQL expression", node.sql, setSql, true);
  }
  const setValues = (values: string[]) => setCondition((c) => ({ ...c, values }));

  switch (valueKind(node.op)) {
    case "none":
      return <div className="flex-1" />;
    case "one":
      return input("Value", node.value ?? "", (value) => setCondition((c) => ({ ...c, value })));
    case "two":
      return (
        <>
          {input("From", node.values[0] ?? "", (from) => setValues([from, node.values[1] ?? ""]))}
          <span className="text-base-content/60">and</span>
          {input("To", node.values[1] ?? "", (to) => setValues([node.values[0] ?? "", to]))}
        </>
      );
    case "list":
      return (
        <textarea
          className={`textarea textarea-xs min-h-0 min-w-24 flex-1 ${missing ? "textarea-warning" : ""}`}
          aria-label="Values, one per line"
          placeholder="One value per line"
          rows={Math.min(4, Math.max(2, node.values.length))}
          value={node.values.join("\n")}
          spellCheck={false}
          onChange={(e) => setValues(e.target.value.split(/\r?\n/))}
        />
      );
  }
}
