import { useState } from "react";
import { errorMessage } from "../lib/api";
import type { ConnectionConfig } from "../lib/types";
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

  const onDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await confirmDelete();
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
