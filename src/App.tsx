import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ConfirmCloseDialog } from "./components/ConfirmCloseDialog";
import { DiagramDialogs } from "./components/diagram/DiagramDialogs";
import { DiagramPicker } from "./components/diagram/DiagramPicker";
import { ConfirmDeleteDialog } from "./components/ConfirmDeleteDialog";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { MainArea } from "./components/MainArea";
import { SavedQueryDialogs } from "./components/SavedQueryDialogs";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { useConnections } from "./stores/connections";
import { hasUnsavedTabs, useTabs } from "./stores/tabs";
import "./App.css";

function App() {
  const load = useConnections((s) => s.load);

  useEffect(() => {
    load();
  }, [load]);

  // Closing the window with unsaved designer edits asks first.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      if (hasUnsavedTabs()) {
        event.preventDefault();
        useTabs.getState().setQuitRequested(true);
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-base-100 text-base-content">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <MainArea />
      </div>
      <ConnectionDialog />
      <ConfirmDeleteDialog />
      <ConfirmCloseDialog />
      <SavedQueryDialogs />
      <DiagramPicker />
      <DiagramDialogs />
    </div>
  );
}

export default App;
