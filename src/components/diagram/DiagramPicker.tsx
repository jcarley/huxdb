import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../lib/api";
import { errorMessage } from "../../lib/api";
import { objectLabel } from "../../lib/diagramDrift";
import { groupCandidates, startingTicks } from "../../lib/diagramPicker";
import type { DiagramCandidate } from "../../lib/types";
import { useDiagrams } from "../../stores/diagram";
import type { DiagramTarget } from "../../stores/diagram";
import { useSavedDiagrams } from "../../stores/savedDiagrams";
import { useTabs } from "../../stores/tabs";
import { Modal } from "../Modal";
import { KIND_HEADINGS, OBJECT_ICONS } from "./objectIcons";

/** Past this, pan and zoom stop being smooth. Choosing fewer objects also reads better. */
const LARGE_DIAGRAM = 300;

/** The New Diagram dialog. Mounted always, and renders only while the store has a picker open. */
export function DiagramPicker() {
  const picker = useDiagrams((s) => s.picker);
  return picker ? <Picker key={`${picker.connectionId}/${picker.database}/${picker.schema}/${picker.tabId}`} target={picker} /> : null;
}

function SchemaCheckbox({ state, disabled, onChange }: { state: "all" | "some" | "none"; disabled: boolean; onChange: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" className="checkbox checkbox-xs" checked={state === "all"} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
}

const tickState = (objects: DiagramCandidate[], chosen: Set<number>) => {
  const ticked = objects.filter((o) => chosen.has(o.oid)).length;
  return ticked === 0 ? "none" : ticked === objects.length ? "all" : "some";
};

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
        setChosen(new Set(target.ticked ?? startingTicks(list, target.schema)));
      })
      .catch((err) => current && setError(errorMessage(err)));
    return () => {
      current = false;
    };
  }, [target]);

  const groups = useMemo(() => [...groupCandidates(candidates ?? [], search)], [candidates, search]);

  const toggle = (objects: DiagramCandidate[], on: boolean) =>
    setChosen((old) => {
      const next = new Set(old);
      for (const t of objects) {
        if (on) next.add(t.oid);
        else next.delete(t.oid);
      }
      return next;
    });

  const { tabId } = target;
  const create = () => {
    closePicker();
    if (tabId) void useDiagrams.getState().setTables(tabId, [...chosen]).catch((err) => useSavedDiagrams.setState({ error: errorMessage(err) }));
    else useTabs.getState().openDiagram({ connectionId: target.connectionId, database: target.database, schema: "" }, [...chosen]);
  };

  return (
    <Modal title={tabId ? "Objects on This Diagram" : `New Diagram: ${target.database}`} onClose={closePicker} className="flex max-h-[80vh] max-w-xl flex-col">
      {error ? (
        <p className="py-2 whitespace-pre-wrap text-error select-text">{error}</p>
      ) : !candidates ? (
        <div className="flex items-center gap-2 py-6 text-base-content/60">
          <span className="loading loading-spinner loading-sm" /> Reading the database…
        </div>
      ) : (
        <>
          <input type="search" className="input input-sm w-full shrink-0" placeholder="Search objects" value={search} onChange={(e) => setSearch(e.target.value)} data-autofocus />
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded border border-base-300 p-1 text-sm">
            {groups.length === 0 && <p className="p-3 text-base-content/60">{candidates.length ? "No objects match." : "This database has no objects to show."}</p>}
            {groups.map(([schema, kinds]) => {
              const all = kinds.flatMap(([, list]) => list);
              return (
                <div key={schema}>
                  <label className="flex items-center gap-2 rounded px-1 py-1 font-semibold hover:bg-base-200">
                    <SchemaCheckbox state={tickState(all, chosen)} disabled={false} onChange={(on) => toggle(all, on)} />
                    {schema}
                    <span className="font-normal text-base-content/50">{all.length}</span>
                  </label>
                  {kinds.map(([kind, list]) => (
                    <div key={kind}>
                      <label className="flex items-center gap-2 rounded py-0.5 pr-1 pl-5 text-xs font-semibold text-base-content/70 hover:bg-base-200">
                        <SchemaCheckbox state={tickState(list, chosen)} disabled={false} onChange={(on) => toggle(list, on)} />
                        {KIND_HEADINGS[kind]}
                        <span className="font-normal text-base-content/50">{list.length}</span>
                      </label>
                      {list.map((object) => {
                        const Icon = OBJECT_ICONS[object.kind];
                        return (
                          <label key={object.oid} className="flex items-center gap-2 rounded py-0.5 pr-1 pl-10 hover:bg-base-200">
                            <input type="checkbox" className="checkbox checkbox-xs" checked={chosen.has(object.oid)} onChange={(e) => toggle([object], e.target.checked)} />
                            <Icon className="size-3.5 shrink-0 text-base-content/60" strokeWidth={1.75} />
                            <span className="truncate" title={objectLabel(object)}>
                              {objectLabel(object)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-base-content/60">
            {chosen.size} of {candidates.length} objects chosen
          </p>
          {chosen.size > LARGE_DIAGRAM && (
            <div role="alert" className="alert alert-warning mt-2 py-2 text-xs">
              A diagram of more than {LARGE_DIAGRAM} objects is slow to move around and hard to read. Choosing related objects usually works better.
            </div>
          )}
        </>
      )}
      <div className="modal-action">
        <button type="button" className="btn btn-ghost btn-sm" onClick={closePicker}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={chosen.size === 0} onClick={create}>
          {tabId ? "Apply" : "Create"}
        </button>
      </div>
    </Modal>
  );
}
