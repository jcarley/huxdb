import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../lib/api";
import { errorMessage } from "../../lib/api";
import type { DiagramCandidate } from "../../lib/types";
import { useDiagrams } from "../../stores/diagram";
import type { DiagramTarget } from "../../stores/diagram";
import { useTabs } from "../../stores/tabs";
import { Modal } from "../Modal";

/** Past this, pan and zoom stop being smooth. Choosing fewer tables also reads better. */
const LARGE_DIAGRAM = 300;

/** The New Diagram dialog. Mounted always, and renders only while the store has a picker open. */
export function DiagramPicker() {
  const picker = useDiagrams((s) => s.picker);
  return picker ? <Picker key={`${picker.connectionId}/${picker.database}/${picker.schema}`} target={picker} /> : null;
}

function SchemaCheckbox({ state, disabled, onChange }: { state: "all" | "some" | "none"; disabled: boolean; onChange: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" className="checkbox checkbox-xs" checked={state === "all"} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
}

function Picker({ target }: { target: DiagramTarget }) {
  const { closePicker } = useDiagrams.getState();
  const [candidates, setCandidates] = useState<DiagramCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");

  useEffect(() => {
    let current = true;
    api
      .diagramCandidates(target.connectionId, target.database)
      .then((list) => {
        if (!current) return;
        setCandidates(list);
        setChosen(new Set(list.filter((c) => c.schema === target.schema).map((c) => c.oid)));
      })
      .catch((err) => current && setError(errorMessage(err)));
    return () => {
      current = false;
    };
  }, [target]);

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const bySchema = new Map<string, DiagramCandidate[]>();
    for (const c of candidates ?? []) {
      if (needle && !c.name.toLowerCase().includes(needle)) continue;
      bySchema.set(c.schema, [...(bySchema.get(c.schema) ?? []), c]);
    }
    return [...bySchema];
  }, [candidates, search]);

  const toggle = (tables: DiagramCandidate[], on: boolean) =>
    setChosen((old) => {
      const next = new Set(old);
      for (const t of tables) {
        if (on) next.add(t.oid);
        else next.delete(t.oid);
      }
      return next;
    });

  const create = () => {
    closePicker();
    useTabs.getState().openDiagram({ connectionId: target.connectionId, database: target.database, schema: "" }, [...chosen]);
  };

  return (
    <Modal title={`New Diagram: ${target.database}`} onClose={closePicker} className="flex max-h-[80vh] max-w-xl flex-col">
      {error ? (
        <p className="py-2 whitespace-pre-wrap text-error select-text">{error}</p>
      ) : !candidates ? (
        <div className="flex items-center gap-2 py-6 text-base-content/60">
          <span className="loading loading-spinner loading-sm" /> Reading the database…
        </div>
      ) : (
        <>
          <input type="search" className="input input-sm w-full shrink-0" placeholder="Search tables" value={search} onChange={(e) => setSearch(e.target.value)} data-autofocus />
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded border border-base-300 p-1 text-sm">
            {groups.length === 0 && <p className="p-3 text-base-content/60">{candidates.length ? "No tables match." : "This database has no tables."}</p>}
            {groups.map(([schema, tables]) => {
              const ticked = tables.filter((t) => chosen.has(t.oid)).length;
              return (
                <div key={schema}>
                  <label className="flex items-center gap-2 rounded px-1 py-1 font-semibold hover:bg-base-200">
                    <SchemaCheckbox state={ticked === 0 ? "none" : ticked === tables.length ? "all" : "some"} disabled={false} onChange={(on) => toggle(tables, on)} />
                    {schema}
                    <span className="font-normal text-base-content/50">{tables.length}</span>
                  </label>
                  {tables.map((table) => (
                    <label key={table.oid} className="flex items-center gap-2 rounded py-0.5 pr-1 pl-6 hover:bg-base-200">
                      <input type="checkbox" className="checkbox checkbox-xs" checked={chosen.has(table.oid)} onChange={(e) => toggle([table], e.target.checked)} />
                      <span className="truncate">{table.name}</span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-base-content/60">
            {chosen.size} of {candidates.length} tables chosen
          </p>
          {chosen.size > LARGE_DIAGRAM && (
            <div role="alert" className="alert alert-warning mt-2 py-2 text-xs">
              A diagram of more than {LARGE_DIAGRAM} tables is slow to move around and hard to read. Choosing related tables usually works better.
            </div>
          )}
        </>
      )}
      <div className="modal-action">
        <button type="button" className="btn btn-ghost btn-sm" onClick={closePicker}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={chosen.size === 0} onClick={create}>
          Create
        </button>
      </div>
    </Modal>
  );
}
