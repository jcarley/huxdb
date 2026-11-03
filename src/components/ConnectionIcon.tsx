import { Database } from "lucide-react";

/** Database glyph tinted with the connection's color tag, if it has one. */
export function ConnectionIcon({ color, className = "size-4" }: { color: string | null; className?: string }) {
  return (
    <Database
      className={`${className} shrink-0 ${color ? "" : "text-base-content/60"}`}
      style={color ? { color } : undefined}
      strokeWidth={1.75}
    />
  );
}
