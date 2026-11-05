// Pure helpers for saved queries and external files.

/** Where a query tab's text is saved. A tab without one has never been saved. */
export type QuerySource = { kind: "saved"; id: string } | { kind: "file"; path: string };

export const sameSource = (a: QuerySource | undefined, b: QuerySource) =>
  a?.kind === b.kind && (a.kind === "saved" ? a.id === (b as typeof a).id : a.path === (b as typeof a).path);

/** CodeMirror keeps "\n" internally, so text with any other line ending would
 * come back changed, and the tab would look edited as soon as it opened. */
export const normalizeText = (text: string) => text.replace(/\r\n?/g, "\n");

/** A saved query's name to suggest for a file, or a file's name to suggest for a query. */
export const withoutSqlExtension = (name: string) => name.replace(/\.sql$/i, "");

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Which question the close prompt asks. */
export type CloseQuestion = "save" | "commit";

/**
 * A designer saves and a data tab commits. A query tab can owe both: it asks
 * about the text first, because that can fail or be cancelled without touching
 * the transaction, and about the transaction once the text is dealt with.
 */
export function closeQuestion(kind: "table" | "view" | "data" | "query" | "diagram", textDirty: boolean, textHandled: boolean): CloseQuestion {
  if (kind === "table" || kind === "view" || kind === "diagram") return "save";
  return kind === "query" && textDirty && !textHandled ? "save" : "commit";
}
