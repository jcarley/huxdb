import type { LucideIcon } from "lucide-react";

interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  /** The tooltip. An icon-only button falls back to its label. */
  title?: string;
  /** Shows just the icon, to save space; `label` becomes its accessible name. */
  iconOnly?: boolean;
  /** Placeholder buttons (behavior arriving in later iterations) have none. */
  onClick?: () => void;
}

/** A labelled button in a toolbar above a list, designer or grid. */
export function ToolButton({ icon: Icon, label, disabled, title, iconOnly, onClick }: ToolButtonProps) {
  if (iconOnly) {
    return (
      <button type="button" className="btn btn-ghost btn-sm btn-square" title={title ?? label} aria-label={label} disabled={disabled} onClick={onClick}>
        <Icon className="size-4 text-primary" strokeWidth={1.75} />
      </button>
    );
  }
  return (
    <button type="button" className="btn btn-ghost btn-sm font-normal" title={title} disabled={disabled} onClick={onClick}>
      <Icon className="size-4 text-primary" strokeWidth={1.75} />
      {label}
    </button>
  );
}
