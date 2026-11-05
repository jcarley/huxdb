import { useState } from "react";
import type { SubmitEvent } from "react";
import { Modal } from "../Modal";

interface NameDialogProps {
  /** "table", "view" or "query", for the title and placeholder. */
  noun: string;
  initial: string;
  /** Why the last name was refused, for a dialog that stays open while saving. */
  error?: string | null;
  busy?: boolean;
  onCancel: () => void;
  onSave: (name: string) => void;
}

/** Asks for a new object's name on its first save, as Navicat does. */
export function NameDialog({ noun, initial, error, busy, onCancel, onSave }: NameDialogProps) {
  const [name, setName] = useState(initial);
  const title = `${noun[0].toUpperCase()}${noun.slice(1)} Name`;

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    if (name.trim() && !busy) onSave(name.trim());
  };

  return (
    <Modal title={title} onClose={onCancel} dismissible={!busy}>
      <form onSubmit={onSubmit}>
        <input
          className="input w-full"
          data-autofocus
          value={name}
          placeholder={`Enter a ${noun} name`}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setName(e.target.value)}
        />
        {error && <div className="alert alert-error mt-4 text-sm">{error}</div>}
        <div className="modal-action">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
