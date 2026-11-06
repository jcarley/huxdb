// Which keyboard action an annotation key press means. Pure: the caller reads the DOM.
import { isAnnotationId } from "./diagramAnnotations";

export interface KeyPress {
  key: string;
  /** ⌘ on macOS, Ctrl elsewhere. */
  meta: boolean;
  /** A text field has focus, and owns Backspace, copy and paste. */
  inField: boolean;
  /** Text is selected on the page, so ⌘C copies that and ⌘V is the page's, not ours. */
  textSelected: boolean;
}

/** `selected` may mix objects and annotations: only annotations are acted on. */
export function annotationKeyAction(e: KeyPress, selected: string[], hasClipboard: boolean): "delete" | "copy" | "paste" | null {
  if (e.inField) return null;
  const any = selected.some(isAnnotationId);
  if (!e.meta) return (e.key === "Delete" || e.key === "Backspace") && any ? "delete" : null;
  const key = e.key.toLowerCase();
  if (key === "c") return any && !e.textSelected ? "copy" : null;
  if (key === "v") return hasClipboard && !e.textSelected ? "paste" : null;
  return null;
}
