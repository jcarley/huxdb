import { Eye, PencilRuler, X } from "lucide-react";
import type { ReactNode } from "react";
import { designerDirty, useTableDesigner } from "../stores/tableDesigner";
import { tabTitle, useTabs } from "../stores/tabs";
import type { DesignerTab } from "../stores/tabs";
import { DetailsPane } from "./DetailsPane";
import { viewDirty, useViewDesigner } from "../stores/viewDesigner";
import { TableDesigner } from "./designer/TableDesigner";
import { ViewDesigner } from "./designer/ViewDesigner";

/** The main pane: a permanent Objects tab plus one closable tab per open designer. */
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
          {tab.kind === "table" ? <TableDesigner id={tab.id} /> : <ViewDesigner id={tab.id} />}
        </div>
      ))}
    </main>
  );
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
  // Both hooks run on every render; only the tab's own kind counts.
  const tableDirty = useTableDesigner((s) => designerDirty(s.designers[tab.id]));
  const viewIsDirty = useViewDesigner((s) => viewDirty(s.designers[tab.id]));
  const dirty = tab.kind === "table" ? tableDirty : viewIsDirty;
  const Icon = tab.kind === "table" ? PencilRuler : Eye;
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
