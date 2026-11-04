import type { LucideIcon } from "lucide-react";

interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  /** Placeholder buttons (behavior arriving in later iterations) have none. */
  onClick?: () => void;
}

/** A labelled button in a toolbar above a list, designer or grid. */
export function ToolButton({ icon: Icon, label, disabled, onClick }: ToolButtonProps) {
  return (
    <button type="button" className="btn btn-ghost btn-sm font-normal" disabled={disabled} onClick={onClick}>
      <Icon className="size-4 text-primary" strokeWidth={1.75} />
      {label}
    </button>
  );
}
