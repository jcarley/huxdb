import { Eye, Plug, SquarePen, Table } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { newConnection } from "../lib/types";
import { useConnections } from "../stores/connections";
import { isGroupSelection, useExplorer } from "../stores/explorer";
import type { TreeNodeRef } from "../stores/explorer";
import { useTabs } from "../stores/tabs";

interface ToolbarButtonProps {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Shows the button pressed, e.g. while its module's view is showing. */
  active?: boolean;
}

function ToolbarButton({ icon: Icon, label, onClick, disabled, active }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-ghost h-auto min-w-16 flex-col gap-1 px-3 py-2 font-normal ${active ? "btn-active" : ""}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="size-6 text-primary" strokeWidth={1.75} />
      <span className="text-xs">{label}</span>
    </button>
  );
}

function Separator() {
  return <div role="separator" aria-orientation="vertical" className="mx-1 h-10 w-px bg-base-300" />;
}

/** A new query on the selected connection, in the selection's database and schema if it has them. */
function openQuery(selected: TreeNodeRef) {
  const config = useConnections.getState().connections.find((c) => c.id === selected.connectionId);
  useTabs.getState().openQuery({
    connectionId: selected.connectionId,
    database: "database" in selected ? selected.database : config?.database || "postgres",
    schema: "schema" in selected ? selected.schema : "",
  });
}

/** Navicat-style module bar. Add a ToolbarButton per module as modules are built. */
export function Toolbar() {
  const openEditor = useConnections((s) => s.openEditor);
  const selected = useExplorer((s) => s.selected);
  const showGroup = useExplorer((s) => s.showGroup);
  const inSchema = !!selected && "schema" in selected;

  return (
    <header className="flex items-center gap-1 border-b border-base-300 bg-base-100 px-2 py-1">
      <ToolbarButton icon={Plug} label="Connection" onClick={() => openEditor(newConnection())} />
      <ToolbarButton icon={SquarePen} label="New Query" disabled={!selected} onClick={() => selected && openQuery(selected)} />
      <Separator />
      <ToolbarButton
        icon={Table}
        label="Tables"
        disabled={!inSchema}
        active={isGroupSelection(selected, "tables")}
        onClick={() => showGroup("tables")}
      />
      <ToolbarButton
        icon={Eye}
        label="Views"
        disabled={!inSchema}
        active={isGroupSelection(selected, "views")}
        onClick={() => showGroup("views")}
      />
    </header>
  );
}
