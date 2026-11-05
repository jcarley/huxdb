import { acceptCompletion, autocompletion, CompletionContext, ifNotIn } from "@codemirror/autocomplete";
import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { PostgreSQL, keywordCompletionSource, schemaCompletionSource } from "@codemirror/lang-sql";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { syntaxTree } from "@codemirror/language";
import { Compartment, Prec } from "@codemirror/state";
import type { ChangeSpec, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { CatalogRelation, CatalogSchema, CompletionCatalog, RelationKind } from "../../lib/types";

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

/** Schemas whose relations resolve without a qualifier, in order. A tab's schema
 * becomes its session's `search_path`, with `public` after it (`apply_schema` in the
 * backend) and `pg_catalog` searched first, as PostgreSQL does when it isn't listed. */
export function searchScope(catalog: CompletionCatalog, schema = ""): string[] {
  return schema ? [...new Set(["pg_catalog", schema, "public"])] : catalog.searchPath;
}

const RELATION_TYPE: Record<RelationKind, string> = { table: "table", view: "view", "materialized-view": "matview" };

/** `lang-sql` reads a `.` in a namespace key as a path. */
const namespaceKey = (name: string) => name.replace(/\./g, "\\.");

function relationNamespace(schema: CatalogSchema, relation: CatalogRelation) {
  const self: Completion = {
    label: relation.name,
    type: RELATION_TYPE[relation.kind],
    detail: schema.name,
    apply: relation.quoted,
    // There are many of these, and few people want them by default.
    boost: schema.name === "pg_catalog" ? -1 : 0,
  };
  const children: Completion[] = relation.columns.map((c) => ({ label: c.name, type: "property", detail: c.dataType, apply: c.quoted }));
  return { self, children };
}

/** Every schema with its relations, plus the relations in `scope` by bare name.
 * The first schema to have a name wins, as it does in PostgreSQL, which is why this
 * doesn't use `lang-sql`'s `defaultSchema`: that takes one schema. A relation named
 * like a schema hides it, again as it would in `name.column`. */
export function catalogNamespace(catalog: CompletionCatalog, scope: string[]): SQLNamespace {
  const relations = new Map(
    catalog.schemas.map((s) => [s.name, s.relations.map((r) => [namespaceKey(r.name), relationNamespace(s, r)] as const)]),
  );
  const schemas = catalog.schemas.map((s) => {
    const self: Completion = { label: s.name, type: "namespace", apply: s.quoted };
    return [namespaceKey(s.name), { self, children: Object.fromEntries(relations.get(s.name) ?? []) }] as const;
  });
  const visible = [...scope].reverse().flatMap((name) => relations.get(name) ?? []);
  return Object.fromEntries<SQLNamespace>([...schemas, ...visible]);
}

/** PostgreSQL folds unquoted names to lower case and `lang-sql` doesn't, so `FROM Users u`
 * wouldn't find `users`, and would find a table really called `"Users"`. This gives
 * the source the current statement as the server reads it. Offsets don't move:
 * only ASCII is folded, which is also all a UTF-8 server folds. */
function foldIdentifiers(context: CompletionContext): CompletionContext {
  const tree = syntaxTree(context.state);
  let statement = tree.resolveInner(context.pos, -1);
  while (statement.name !== "Statement" && statement.parent) statement = statement.parent;
  if (statement.name !== "Statement") return context;

  const changes: ChangeSpec[] = [];
  tree.iterate({
    from: statement.from,
    to: statement.to,
    enter: ({ name, from, to }) => {
      if (name !== "Identifier") return;
      const text = context.state.sliceDoc(from, to);
      const insert = text.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
      if (insert !== text) changes.push({ from, to, insert });
    },
  });
  if (changes.length === 0) return context;
  return new CompletionContext(context.state.update({ changes }).state, context.pos, context.explicit, context.view);
}

/** Schemas, relations and columns, with aliases from `lang-sql`. Builds its tables on
 * first use, so a hidden tab doesn't pay for each catalog that arrives. */
export function catalogSource(catalog: CompletionCatalog, schema = ""): CompletionSource {
  let source: CompletionSource | null = null;
  const names: CompletionSource = (context) => {
    source ??= schemaCompletionSource({ schema: catalogNamespace(catalog, searchScope(catalog, schema)), dialect: PostgreSQL });
    return source(foldIdentifiers(context));
  };
  // Not quoted identifiers, which it completes. Ctrl+Space would otherwise list names in a string.
  return ifNotIn(["String", "LineComment", "BlockComment"], names);
}

const icons = EditorView.baseTheme({
  ".cm-completionIcon-table:after": { content: "'▦'" },
  ".cm-completionIcon-view:after": { content: "'◫'" },
  ".cm-completionIcon-matview:after": { content: "'◧'" },
});

/** The completion list and its keys, or nothing when it's turned off. */
export function completionExtension({ completion, upperCaseKeywords, catalog, schema }: CompletionSettings): Extension {
  if (!completion) return [];
  const sources = [keywordSource(upperCaseKeywords)];
  if (catalog) sources.push(catalogSource(catalog, schema));
  return [
    // `override` also keeps out the source `sql()` adds through language data.
    autocompletion({ override: sources }),
    icons,
    // Returns false with no list open, so Tab goes on to indent.
    Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
  ];
}
