import { Eye, Network, PencilRuler, SquareTerminal, Table, X } from "lucide-react";
import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { dataDirty, useDataEditor } from "../stores/dataEditor";
import { queryDirty, useQueryEditor } from "../stores/queryEditor";
import { designerDirty, useTableDesigner } from "../stores/tableDesigner";
import { tabTitle, useTabs } from "../stores/tabs";
import type { DesignerTab } from "../stores/tabs";
import { DetailsPane } from "./DetailsPane";
import { DataEditor } from "./data/DataEditor";
import { QueryEditor } from "./query/QueryEditor";
import { viewDirty, useViewDesigner } from "../stores/viewDesigner";
import { TableDesigner } from "./designer/TableDesigner";
import { ViewDesigner } from "./designer/ViewDesigner";

/** The main pane: a permanent Objects tab plus one closable tab per open designer, data editor or query. */
/** React Flow stays out of the main bundle until the first diagram. */
const DiagramTab = lazy(() => import("./diagram/DiagramTab"));

export function MainArea() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const activate = useTabs((s) => s.activate);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <div role="tablist" className="tabs tabs-lift tabs-sm shrink-0 overflow-x-auto bg-base-200/60 px-1 pt-1">
        <TabButton active={activeId === null} onClick={() => activate(null)}>
          Objects
        </TabButton>
        {tabs.map((tab) => (
          <DesignerTabButton key={tab.id} tab={tab} active={activeId === tab.id} />
        ))}
      </div>
      {/* Every tab stays mounted so switching keeps scroll positions and editor state. */}
      <div className={`min-h-0 flex-1 ${activeId === null ? "flex" : "hidden"}`}>
        <DetailsPane />
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} className={`min-h-0 flex-1 ${activeId === tab.id ? "flex" : "hidden"}`}>
          <TabContent tab={tab} />
        </div>
      ))}
    </main>
  );
}

function TabContent({ tab }: { tab: DesignerTab }) {
  switch (tab.kind) {
    case "table":
      return <TableDesigner id={tab.id} />;
    case "view":
      return <ViewDesigner id={tab.id} />;
    case "data":
      return <DataEditor id={tab.id} />;
    case "query":
      return <QueryEditor id={tab.id} />;
    case "diagram":
      return (
        <Suspense fallback={null}>
          <DiagramTab id={tab.id} />
        </Suspense>
      );
  }
}

function TabButton({ active, onClick, onAuxClick, title, children }: { active: boolean; onClick: () => void; onAuxClick?: () => void; title?: string; children: ReactNode }) {
  return (
    <div
      role="tab"
      title={title}
      className={`tab gap-1.5 whitespace-nowrap ${active ? "tab-active" : ""}`}
      onClick={onClick}
      onAuxClick={(e) => {
        if (e.button === 1) onAuxClick?.();
      }}
    >
      {children}
    </div>
  );
}

function DesignerTabButton({ tab, active }: { tab: DesignerTab; active: boolean }) {
  // Every hook runs on every render; only the tab's own kind counts.
  const dirtyByKind = {
    table: useTableDesigner((s) => designerDirty(s.designers[tab.id])),
    view: useViewDesigner((s) => viewDirty(s.designers[tab.id])),
    data: useDataEditor((s) => dataDirty(s.editors[tab.id])),
    query: useQueryEditor((s) => queryDirty(s.editors[tab.id])),
    diagram: false,
  };
  const dirty = dirtyByKind[tab.kind];
  const Icon = { table: PencilRuler, view: Eye, data: Table, query: SquareTerminal, diagram: Network }[tab.kind];
  const { activate, requestClose } = useTabs.getState();
  const title = tabTitle(tab);

  return (
    <TabButton active={active} title={title} onClick={() => activate(tab.id)} onAuxClick={() => requestClose(tab.id)}>
      <Icon className="size-3.5 text-primary" strokeWidth={1.75} />
      <span className="max-w-64 truncate">{title}</span>
      {dirty && <span className="text-primary" aria-label="Unsaved changes">●</span>}
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square -mr-1 size-5 min-h-0"
        aria-label={`Close ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          requestClose(tab.id);
        }}
      >
        <X className="size-3" />
      </button>
    </TabButton>
  );
}
