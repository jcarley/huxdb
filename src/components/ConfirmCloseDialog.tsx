import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDataEditor } from "../stores/dataEditor";
import { useQueryEditor } from "../stores/queryEditor";
import { useTableDesigner } from "../stores/tableDesigner";
import { useViewDesigner } from "../stores/viewDesigner";
import { tabTitle, useTabs } from "../stores/tabs";
import { Modal } from "./Modal";

/** Save / Discard / Cancel for closing a tab with unsaved edits (Commit / Rollback / Cancel
 * for a data or query tab with pending edits or an open transaction), and the quit warning. */
export function ConfirmCloseDialog() {
  const pendingClose = useTabs((s) => s.pendingClose);
  const quitRequested = useTabs((s) => s.quitRequested);
  if (pendingClose) return <ConfirmClose key={pendingClose} id={pendingClose} />;
  if (quitRequested) return <ConfirmQuit />;
  return null;
}

function ConfirmClose({ id }: { id: string }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === id));
  const { cancelClose, close } = useTabs.getState();
  const [busy, setBusy] = useState(false);
  if (!tab) return null;

  // Data and query tabs commit rather than save.
  const commits = tab.kind === "data" || tab.kind === "query";

  const onSave = async () => {
    const designer = commits ? null : tab.kind === "table" ? useTableDesigner.getState() : useViewDesigner.getState();
    if (designer?.designers[id]?.original === null) {
      // A new table or view needs its name first; the designer asks, and the tab stays open.
      cancelClose();
      designer.requestSave(id);
      return;
    }
    setBusy(true);
    // A data tab applies its pending edits and commits its transaction.
    const saved = await (designer ?? (tab.kind === "query" ? useQueryEditor.getState() : useDataEditor.getState())).save(id);
    setBusy(false);
    // A failed save leaves the tab open with its error showing.
    if (saved) close(id);
    else cancelClose();
  };

  return (
    <Modal title="Unsaved Changes" onClose={cancelClose} dismissible={!busy}>
      <p>
        Do you want to {commits ? "commit" : "save"} the changes to <strong>{tabTitle(tab)}</strong>?
      </p>
      <div className="modal-action">
        <button type="button" className="btn" onClick={cancelClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn" onClick={() => close(id)} disabled={busy}>
          {commits ? "Rollback" : "Discard"}
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy} data-autofocus>
          {busy && <span className="loading loading-spinner loading-sm" />}
          {commits ? "Commit" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

function ConfirmQuit() {
  const setQuitRequested = useTabs((s) => s.setQuitRequested);
  const cancel = () => setQuitRequested(false);

  return (
    <Modal title="Unsaved Changes" onClose={cancel}>
      <p>Some tabs have unsaved changes or open transactions. Quit huxdb and discard them?</p>
      <div className="modal-action">
        <button type="button" className="btn" onClick={cancel} data-autofocus>
          Cancel
        </button>
        <button type="button" className="btn btn-error" onClick={() => void getCurrentWindow().destroy()}>
          Discard and Quit
        </button>
      </div>
    </Modal>
  );
}
