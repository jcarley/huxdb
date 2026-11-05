import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { ConnectionConfig, SavedQuerySummary } from "../lib/types";
import { useConnections } from "../stores/connections";
import { Modal } from "./Modal";

export function ConfirmDeleteDialog() {
  const pendingDelete = useConnections((s) => s.pendingDelete);
  // Keyed so busy/error state resets for each delete prompt.
  return pendingDelete ? <ConfirmDelete key={pendingDelete.id} pendingDelete={pendingDelete} /> : null;
}

function ConfirmDelete({ pendingDelete }: { pendingDelete: ConnectionConfig }) {
  const { cancelDelete, confirmDelete } = useConnections();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queries, setQueries] = useState<SavedQuerySummary | null>(null);
  const [deleteQueries, setDeleteQueries] = useState(false);
  const queryCount = queries?.count ?? 0;

  useEffect(() => {
    let current = true;
    api.savedQuerySummary(pendingDelete.id).then((summary) => current && setQueries(summary)).catch(() => {});
    return () => {
      current = false;
    };
  }, [pendingDelete.id]);

  const onDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await confirmDelete(deleteQueries);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Delete Connection" onClose={cancelDelete} dismissible={!busy}>
      <p>
        Are you sure you want to delete <strong>{pendingDelete.name}</strong>? This cannot be undone.
      </p>
      {queryCount > 0 && (
        <div className="mt-4 text-sm">
          <label className="label cursor-pointer justify-start gap-2 text-base-content">
            <input type="checkbox" className="checkbox checkbox-sm" checked={deleteQueries} disabled={busy} onChange={(e) => setDeleteQueries(e.target.checked)} />
            Also delete its {queryCount === 1 ? "saved query" : `${queryCount} saved queries`}
          </label>
          {!deleteQueries && <p className="mt-1 text-xs break-all text-base-content/60 select-text">Otherwise the files stay in {queries?.dir}</p>}
        </div>
      )}
      {error && <div className="alert alert-error mt-4 text-sm">{error}</div>}
      <div className="modal-action">
        <button type="button" className="btn" onClick={cancelDelete} disabled={busy}>
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
