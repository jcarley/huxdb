import { Plug } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { newConnection } from "../lib/types";
import { useConnections } from "../stores/connections";

interface ToolbarButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}

function ToolbarButton({ icon: Icon, label, onClick }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className="btn btn-ghost h-auto min-w-16 flex-col gap-1 px-3 py-2 font-normal"
      onClick={onClick}
    >
      <Icon className="size-6 text-primary" strokeWidth={1.75} />
      <span className="text-xs">{label}</span>
    </button>
  );
}

/** Navicat-style module bar. Add a ToolbarButton per module as modules are built. */
export function Toolbar() {
  const openEditor = useConnections((s) => s.openEditor);

  return (
    <header className="flex items-center gap-1 border-b border-base-300 bg-base-100 px-2 py-1">
      <ToolbarButton icon={Plug} label="Connection" onClick={() => openEditor(newConnection())} />
    </header>
  );
}
