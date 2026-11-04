import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { ListTree, Play, RotateCcw, RotateCw, Save, WandSparkles, X } from "lucide-react";
import * as api from "../../lib/api";
import { useRoles } from "../../lib/catalog";
import type { CheckOption } from "../../lib/types";
import { useViewDesigner } from "../../stores/viewDesigner";
import type { ResultPanel, ViewDesigner as Designer } from "../../stores/viewDesigner";
import { SqlEditor } from "../SqlEditor";
import { NameDialog } from "./NameDialog";
import { ToolButton } from "../ToolButton";

type SubTab = "definition" | "advanced" | "comment" | "sql";

const SUB_TABS: { tab: SubTab; label: string }[] = [
  { tab: "definition", label: "Definition" },
  { tab: "advanced", label: "Advanced" },
  { tab: "comment", label: "Comment" },
  { tab: "sql", label: "SQL Preview" },
];

/** Navicat-style view designer for one tab: create a view, or edit an existing one. */
export function ViewDesigner({ id }: { id: string }) {
  const designer = useViewDesigner((s) => s.designers[id]);
  const [subTab, setSubTab] = useState<SubTab>("definition");
  if (!designer) return null;
  const store = useViewDesigner.getState();

  if (designer.status !== "loaded") {
    return (
      <div className="flex flex-1 flex-col items-center gap-3 p-6 text-sm">
        {designer.status === "loading" ? (
          <span className="loading loading-spinner loading-md" />
        ) : (
          <>
            <p className="text-error select-text">{designer.loadError}</p>
            <button type="button" className="btn btn-sm" onClick={() => store.load(id)}>
              <RotateCw className="size-4" /> Retry
            </button>
          </>
        )}
      </div>
    );
  }

  const busy = designer.saving || designer.running;
  const runAndShow = (action: (id: string) => Promise<void>) => {
    setSubTab("definition");
    void action(id);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-0.5 border-b border-base-300 bg-base-200/50 px-2 py-1">
        <ToolButton icon={Save} label="Save" disabled={designer.saving} onClick={() => store.requestSave(id)} />
        <div className="divider divider-horizontal mx-1 my-1" />
        <ToolButton icon={Play} label="Preview" disabled={busy} onClick={() => runAndShow(store.preview)} />
        <ToolButton icon={ListTree} label="Explain" disabled={busy} onClick={() => runAndShow(store.explain)} />
        <ToolButton icon={WandSparkles} label="Beautify SQL" onClick={() => void store.beautify(id)} />
        {busy && <span className="loading loading-spinner loading-sm ml-2" />}
      </div>

      <div role="tablist" className="tabs tabs-border tabs-sm border-b border-base-300 px-2">
        {SUB_TABS.map(({ tab, label }) => (
          <button key={tab} type="button" role="tab" className={`tab ${subTab === tab ? "tab-active" : ""}`} onClick={() => setSubTab(tab)}>
            {label}
          </button>
        ))}
      </div>

      {designer.saveError && <SaveError id={id} designer={designer} />}

      {subTab === "definition" && <DefinitionTab id={id} designer={designer} />}
      {subTab === "advanced" && <AdvancedTab id={id} designer={designer} />}
      {subTab === "comment" && (
        <textarea
          className="textarea m-3 min-h-40 w-auto max-w-2xl"
          placeholder="View comment"
          value={designer.edited.comment ?? ""}
          onChange={(e) => store.update(id, { comment: e.target.value || null })}
        />
      )}
      {subTab === "sql" && <ViewSqlPreview designer={designer} />}

      {designer.askingName && (
        <NameDialog
          noun="view"
          initial={designer.edited.name}
          onCancel={() => store.setAskingName(id, false)}
          onSave={(name) => {
            store.setAskingName(id, false);
            void store.save(id, name);
          }}
        />
      )}
    </section>
  );
}

/** The save error; a column change CREATE OR REPLACE can't make offers a drop and re-create. */
function SaveError({ id, designer }: { id: string; designer: Designer }) {
  const store = useViewDesigner.getState();
  return (
    <div role="alert" className="alert alert-error alert-soft m-2 flex-col items-start gap-2 rounded-md py-2 text-sm">
      <pre className="font-sans whitespace-pre-wrap select-text">{designer.saveError}</pre>
      {designer.canRecreate && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-sm btn-error" disabled={designer.saving} onClick={() => void store.save(id, undefined, true)}>
            <RotateCcw className="size-4" /> Drop and re-create
          </button>
          <span className="text-xs">
            Drops the view and creates it again, restoring its owner, options and comment. It fails, changing nothing, if
            other views depend on it.
          </span>
        </div>
      )}
    </div>
  );
}

const MIN_PANEL = 80;

/** The SQL editor, with the Preview / Explain result in a resizable panel below. */
function DefinitionTab({ id, designer }: { id: string; designer: Designer }) {
  const update = useViewDesigner((s) => s.update);
  const closeResult = useViewDesigner((s) => s.closeResult);
  const [panelHeight, setPanelHeight] = useState(240);
  const container = useRef<HTMLDivElement>(null);

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    const onMove = (m: MouseEvent) => setPanelHeight(Math.min(Math.max(box.bottom - m.clientY, MIN_PANEL), box.height - MIN_PANEL));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div ref={container} className="flex min-h-0 flex-1 flex-col">
      <SqlEditor value={designer.edited.definition} onChange={(definition) => update(id, { definition })} className="min-h-0 flex-1" />
      {designer.result && (
        <>
          <div className="h-1.5 shrink-0 cursor-row-resize border-y border-base-300 bg-base-200 hover:bg-primary/30" onMouseDown={startResize} role="separator" aria-orientation="horizontal" />
          <div className="flex shrink-0 flex-col" style={{ height: panelHeight }}>
            <div className="flex items-center justify-between bg-base-200/50 px-2 py-0.5 text-xs text-base-content/60">
              <span>{resultTitle(designer.result)}</span>
              <button type="button" className="btn btn-ghost btn-xs btn-square" onClick={() => closeResult(id)} aria-label="Close results">
                <X className="size-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <ResultView result={designer.result} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function resultTitle(result: ResultPanel): string {
  switch (result.kind) {
    case "rows": {
      const n = result.result.rows.length;
      return result.result.truncated ? `Showing the first ${n} rows (read-only preview)` : `${n} row${n === 1 ? "" : "s"} (read-only preview)`;
    }
    case "plan":
      return "Query plan (EXPLAIN, not run)";
    case "error":
      return "Error";
  }
}

function ResultView({ result }: { result: ResultPanel }): ReactNode {
  if (result.kind === "error") return <pre className="p-2 text-sm whitespace-pre-wrap text-error select-text">{result.message}</pre>;
  if (result.kind === "plan") return <pre className="p-2 font-mono text-xs select-text">{result.lines.join("\n")}</pre>;
  const { columns, rows } = result.result;
  return (
    <table className="table table-xs table-pin-rows">
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={i}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r} className="hover:bg-base-300/40">
            {row.map((value, c) => (
              <td key={c} className="max-w-xs truncate select-text" title={value ?? undefined}>
                {value === null ? <span className="text-base-content/40 italic">NULL</span> : value}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const CHECK_OPTIONS: { value: CheckOption | ""; label: string }[] = [
  { value: "", label: "None" },
  { value: "local", label: "LOCAL" },
  { value: "cascaded", label: "CASCADED" },
];

/** View options, like Navicat's Advanced tab. */
function AdvancedTab({ id, designer }: { id: string; designer: Designer }) {
  const update = useViewDesigner((s) => s.update);
  const roles = useRoles(designer.tab.connectionId, designer.tab.database);
  const { edited } = designer;
  const isNew = designer.original === null;
  const names = roles.status === "loaded" ? roles.names : [];
  const owners = edited.owner && !names.includes(edited.owner) ? [edited.owner, ...names] : names;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="grid max-w-3xl grid-cols-[10rem_minmax(0,1fr)] items-start gap-x-4 gap-y-3 p-4 text-sm">
        <label className="pt-1.5 text-base-content/70" htmlFor="view-owner">
          Owner
        </label>
        <select id="view-owner" className="select select-sm w-64" value={edited.owner ?? ""} onChange={(e) => update(id, { owner: e.target.value || null })}>
          {(isNew || !edited.owner) && <option value="">(current user)</option>}
          {owners.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <label className="pt-1.5 text-base-content/70" htmlFor="view-check">
          Check Option
        </label>
        <div className="flex flex-col gap-1">
          <select
            id="view-check"
            className="select select-sm w-40"
            value={edited.checkOption ?? ""}
            onChange={(e) => update(id, { checkOption: (e.target.value || null) as CheckOption | null })}
          >
            {CHECK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-base-content/50">Rejects inserts and updates through the view that it wouldn't show. Only for updatable views.</span>
        </div>

        <span className="pt-1 text-base-content/70">Security Barrier</span>
        <div className="flex flex-col gap-1">
          <input type="checkbox" className="checkbox checkbox-sm mt-1" checked={edited.securityBarrier} onChange={(e) => update(id, { securityBarrier: e.target.checked })} />
          <span className="text-xs text-base-content/50">Keeps the planner from leaking hidden rows through functions; for row-level security views.</span>
        </div>

        <span className="pt-1 text-base-content/70">Security Invoker</span>
        <div className="flex flex-col gap-1">
          <input
            type="checkbox"
            className="checkbox checkbox-sm mt-1"
            checked={edited.securityInvoker}
            disabled={!edited.supportsSecurityInvoker}
            onChange={(e) => update(id, { securityInvoker: e.target.checked })}
          />
          <span className="text-xs text-base-content/50">
            {edited.supportsSecurityInvoker
              ? "Checks the underlying tables' permissions as the querying user, not the view owner."
              : "Needs PostgreSQL 15 or later."}
          </span>
        </div>
      </div>
    </div>
  );
}

/** The statements Save would run, regenerated whenever this tab is shown. */
function ViewSqlPreview({ designer }: { designer: Designer }) {
  const { original, edited } = designer;
  const [text, setText] = useState("");

  useEffect(() => {
    let ignore = false;
    // A new view has no name until its first save.
    const design = edited.name.trim() ? edited : { ...edited, name: "Untitled" };
    api.previewViewDdl(original, design, false).then(
      (statements) => !ignore && setText(statements.length ? statements.map((s) => `${s};`).join("\n\n") : "-- No changes"),
      (err) => !ignore && setText(`-- ${api.errorMessage(err)}`),
    );
    return () => {
      ignore = true;
    };
  }, [original, edited]);

  return <SqlEditor value={text} readOnly className="flex-1" />;
}
