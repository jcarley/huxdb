import { useState } from "react";
import { errorMessage } from "../lib/api";
import { withoutSqlExtension } from "../lib/queryFiles";
import { useSavedQueries } from "../stores/savedQueries";
import type { QueryPrompt } from "../stores/savedQueries";
import { useTabs } from "../stores/tabs";
import { NameDialog } from "./designer/NameDialog";
import { Modal } from "./Modal";

/** Save As, Rename and Delete for saved queries, and failures with no tab to show them in. */
export function SavedQueryDialogs() {
  const prompt = useSavedQueries((s) => s.prompt);
  const error = useSavedQueries((s) => s.error);
  const dismissError = useSavedQueries((s) => s.dismissError);
  return (
    <>
      {prompt?.kind === "delete" && <ConfirmDelete key={prompt.query.id} name={prompt.query.name} />}
      {prompt?.kind === "overwrite" && <ConfirmOverwrite tabId={prompt.tabId} message={prompt.message} />}
      {(prompt?.kind === "save-as" || prompt?.kind === "rename") && <QueryName key={prompt.kind} prompt={prompt} />}
      {error && (
        <Modal title="Saved Queries" onClose={dismissError}>
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
function QueryName({ prompt }: { prompt: Extract<QueryPrompt, { kind: "save-as" | "rename" }> }) {
  const { saveAs, rename, setPrompt } = useSavedQueries.getState();
  const tab = useTabs((s) => (prompt.kind === "save-as" ? s.tabs.find((t) => t.id === prompt.tabId) : undefined));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await (prompt.kind === "save-as" ? saveAs(prompt.tabId, name) : rename(name));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return <NameDialog noun="query" initial={prompt.kind === "rename" ? prompt.query.name : withoutSqlExtension(tab?.name ?? "")} error={error} busy={busy} onCancel={() => setPrompt(null)} onSave={onSave} />;
}

/** The file changed outside huxdb since this tab read it. */
function ConfirmOverwrite({ tabId, message }: { tabId: string; message: string }) {
  const { save, setPrompt } = useSavedQueries.getState();
  const cancel = () => setPrompt(null);
  return (
    <Modal title="File Changed" onClose={cancel}>
      <p className="break-words select-text">{message}</p>
      <p className="mt-2">Saving replaces those changes with this tab's text.</p>
      <div className="modal-action">
        <button type="button" className="btn" onClick={cancel} data-autofocus>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-error"
          onClick={() => {
            cancel();
            void save(tabId, true);
          }}
        >
          Overwrite
        </button>
      </div>
    </Modal>
  );
}

function ConfirmDelete({ name }: { name: string }) {
  const { confirmDelete, setPrompt } = useSavedQueries.getState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => setPrompt(null);

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
    <Modal title="Delete Query" onClose={cancel} dismissible={!busy}>
      <p>
        Are you sure you want to delete <strong>{name}</strong>? This cannot be undone.
      </p>
      {error && <div className="alert alert-error mt-4 text-sm">{error}</div>}
      <div className="modal-action">
        <button type="button" className="btn" onClick={cancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-error" onClick={onDelete} disabled={busy}>
          {busy && <span className="loading loading-spinner loading-sm" />}
          Delete
        </button>
      </div>
    </Modal>
  );
}
