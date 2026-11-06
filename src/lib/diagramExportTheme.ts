// The export's fixed colours and icons. The canvas reads daisyUI's variables, which a file can't, so
// these are the corporate theme's values worked out once.
import type { DiagramColor } from "./types";

export interface Swatch {
  solid: string;
  content: string;
  /** The canvas's 20% oklab mix with white. */
  tint: string;
}

export interface ExportTheme {
  background: string;
  text: string;
  border: string;
  noteFill: string;
  noteBorder: string;
  key: string;
  primary: Swatch;
  secondary: Swatch;
  colors: Record<DiagramColor, Swatch>;
}

const COLORS: Record<DiagramColor, Swatch> = {
  primary: { solid: "#0082ce", content: "#ffffff", tint: "#d2e6f7" },
  secondary: { solid: "#61738d", content: "#ffffff", tint: "#dde2e7" },
  accent: { solid: "#009689", content: "#ffffff", tint: "#d4eae6" },
  info: { solid: "#0090b5", content: "#ffffff", tint: "#d3e9f1" },
  success: { solid: "#00a43b", content: "#ffffff", tint: "#d5eed8" },
  warning: { solid: "#fdc700", content: "#000000", tint: "#fff5d8" },
  error: { solid: "#ff6266", content: "#000000", tint: "#ffe2e0" },
};

const BASE = { background: "#ffffff", text: "#181a2a", border: "#d1d1d1", noteFill: "#e8e8e8", noteBorder: "#d1d1d1" };

export const LIGHT_THEME: ExportTheme = { ...BASE, key: "#fdc700", primary: COLORS.primary, secondary: COLORS.secondary, colors: COLORS };

const GREY: Swatch = { solid: "#1f2937", content: "#ffffff", tint: "#d3d4d7" };

export const BLACK_AND_WHITE_THEME: ExportTheme = {
  ...BASE,
  key: GREY.solid,
  primary: GREY,
  secondary: GREY,
  colors: { primary: GREY, secondary: GREY, accent: GREY, info: GREY, success: GREY, warning: GREY, error: GREY },
};

/** Escapes XML and removes what XML 1.0 can't hold: control characters, lone surrogates, U+FFFE and U+FFFF. */
export function xml(text: string): string {
  return text
    .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Lucide's 24-unit icon bodies, with no colour of their own, so one definition serves every colour:
 * the `<use>` sets stroke and fill. The key's dot has no fill, as its 2 unit stroke covers the same disc.
 */
export const ICONS: Record<"key" | "link" | "eye" | "layers" | "function" | "workflow" | "info", string> = {
  key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  layers:
    '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
  function: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3"/><path d="M9 11.2h5.7"/>',
  workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
