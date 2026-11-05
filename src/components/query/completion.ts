import { acceptCompletion, autocompletion, insertCompletionText, pickedCompletion } from "@codemirror/autocomplete";
import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { PostgreSQL, keywordCompletionSource } from "@codemirror/lang-sql";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Compartment, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { CatalogFunction, CatalogRelation, CatalogSchema, CompletionCatalog, RelationKind } from "../../lib/types";
import { buildIndex, cteColumns, findRelation, sourceColumns } from "./catalogIndex";
import type { CatalogIndex, KnownColumn } from "./catalogIndex";
import { signatureHelp } from "./signatureHelp";
import { cursorContext, findCte, inText, nameAtCursor, visibleCtes, visibleSources } from "./sqlScope";
import type { CursorContext, NameAtCursor, Scope } from "./sqlScope";

/** Holds completion, so settings and catalogs apply without rebuilding the editor. Per editor state, so tabs can share it. */
export const completionCompartment = new Compartment();

interface CompletionSettings {
  completion: boolean;
  upperCaseKeywords: boolean;
  catalog?: CompletionCatalog | null;
  /** The tab's schema; blank for the server's default. */
  schema?: string;
}

/** Keywords and types. `lang-sql` already skips strings, comments and quoted
 * identifiers, and `u.|`, but not `u.sel|`, where a keyword can't be meant. */
export function keywordSource(upperCase: boolean): CompletionSource {
  const keywords = keywordCompletionSource(PostgreSQL, upperCase);
  return (context) => {
    const word = context.matchBefore(/[\p{L}\p{N}_$]*/u);
    if (word && context.state.sliceDoc(word.from - 1, word.from) === ".") return null;
    return keywords(context);
  };
}

const RELATION_TYPE: Record<RelationKind, string> = { table: "table", view: "view", "materialized-view": "matview" };

/** Ranks, against keywords at -1. Columns in scope come first, or the list gets
 * worse as it gets bigger; PostgreSQL's own thousands of functions come last. */
const RANK = { column: 6, outerColumn: 5, cte: 5, source: 4, relation: 3, userFunction: 2, schema: 1, systemFunction: -2, systemRelation: -3 };

/** A name we only know as written, in a CTE or subquery's output. */
const quoteIfNeeded = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? undefined : `"${name.replace(/"/g, '""')}"`);

function columnOption(column: KnownColumn, boost: number, sourceName?: string): Completion {
  const detail = [column.dataType, sourceName].filter(Boolean).join(" · ") || undefined;
  return { label: column.name, type: "property", detail, boost, apply: column.quoted ?? quoteIfNeeded(column.name) };
}

function relationOption(schema: string, relation: CatalogRelation, boost = schema === "pg_catalog" ? RANK.systemRelation : RANK.relation): Completion {
  return { label: relation.name, type: RELATION_TYPE[relation.kind], detail: schema, boost, apply: relation.quoted };
}

const schemaOption = ({ name, quoted }: CatalogSchema): Completion => ({ label: name, type: "namespace", boost: RANK.schema, apply: quoted });

/** One entry per name, however many overloads. Accepting it opens the call, unless one's already there. */
function functionOption(schema: string, overloads: CatalogFunction[]): Completion {
  const [first] = overloads;
  const name = first.quoted ?? first.name;
  return {
    label: first.name,
    type: "function",
    detail: overloads.length > 1 ? `${overloads.length} overloads` : `(${first.arguments})`,
    boost: schema === "pg_catalog" ? RANK.systemFunction : RANK.userFunction,
    apply: (view, completion, from, to) => {
      const open = view.state.sliceDoc(to, to + 1) === "(";
      const insert = open ? name : `${name}(`;
      view.dispatch({ ...insertCompletionText(view.state, insert, from, to), annotations: pickedCompletion.of(completion) });
    },
  };
}

const schemaFunctions = (index: CatalogIndex, schema: string) =>
  [...(index.schemas.get(schema)?.functions.values() ?? [])].map((overloads) => functionOption(schema, overloads));

/** Names resolve along the path, so the first schema with a name wins. */
function scopedRelations(index: CatalogIndex): Completion[] {
  const seen = new Map<string, Completion>();
  for (const schema of index.scope) {
    for (const relation of index.schemas.get(schema)?.relations.values() ?? []) {
      if (!seen.has(relation.name)) seen.set(relation.name, relationOption(schema, relation));
    }
  }
  return [...seen.values()];
}

function scopedFunctions(index: CatalogIndex): Completion[] {
  const seen = new Map<string, Completion>();
  for (const schema of index.scope) {
    for (const option of schemaFunctions(index, schema)) if (!seen.has(option.label)) seen.set(option.label, option);
  }
  return [...seen.values()];
}

function tableOptions(index: CatalogIndex, scope: Scope | null): Completion[] {
  const ctes = (scope ? visibleCtes(scope) : []).map((cte): Completion => ({ label: cte.name, type: "cte", detail: "CTE", boost: RANK.cte, apply: quoteIfNeeded(cte.name) }));
  return [...ctes, ...scopedRelations(index), ...[...index.schemas.values()].map((s) => schemaOption(s.schema)), ...scopedFunctions(index)];
}

function columnOptions(index: CatalogIndex, { scope, clause }: CursorContext): Completion[] {
  const visible = visibleSources(scope);
  const options = visible.flatMap(({ source, scope: owner }) => {
    const boost = owner === scope ? RANK.column : RANK.outerColumn;
    const columns = sourceColumns(index, source, owner).map((column) => columnOption(column, boost, source.name ?? undefined));
    const named: Completion[] = source.name ? [{ label: source.name, type: "constant", boost: RANK.source, apply: quoteIfNeeded(source.name) }] : [];
    return [...columns, ...named];
  });
  if (clause === "sort") {
    for (const item of scope.output) if ("name" in item) options.push(columnOption(item, RANK.column));
  }
  options.push(...scopedFunctions(index));
  // Nothing in FROM yet, so a table to qualify a column with is still useful.
  if (visible.length === 0) options.push(...scopedRelations(index), ...[...index.schemas.values()].map((s) => schemaOption(s.schema)));
  return options;
}

/** After a `.`: an alias or table's columns, or a schema's objects. In a table's
 * place the schema comes first; anywhere else a table hides a schema of its name. */
function qualifiedOptions(index: CatalogIndex, path: string[], context: CursorContext | null): Completion[] | null {
  const scope = context?.scope ?? null;
  const schemaObjects = () => {
    const schema = path.length === 1 ? index.schemas.get(path[0]) : undefined;
    if (!schema) return null;
    const relations = [...schema.relations.values()].map((r) => relationOption(path[0], r, RANK.relation));
    return [...relations, ...schemaFunctions(index, path[0])];
  };
  if (context?.clause === "table") {
    const objects = schemaObjects();
    if (objects) return objects;
  }
  if (scope) {
    const visible = visibleSources(scope).find(({ source }) => {
      if (path.length === 1) return source.name === path[0];
      return source.kind === "table" && source.path.join("\0") === path.join("\0");
    });
    if (visible) return sourceColumns(index, visible.source, visible.scope).map((c) => columnOption(c, RANK.column));
    const cte = path.length === 1 ? findCte(scope, path[0]) : null;
    if (cte) return cteColumns(index, cte.cte).map((c) => columnOption(c, RANK.column));
  }
  const relation = findRelation(index, path);
  if (relation) return relation.columns.map((c) => columnOption(c, RANK.column));
  return schemaObjects();
}

function optionsFor(index: CatalogIndex, name: NameAtCursor, context: CursorContext | null): Completion[] | null {
  if (name.path.length > 0) return qualifiedOptions(index, name.path, context);
  switch (context?.clause ?? "none") {
    case "table":
      return tableOptions(index, context?.scope ?? null);
    case "expression":
    case "sort":
      return columnOptions(index, context!);
    case "insert-columns": {
      const target = context!.scope.target;
      return target ? sourceColumns(index, target, context!.scope).map((c) => columnOption(c, RANK.column)) : null;
    }
    case "other":
      return null;
    case "none":
      return tableOptions(index, context?.scope ?? null);
  }
}

const PARSE_BUDGET_MS = 20;
const NAME = /^[\p{L}\p{N}_$]*$/u;
const QUOTED_NAME = /^"?[^"]*"?$/;

/** Everything the catalog and the cursor's scope know, ranked. Replaces `lang-sql`'s
 * schema source: a CTE or subquery's columns can't live in its static namespace. */
export function catalogSource(index: CatalogIndex): CompletionSource {
  return (context) => {
    const { state, pos } = context;
    // Parsing lags behind a jump to the end of a long script.
    const tree = ensureSyntaxTree(state, pos, PARSE_BUDGET_MS) ?? syntaxTree(state);
    if (inText(tree, pos)) return null;
    const slice = (from: number, to: number) => state.sliceDoc(from, to);
    const name = nameAtCursor(tree, slice, pos);
    if (name.empty && !context.explicit) return null;
    const options = optionsFor(index, name, cursorContext(tree, slice, pos, name.from));
    if (!options) return null;
    if (!name.quoted) return { from: name.from, options, validFor: NAME };
    const quoted = options.map((option) => ({ ...option, label: `"${option.label}"`, apply: undefined }));
    return { from: name.from, to: state.sliceDoc(pos, pos + 1) === '"' ? pos + 1 : undefined, options: quoted, validFor: QUOTED_NAME };
  };
}

const icons = EditorView.baseTheme({
  ".cm-completionIcon-table:after": { content: "'▦'" },
  ".cm-completionIcon-view:after": { content: "'◫'" },
  ".cm-completionIcon-matview:after": { content: "'◧'" },
  ".cm-completionIcon-cte:after": { content: "'◇'" },
});

/** The completion list and its keys, or nothing when it's turned off. */
export function completionExtension({ completion, upperCaseKeywords, catalog, schema }: CompletionSettings): Extension {
  if (!completion) return [];
  const sources = [keywordSource(upperCaseKeywords)];
  const index = catalog ? buildIndex(catalog, schema) : null;
  if (index) sources.push(catalogSource(index));
  return [
    // `override` also keeps out the source `sql()` adds through language data.
    autocompletion({ override: sources }),
    icons,
    index ? signatureHelp(index) : [],
    // Returns false with no list open, so Tab goes on to indent.
    Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
  ];
}
