import { useState } from "react";
import type { FormEvent } from "react";
import { Modal } from "../Modal";

interface NameDialogProps {
  /** "table" or "view", for the title and placeholder. */
  noun: string;
  initial: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}

/** Asks for a new object's name on its first save, as Navicat does. */
export function NameDialog({ noun, initial, onCancel, onSave }: NameDialogProps) {
  const [name, setName] = useState(initial);
  const title = `${noun[0].toUpperCase()}${noun.slice(1)} Name`;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSave(name.trim());
  };

  return (
    <Modal title={title} onClose={onCancel}>
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
        <div className="modal-action">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
