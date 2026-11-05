import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDataEditor } from "../stores/dataEditor";
import { closeQuestion } from "../lib/queryFiles";
import { queryTextDirty, useQueryEditor } from "../stores/queryEditor";
import { useSavedDiagrams } from "../stores/savedDiagrams";
import { useSavedQueries } from "../stores/savedQueries";
import { useTableDesigner } from "../stores/tableDesigner";
import { useViewDesigner } from "../stores/viewDesigner";
import { tabTitle, useTabs } from "../stores/tabs";
import { Modal } from "./Modal";

/** Save / Discard / Cancel for closing a tab with unsaved edits or text, Commit / Rollback / Cancel
 * for a data or query tab with pending edits or an open transaction (a query tab with
 * both asks about each in turn), and the quit warning. */
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
  const textDirty = useQueryEditor((s) => queryTextDirty(s.editors[id]));
  const [textHandled, setTextHandled] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!tab) return null;

  const commits = closeQuestion(tab.kind, textDirty, textHandled) === "commit";
  const isQuery = tab.kind === "query";
  /** After the text: a query tab's transaction still gets its own question. */
  const closeOrAskCommit = () => {
    if (useQueryEditor.getState().editors[id]?.tx === "idle") close(id);
    else setTextHandled(true);
  };

  const onSaveText = async () => {
    setBusy(true);
    const saved = await useSavedQueries.getState().save(id);
    setBusy(false);
    // Either it failed, with its error in the tab, or it needs a name first, and the tab stays open.
    if (saved) closeOrAskCommit();
    else cancelClose();
  };

  const onSaveDiagram = async () => {
    setBusy(true);
    const saved = await useSavedDiagrams.getState().save(id);
    setBusy(false);
    // Either it failed, or it needs a name first, and the tab stays open.
    if (saved) close(id);
    else cancelClose();
  };

  const onSave = async () => {
    if (tab.kind === "diagram") return onSaveDiagram();
    if (isQuery && !commits) return onSaveText();
    const designer = commits ? null : tab.kind === "table" ? useTableDesigner.getState() : useViewDesigner.getState();
    if (designer?.designers[id]?.original === null) {
      // A new table or view needs its name first; the designer asks, and the tab stays open.
      cancelClose();
      designer.requestSave(id);
      return;
    }
    setBusy(true);
    // A data tab applies its pending edits and commits its transaction.
    const saved = await (designer ? designer.save(id) : isQuery ? useQueryEditor.getState().commit(id) : useDataEditor.getState().save(id));
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
        <button type="button" className="btn" onClick={isQuery && !commits ? closeOrAskCommit : () => close(id)} disabled={busy}>
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
