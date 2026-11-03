import { RefreshCw } from "lucide-react";
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

/** A button in an object list's toolbar. */
export interface ObjectAction {
  icon: LucideIcon;
  label: string;
  /** Acts on the selected object, so it is disabled until one is selected. */
  needsSelection?: boolean;
  /** Placeholder buttons (behavior arriving in later iterations) have none. */
  onClick?: () => void;
}

interface ObjectToolbarProps {
  actions: ObjectAction[];
  /** Whether an object is selected in the list. */
  hasSelection: boolean;
  onRefresh: () => void;
}

/** Actions above an object list (tables, views, …), with Refresh on the right. */
export function ObjectToolbar({ actions, hasSelection, onRefresh }: ObjectToolbarProps) {
  return (
    <div className="flex items-center gap-0.5 border-b border-base-300 bg-base-200/50 px-2 py-1">
      {actions.map(({ icon, label, needsSelection, onClick }) => (
        <ToolButton key={label} icon={icon} label={label} disabled={needsSelection && !hasSelection} onClick={onClick} />
      ))}
      <div className="flex-1" />
      <ToolButton icon={RefreshCw} label="Refresh" onClick={onRefresh} />
    </div>
  );
}
