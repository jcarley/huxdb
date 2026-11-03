import { useEffect } from "react";
import type { MouseEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { create } from "zustand";

export interface MenuItem {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  danger?: boolean;
}

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
  open: (e: MouseEvent, items: MenuItem[]) => void;
  close: () => void;
}

const MENU_WIDTH = 184; // w-44 plus border/shadow allowance
const ITEM_HEIGHT = 32;

/** One app-wide right-click menu. Call `open` from an onContextMenu handler. */
export const useContextMenu = create<MenuState>((set) => ({
  menu: null,
  open: (e, items) => {
    e.preventDefault();
    const height = items.length * ITEM_HEIGHT + 16;
    set({
      menu: {
        x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH),
        y: Math.min(e.clientY, window.innerHeight - height),
        items,
      },
    });
  },
  close: () => set({ menu: null }),
}));

export function ContextMenu() {
  const { menu, close } = useContextMenu();

  // Close on any click, right-click, scroll, blur, or Escape. The contextmenu/scroll
  // listeners use capture so they run before a row's onContextMenu, which then
  // reopens the menu at the new spot.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, close]);

  if (!menu) return null;

  return (
    <ul
      className="menu menu-sm fixed z-50 w-44 rounded-box border border-base-300 bg-base-100 shadow-lg"
      style={{ left: menu.x, top: menu.y }}
    >
      {menu.items.map(({ label, icon: Icon, onClick, danger }) => (
        <li key={label}>
          <button type="button" className={danger ? "text-error" : ""} onClick={onClick}>
            <Icon className="size-4" /> {label}
          </button>
        </li>
      ))}
    </ul>
  );
}
