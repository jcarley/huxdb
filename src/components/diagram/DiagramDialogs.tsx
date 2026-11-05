import { useState } from "react";
import { errorMessage } from "../../lib/api";
import type { DriftReport } from "../../lib/diagramDrift";
import { useDiagrams } from "../../stores/diagram";
import { useSavedDiagrams } from "../../stores/savedDiagrams";
import type { DiagramPrompt } from "../../stores/savedDiagrams";
import { useTabs } from "../../stores/tabs";
import { NameDialog } from "../designer/NameDialog";
import { Modal } from "../Modal";

/** Save As, Rename, Delete, Overwrite and the change report, plus failures with no tab to show them in. */
export function DiagramDialogs() {
  const prompt = useSavedDiagrams((s) => s.prompt);
  const error = useSavedDiagrams((s) => s.error);
  const dismissError = useSavedDiagrams((s) => s.dismissError);
  return (
    <>
      {prompt?.kind === "delete" && <ConfirmDelete key={prompt.diagram.id} name={prompt.diagram.name} />}
      {prompt?.kind === "overwrite" && <ConfirmOverwrite tabId={prompt.tabId} message={prompt.message} />}
      {(prompt?.kind === "save-as" || prompt?.kind === "rename") && <DiagramName key={prompt.kind} prompt={prompt} />}
      {prompt?.kind === "report" && <Report key={prompt.tabId} tabId={prompt.tabId} />}
      {error && (
        <Modal title="Diagrams" onClose={dismissError}>
          <p className="whitespace-pre-wrap select-text">{error}</p>
          <div className="modal-action">
            <button type="button" className="btn btn-primary" onClick={dismissError} data-autofocus>
              OK
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Stays open with the error when a name is taken. */
function DiagramName({ prompt }: { prompt: Extract<DiagramPrompt, { kind: "save-as" | "rename" }> }) {
  const { saveAs, rename, setPrompt } = useSavedDiagrams.getState();
  const tab = useTabs((s) => (prompt.kind === "save-as" ? s.tabs.find((t) => t.id === prompt.tabId) : undefined));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = prompt.kind === "rename" ? prompt.diagram.name : (tab?.name ?? "");

  const onSave = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await (prompt.kind === "rename" ? rename(name) : saveAs(prompt.tabId, name));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return <NameDialog noun="diagram" initial={initial} error={error} busy={busy} onCancel={() => setPrompt(null)} onSave={onSave} />;
}

function ConfirmDelete({ name }: { name: string }) {
  const { confirmDelete, setPrompt } = useSavedDiagrams.getState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await confirmDelete();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Delete Diagram" onClose={() => setPrompt(null)} dismissible={!busy}>
      <p>
        Are you sure you want to delete <strong>{name}</strong>? The database isn't touched.
      </p>
      {error && <div className="alert alert-error mt-4 text-sm">{error}</div>}
      <div className="modal-action">
        <button type="button" className="btn" onClick={() => setPrompt(null)} disabled={busy} data-autofocus>
          Cancel
        </button>
        <button type="button" className="btn btn-error" onClick={onDelete} disabled={busy}>
          Delete
        </button>
      </div>
    </Modal>
  );
}

function ConfirmOverwrite({ tabId, message }: { tabId: string; message: string }) {
  const { save, setPrompt } = useSavedDiagrams.getState();
  return (
    <Modal title="Diagram Changed" onClose={() => setPrompt(null)}>
      <p>{message}</p>
      <p className="mt-2">Overwrite it with this tab's diagram?</p>
      <div className="modal-action">
        <button type="button" className="btn" onClick={() => setPrompt(null)} data-autofocus>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-error"
          onClick={() => {
            setPrompt(null);
            void save(tabId, true);
          }}
        >
          Overwrite
        </button>
      </div>
    </Modal>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="mt-3 first:mt-0">
      <h3 className="mb-1 text-sm font-semibold">
        {title} <span className="font-normal text-base-content/50">{count}</span>
      </h3>
      <ul className="text-sm">{children}</ul>
    </section>
  );
}

/** What changed since the diagram was saved. Nothing here touches the database. */
function Report({ tabId }: { tabId: string }) {
  const report = useDiagrams((s) => s.diagrams[tabId]?.report);
  const { setPrompt } = useSavedDiagrams.getState();
  const [add, setAdd] = useState<Set<number>>(new Set());
  const [renames, setRenames] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!report) return null;
  const { added, removed, modified, foreignKeys }: DriftReport = report;

  const flip = <T,>(set: Set<T>, value: T, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await useDiagrams.getState().acceptReport(tabId, { add: [...add], renames: [...renames] });
      setPrompt(null);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Changes in the Database" onClose={() => setPrompt(null)} dismissible={!busy} className="flex max-h-[80vh] max-w-xl flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto select-text">
        <Section title="New tables" count={added.length}>
          {added.map((c) => (
            <li key={c.oid}>
              <label className="flex items-center gap-2 rounded py-0.5 hover:bg-base-200">
                <input type="checkbox" className="checkbox checkbox-xs" checked={add.has(c.oid)} disabled={busy} onChange={(e) => setAdd(flip(add, c.oid, e.target.checked))} />
                <span>Add {c.schema}.{c.name}</span>
              </label>
            </li>
          ))}
        </Section>
        <Section title="Removed" count={removed.length}>
          {removed.map((r) => (
            <li key={r.key} className="py-0.5">
              {r.schema}.{r.name}
              {r.renamedTo && (
                <label className="ml-1 flex items-center gap-2 rounded py-0.5 hover:bg-base-200">
                  <input type="checkbox" className="checkbox checkbox-xs" checked={renames.has(r.key)} disabled={busy} onChange={(e) => setRenames(flip(renames, r.key, e.target.checked))} />
                  <span>
                    Possibly renamed to {r.renamedTo.schema}.{r.renamedTo.name}. Keep its place
                  </span>
                </label>
              )}
            </li>
          ))}
        </Section>
        <Section title="Modified" count={modified.length}>
          {modified.map((m) => (
            <li key={m.key} className="py-0.5">
              {m.schema}.{m.name}
              <ul className="ml-4 text-base-content/70">
                {m.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </li>
          ))}
        </Section>
        <Section title="Foreign keys" count={foreignKeys.length}>
          {foreignKeys.map((line) => (
            <li key={line} className="py-0.5">
              {line}
            </li>
          ))}
        </Section>
      </div>
      {error && <div className="alert alert-error mt-3 text-sm">{error}</div>}
      <div className="modal-action">
        <button type="button" className="btn btn-sm" onClick={() => setPrompt(null)} disabled={busy}>
          Later
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void accept()} disabled={busy} data-autofocus>
          {busy && <span className="loading loading-spinner loading-xs" />}
          Accept
        </button>
      </div>
    </Modal>
  );
}
