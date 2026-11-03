import { useEffect } from "react";
import { ConfirmDeleteDialog } from "./components/ConfirmDeleteDialog";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { DetailsPane } from "./components/DetailsPane";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { useConnections } from "./stores/connections";
import "./App.css";

function App() {
  const load = useConnections((s) => s.load);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col bg-base-100 text-base-content">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <DetailsPane />
      </div>
      <ConnectionDialog />
      <ConfirmDeleteDialog />
    </div>
  );
}

export default App;
