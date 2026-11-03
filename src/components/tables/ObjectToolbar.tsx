import { Import, PencilRuler, Plus, RefreshCw, Table, Trash2, Upload } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}

function ToolButton({ icon: Icon, label, disabled, onClick }: ToolButtonProps) {
  return (
    <button type="button" className="btn btn-ghost btn-sm font-normal" disabled={disabled} onClick={onClick}>
      <Icon className="size-4 text-primary" strokeWidth={1.75} />
      {label}
    </button>
  );
}

interface ObjectToolbarProps {
  /** Whether a table is selected in the list; per-table actions need one. */
  hasSelection: boolean;
  onRefresh: () => void;
}

/**
 * Actions for the tables list. Open, Design, New, Delete, Import and Export are
 * placeholders; their actions arrive in later iterations.
 */
export function ObjectToolbar({ hasSelection, onRefresh }: ObjectToolbarProps) {
  return (
    <div className="flex items-center gap-0.5 border-b border-base-300 bg-base-200/50 px-2 py-1">
      <ToolButton icon={Table} label="Open Table" disabled={!hasSelection} />
      <ToolButton icon={PencilRuler} label="Design Table" disabled={!hasSelection} />
      <ToolButton icon={Plus} label="New Table" />
      <ToolButton icon={Trash2} label="Delete Table" disabled={!hasSelection} />
      <ToolButton icon={Import} label="Import Wizard" disabled={!hasSelection} />
      <ToolButton icon={Upload} label="Export Wizard" disabled={!hasSelection} />
      <div className="flex-1" />
      <ToolButton icon={RefreshCw} label="Refresh" onClick={onRefresh} />
    </div>
  );
}
