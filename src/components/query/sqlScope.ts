// What the cursor can see in half-typed SQL. Pure: a Lezer tree in, nested scopes
// out, with no catalog and no editor. completion.ts puts names to them.
//
// `lang-sql`'s grammar is flat: statements hold tokens and parentheses, and nothing
// else, so all structure here comes from walking tokens. It's error tolerant,
// which half-typed SQL needs, but two things it does shape this file:
// - Most column names are Keyword tokens (`id`, `name`, `label`), so a word counts
//   as a name unless it's in NOT_A_NAME.
// - An unclosed parenthesis runs to the end of the statement, so in
//   `SELECT lower(na FROM users` the FROM is inside it. See `tokensOf`.

import type { SyntaxNode, Tree } from "@lezer/common";

export type Clause =
  /** Nothing known: the start of a statement, or no statement. */
  | "none"
  /** Where a table goes: FROM, JOIN, UPDATE, INTO, DELETE FROM. */
  | "table"
  /** Where a column of the visible tables goes. */
  | "expression"
  /** GROUP BY and ORDER BY, which can also use the SELECT list's names. */
  | "sort"
  /** An INSERT's column list: only the target's columns. */
  | "insert-columns"
  /** LIMIT and the like, or a VALUES list: no columns. */
  | "other";

export interface TableSource {
  kind: "table";
  /** What qualifies its columns: the alias, or else the table's name. */
  name: string;
  path: string[];
  columnAliases?: string[];
}

export interface QuerySource {
  kind: "query";
  name: string | null;
  query: Scope;
  columnAliases?: string[];
}

export interface FunctionSource {
  kind: "function";
  name: string;
  columnAliases?: string[];
}

export type Source = TableSource | QuerySource | FunctionSource;

export interface Cte {
  name: string;
  query: Scope;
  columnAliases?: string[];
}

/** A SELECT list entry: a name, or `*` / `qualifier.*`. Unnamed expressions are left out. */
export type OutputItem = { name: string } | { star: true; qualifier: string | null };

/** One SELECT (or UPDATE, DELETE, INSERT), or the WITH list around them. */
export interface Scope {
  from: number;
  to: number;
  parent: Scope | null;
  /** Sees its parent's sources: a subquery in an expression, or a LATERAL one. */
  correlated: boolean;
  ctes: Cte[];
  sources: Source[];
  /** An INSERT's table, which its SELECT can't see. */
  target: TableSource | null;
  output: OutputItem[];
  /** In text order; the last one at or before a position applies. */
  clauses: { from: number; clause: Clause }[];
  children: Scope[];
}

export interface CursorContext {
  scope: Scope;
  clause: Clause;
}

/** The name being typed and what qualifies it. */
export interface NameAtCursor {
  from: number;
  /** The opening quote, in a quoted identifier. */
  quoted: boolean;
  /** Qualifiers as the server reads them, innermost last. */
  path: string[];
  /** Nothing typed and no `.` before it. */
  empty: boolean;
}

export interface CallAtCursor {
  path: string[];
  /** Which argument the cursor is in, from 0. */
  argument: number;
  /** Where the `(` is. */
  open: number;
}

type Slice = (from: number, to: number) => string;

interface Token {
  kind: "word" | "quoted" | "path" | "parens" | "comma" | "star" | "operator" | "other";
  /** Upper case, for a word; the raw text otherwise. */
  text: string;
  from: number;
  to: number;
  /** As the server reads it: a word's or quoted name's name, or a path's parts. */
  path?: string[];
  /** A path ending in `.`. */
  dangling?: boolean;
  inner?: Token[];
  closed?: boolean;
}

const words = (text: string) => new Set(text.split(/\s+/));

const NOT_A_NAME = words(`ALL ANALYSE ANALYZE AND ANY AS ASC BETWEEN BY CASE CAST COLLATE CREATE CROSS CURRENT_DATE
  DEFAULT DELETE DESC DISTINCT DO ELSE END EXCEPT EXISTS FALSE FETCH FOR FROM FULL GROUP HAVING ILIKE IN INNER INSERT INTERSECT
  INTO IS ISNULL JOIN LATERAL LEFT LIKE LIMIT NATURAL NOT NOTNULL NULL OFFSET ON ONLY OR ORDER OUTER OVER RETURNING RIGHT
  SELECT SET SIMILAR SOME TABLESAMPLE THEN TRUE UNION UPDATE USING VALUES WHEN WHERE WINDOW WITH`);

/** What ends an unclosed call's arguments: its FROM belongs to the query around it. */
const CLAUSE_WORDS = words("FROM WHERE GROUP HAVING ORDER LIMIT OFFSET FETCH WINDOW UNION INTERSECT EXCEPT RETURNING");
/** Calls whose arguments can hold a FROM of their own. */
const FROM_CALLS = words("EXTRACT SUBSTRING TRIM OVERLAY");
const QUERY_WORDS = words("SELECT WITH VALUES TABLE INSERT UPDATE DELETE MERGE");
const SET_OPERATORS = words("UNION INTERSECT EXCEPT");
const JOIN_WORDS = words("INNER LEFT RIGHT FULL CROSS NATURAL OUTER");
/** `left(` and `right(` are functions; these aren't. */
const NOT_A_CALL = new Set([...NOT_A_NAME].filter((word) => word !== "LEFT" && word !== "RIGHT"));

/** PostgreSQL folds unquoted names to lower case, and in UTF-8 only ASCII. */
const fold = (name: string) => name.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());

function identifierName(text: string): string {
  return text.startsWith('"') ? text.replace(/^"|"$/g, "").replace(/""/g, '"') : fold(text);
}

const isQuery = (tokens: Token[]) => tokens[0]?.kind === "word" && QUERY_WORDS.has(tokens[0].text);
const isWord = (token: Token | undefined, ...expected: string[]) => token?.kind === "word" && expected.includes(token.text);
const isName = (token: Token | undefined) => token?.kind === "quoted" || (token?.kind === "word" && !NOT_A_NAME.has(token.text));
const last = <T>(list: T[] | undefined): T | undefined => list?.[list.length - 1];
const nameOf = (token: Token) => last(token.path) ?? "";

function tokensOf(node: SyntaxNode, slice: Slice, cursor: number): Token[] {
  const tokens: Token[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    const { name, from, to } = child;
    const text = slice(from, to);
    switch (name) {
      case "LineComment":
      case "BlockComment":
      case "(":
      case ")":
      case "⚠":
        break;
      case "Identifier":
      case "Keyword":
      case "Type":
      case "Bool":
      case "Null":
        tokens.push({ kind: "word", text: text.toUpperCase(), from, to, path: [fold(text)] });
        break;
      case "QuotedIdentifier":
        tokens.push({ kind: "quoted", text, from, to, path: [identifierName(text)] });
        break;
      case "CompositeIdentifier": {
        const parts: string[] = [];
        for (let part = child.firstChild; part; part = part.nextSibling) {
          if (part.name !== "." && part.name !== "⚠") parts.push(identifierName(slice(part.from, part.to)));
        }
        tokens.push({ kind: "path", text, from, to, path: parts, dangling: text.endsWith(".") });
        break;
      }
      case "Parens": {
        const inner = tokensOf(child, slice, cursor);
        const closed = child.lastChild?.name === ")";
        // Past the unclosed call's clause word, tokens are the enclosing query's. `extract(a FROM b|`
        // and `trim(a| FROM b` read the same, except that a call's own FROM comes before the cursor.
        const callee = last(tokens);
        const ownFrom = callee?.kind === "word" && FROM_CALLS.has(callee.text) ? inner.findIndex((t) => isWord(t, "FROM") && t.to <= cursor) : -1;
        const spill = !closed && !isQuery(inner) ? inner.findIndex((t, i) => t.kind === "word" && CLAUSE_WORDS.has(t.text) && i !== ownFrom) : -1;
        if (spill < 0) {
          tokens.push({ kind: "parens", text, from, to, inner, closed });
        } else {
          tokens.push({ kind: "parens", text, from, to: inner[spill].from, inner: inner.slice(0, spill), closed: true });
          tokens.push(...inner.slice(spill));
        }
        break;
      }
      case "Operator":
        tokens.push({ kind: text === "*" ? "star" : "operator", text, from, to });
        break;
      case "Punctuation":
        tokens.push({ kind: text === "," ? "comma" : "other", text, from, to });
        break;
      default:
        tokens.push({ kind: "other", text, from, to });
    }
  }
  return tokens;
}

function newScope(from: number, to: number, parent: Scope | null, correlated: boolean): Scope {
  const scope: Scope = { from, to, parent, correlated, ctes: [], sources: [], target: null, output: [], clauses: [], children: [] };
  parent?.children.push(scope);
  return scope;
}

/** A parenthesis's content, with room for the cursor. An unclosed one runs on. */
const parensRange = (token: Token): [number, number] => [token.from + 1, token.closed ? token.to - 1 : Number.MAX_SAFE_INTEGER];

/** Subqueries anywhere inside an expression. They don't change the clause. */
function scanExpression(tokens: Token[], scope: Scope) {
  for (const token of tokens) {
    if (token.kind !== "parens" || !token.inner) continue;
    if (isQuery(token.inner)) parseQuery(token.inner, scope, true, ...parensRange(token));
    else scanExpression(token.inner, scope);
  }
}

function columnNames(token: Token | undefined): string[] | undefined {
  if (token?.kind !== "parens" || !token.inner) return undefined;
  return token.inner.filter(isName).map(nameOf);
}

/** `<expression> [[AS] name]`, as it would be titled. */
function outputItem(all: Token[]): OutputItem | null {
  // A cast keeps its operand's name.
  const cast = all.findIndex((t, i) => t.text === ":" && all[i + 1]?.text === ":");
  const named = all.findIndex((t) => isWord(t, "AS"));
  if (named >= 0 && all[named + 1]?.path) return { name: nameOf(all[named + 1]) };
  const tokens = cast >= 0 ? all.slice(0, cast) : all;
  const first = tokens[0];
  const final = last(tokens);
  if (!first || !final) return null;
  if (final.kind === "star") {
    if (tokens.length === 1) return { star: true, qualifier: null };
    if (tokens.length === 2 && first.dangling) return { star: true, qualifier: last(first.path) ?? null };
  }
  if (tokens.length === 1) return first.kind === "path" || isName(first) ? { name: nameOf(first) } : null;
  if (tokens.length === 2 && final.kind === "parens" && first.path) return { name: nameOf(first) };
  // Without AS, a name straight after a whole expression is its title.
  const before = tokens[tokens.length - 2];
  if (isName(final) && before && before.kind !== "operator") return { name: nameOf(final) };
  return null;
}

function outputItems(tokens: Token[]): OutputItem[] {
  let start = 0;
  if (isWord(tokens[0], "ALL")) start = 1;
  if (isWord(tokens[0], "DISTINCT")) start = isWord(tokens[1], "ON") ? 3 : 1;
  const items: OutputItem[] = [];
  let item: Token[] = [];
  const finish = () => {
    const parsed = outputItem(item);
    if (parsed) items.push(parsed);
    item = [];
  };
  for (const token of tokens.slice(start)) {
    if (token.kind === "comma") finish();
    else item.push(token);
  }
  finish();
  return items;
}

/** At `WITH name [(columns)] AS [[NOT] MATERIALIZED] (`, and not `WITH ORDINALITY` or `WITH (option)`. */
function startsWithList(tokens: Token[], at: number): boolean {
  if (!isWord(tokens[at], "WITH")) return false;
  let i = at + 1;
  if (isWord(tokens[i], "RECURSIVE")) i++;
  if (!isName(tokens[i])) return false;
  i++;
  if (tokens[i]?.kind === "parens") i++;
  if (!isWord(tokens[i], "AS")) return false;
  i++;
  if (isWord(tokens[i], "NOT")) i++;
  if (isWord(tokens[i], "MATERIALIZED")) i++;
  return tokens[i]?.kind === "parens";
}

/** Reads a WITH list into `holder`, and returns where it stops. A half-typed one
 * keeps what it has. */
function parseWithList(tokens: Token[], at: number, holder: Scope): number {
  let i = isWord(tokens[at + 1], "RECURSIVE") ? at + 2 : at + 1;
  while (i < tokens.length) {
    const name = tokens[i];
    if (!isName(name)) break;
    i++;
    const columnAliases = columnNames(tokens[i]);
    if (columnAliases) i++;
    if (!isWord(tokens[i], "AS")) break;
    i++;
    if (isWord(tokens[i], "NOT")) i++;
    if (isWord(tokens[i], "MATERIALIZED")) i++;
    const body = tokens[i];
    if (body?.kind !== "parens" || !body.inner) break;
    i++;
    // A CTE sees the WITH list but not the query around it.
    const query = parseQuery(body.inner, holder, false, ...parensRange(body));
    holder.ctes.push({ name: nameOf(name), query, columnAliases });
    if (tokens[i]?.kind !== "comma") break;
    i++;
  }
  return i;
}

/** One SELECT, UPDATE, DELETE or INSERT, as a walk that remembers what comes next. */
function parseArm(tokens: Token[], scope: Scope) {
  const statement = tokens[0]?.kind === "word" ? tokens[0].text : "";
  const mark = (token: Token, clause: Clause) => scope.clauses.push({ from: token.to, clause });

  let expectTable = false;
  let lateral = false;
  /** The table just read, until its alias is. */
  let source: Source | null = null;
  /** Tokens of a SELECT or RETURNING list, until the clause ends. */
  let list: Token[] | null = null;
  /** In the FROM list, where a comma, even after a join's ON, means another table. */
  let inFromList = false;
  let sawUsing = false;

  const finishList = () => {
    if (list && scope.output.length === 0) scope.output = outputItems(list);
    list = null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];

    if (expectTable && !(token.kind === "word" && NOT_A_NAME.has(token.text) && !isWord(token, "LATERAL", "ONLY"))) {
      if (isWord(token, "ONLY")) continue;
      if (isWord(token, "LATERAL")) {
        lateral = true;
        continue;
      }
      expectTable = false;
      const inserting = statement === "INSERT" && !scope.target;
      if (token.kind === "parens" && token.inner) {
        if (isQuery(token.inner)) {
          const query = parseQuery(token.inner, scope, lateral, ...parensRange(token));
          source = { kind: "query", name: null, query };
          scope.sources.push(source);
        } else {
          // `FROM (a JOIN b ON …) x`: the tables are as good as listed here.
          parseArm([{ ...token, kind: "word", text: "FROM", to: token.from + 1 }, ...token.inner], scope);
        }
      } else if (token.path && next?.kind === "parens" && !inserting) {
        source = { kind: "function", name: nameOf(token) };
        scope.sources.push(source);
        scanExpression([next], scope);
        i++;
      } else if (token.path) {
        const table: TableSource = { kind: "table", name: nameOf(token), path: token.path };
        source = table;
        if (inserting) scope.target = table;
        else scope.sources.push(table);
      }
      lateral = false;
      continue;
    }

    // After a table: `[AS] alias [(columns)]`.
    if (source) {
      const named = isWord(token, "AS") ? next : token;
      if (named?.path && (named !== token || isName(token))) {
        source.name = nameOf(named);
        i += named === token ? 0 : 1;
        if (tokens[i + 1]?.kind === "parens" && source !== scope.target) {
          source.columnAliases = columnNames(tokens[i + 1]);
          i++;
        }
        continue;
      }
      if (isWord(token, "AS")) continue;
      if (isWord(token, "WITH") && isWord(next, "ORDINALITY")) {
        i++;
        continue;
      }
      if (token.kind === "parens" && source === scope.target) {
        scope.clauses.push({ from: token.from + 1, clause: "insert-columns" });
        scope.clauses.push({ from: token.closed ? token.to : Number.MAX_SAFE_INTEGER, clause: "other" });
        source = null;
        continue;
      }
      source = null;
    }

    if (startsWithList(tokens, i) && statement !== "WITH") {
      i = parseWithList(tokens, i, scope) - 1;
      continue;
    }

    if (token.kind === "comma" && !list && inFromList) {
      mark(token, "table");
      expectTable = true;
      continue;
    }

    const word = token.kind === "word" ? token.text : "";
    switch (word) {
      case "SELECT":
        finishList();
        mark(token, "expression");
        list = [];
        continue;
      case "RETURNING":
        finishList();
        inFromList = false;
        // Only an INSERT's table, not what its SELECT read.
        if (scope.target) scope.sources = [scope.target];
        mark(token, "expression");
        list = [];
        continue;
      case "FROM":
      case "INTO":
      case "JOIN":
        // `a IS [NOT] DISTINCT FROM b` is an expression.
        if (word === "FROM" && isWord(tokens[i - 1], "DISTINCT") && isWord(tokens[i - 2], "IS", "NOT")) break;
        finishList();
        inFromList = word !== "INTO";
        mark(token, "table");
        expectTable = true;
        continue;
      case "USING":
        finishList();
        if ((statement === "DELETE" || statement === "MERGE") && !sawUsing) {
          sawUsing = true;
          inFromList = true;
          mark(token, "table");
          expectTable = true;
        } else {
          mark(token, "expression");
        }
        continue;
      case "UPDATE":
        if (i === 0) {
          mark(token, "table");
          expectTable = true;
        }
        continue;
      case "ON":
        // `SELECT DISTINCT ON (x) …` is still the SELECT list.
        if (list && isWord(tokens[i - 1], "DISTINCT")) break;
        if (isWord(next, "CONFLICT") && scope.target) {
          scope.sources = [scope.target, { kind: "table", name: "excluded", path: scope.target.path }];
        }
        finishList();
        mark(token, "expression");
        continue;
      case "WHERE":
      case "HAVING":
      case "SET":
        finishList();
        inFromList = false;
        mark(token, "expression");
        continue;
      case "GROUP":
      case "ORDER":
        // `WITHIN GROUP (…)` is part of the expression.
        if (!isWord(next, "BY")) break;
        finishList();
        inFromList = false;
        mark(next, "sort");
        i++;
        continue;
      case "VALUES":
      case "LIMIT":
      case "OFFSET":
      case "FETCH":
      case "FOR":
      case "WINDOW":
        finishList();
        inFromList = false;
        mark(token, "other");
        continue;
    }
    if (JOIN_WORDS.has(word)) continue;

    if (list) list.push(token);
    if (token.inner) scanExpression([token], scope);
  }
  finishList();
}

/** `[WITH …] arm [UNION arm …]`. Returns the arm that names the output. */
function parseQuery(tokens: Token[], parent: Scope | null, correlated: boolean, from: number, to: number): Scope {
  const holder = newScope(from, to, parent, correlated);
  const i = isWord(tokens[0], "WITH") ? parseWithList(tokens, 0, holder) : 0;

  let first: Scope | null = null;
  let start = i;
  const finishArm = (end: number, armTo: number) => {
    const armFrom = start < tokens.length ? tokens[start].from : armTo;
    const arm = newScope(start === i ? from : armFrom, armTo, holder, true);
    parseArm(tokens.slice(start, end), arm);
    first ??= arm;
  };
  for (let at = i; at < tokens.length; at++) {
    if (tokens[at].kind === "word" && SET_OPERATORS.has(tokens[at].text)) {
      finishArm(at, tokens[at].from);
      start = at + 1;
      if (isWord(tokens[start], "ALL", "DISTINCT")) start++;
    }
  }
  finishArm(tokens.length, to);
  return first ?? holder;
}

/** The statement the cursor is in or just after: past the last token there's no node. */
function statementAt(tree: Tree, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node && node.name !== "Statement") node = node.parent;
  if (node) return node.lastChild?.name === ";" && pos >= node.to ? null : node;
  const before = tree.topNode.childBefore(pos);
  return before?.name === "Statement" && before.lastChild?.name !== ";" ? before : null;
}

function innermost(scope: Scope, pos: number): Scope {
  for (const child of scope.children) {
    if (child.from <= pos && pos <= child.to) return innermost(child, pos);
  }
  return scope;
}

/** Where the cursor is, for the name that starts at `wordFrom`. */
export function cursorContext(tree: Tree, slice: Slice, pos: number, wordFrom = pos): CursorContext | null {
  const statement = statementAt(tree, pos);
  if (!statement) return null;
  const root = parseQuery(tokensOf(statement, slice, pos), null, false, statement.from, Number.MAX_SAFE_INTEGER);
  let top = root;
  while (top.parent) top = top.parent;
  const scope = innermost(top, pos);
  const clause = last(scope.clauses.filter((c) => c.from <= wordFrom))?.clause ?? "none";
  return { scope, clause };
}

export interface VisibleSource {
  source: Source;
  /** Where it was declared, which is where its names resolve. */
  scope: Scope;
}

/** Sources by name lookup order, innermost first. */
export function visibleSources(scope: Scope): VisibleSource[] {
  const found: VisibleSource[] = [];
  for (let at: Scope | null = scope; at; at = at.correlated ? at.parent : null) {
    for (const source of at.sources) found.push({ source, scope: at });
  }
  return found;
}

/** CTEs in lookup order. Crosses every boundary, unlike sources. */
export function findCte(scope: Scope, name: string): { cte: Cte; scope: Scope } | null {
  for (let at: Scope | null = scope; at; at = at.parent) {
    const cte = at.ctes.find((c) => c.name === name);
    if (cte) return { cte, scope: at };
  }
  return null;
}

export function visibleCtes(scope: Scope): Cte[] {
  const seen = new Map<string, Cte>();
  for (let at: Scope | null = scope; at; at = at.parent) {
    for (const cte of at.ctes) if (!seen.has(cte.name)) seen.set(cte.name, cte);
  }
  return [...seen.values()];
}

const NAME_NODES = new Set(["Identifier", "QuotedIdentifier", "Keyword", "Type"]);

function tokenBefore(node: SyntaxNode): SyntaxNode | null {
  let before = node.prevSibling;
  while (before && /Comment/.test(before.name)) before = before.prevSibling;
  return before;
}

/** The names before a `.` node, reading back through a CompositeIdentifier. */
function qualifiers(dot: SyntaxNode | null, slice: Slice): string[] {
  const path: string[] = [];
  for (let node = dot; node?.name === "."; ) {
    const name = tokenBefore(node);
    if (!name || !NAME_NODES.has(name.name)) break;
    path.unshift(identifierName(slice(name.from, name.to)));
    node = tokenBefore(name);
  }
  return path;
}

export function nameAtCursor(tree: Tree, slice: Slice, pos: number): NameAtCursor {
  const node = tree.resolveInner(pos, -1);
  if (NAME_NODES.has(node.name) || node.name === "Bool" || node.name === "Null") {
    return { from: node.from, quoted: node.name === "QuotedIdentifier", path: qualifiers(tokenBefore(node), slice), empty: false };
  }
  if (node.name === ".") return { from: pos, quoted: false, path: qualifiers(node, slice), empty: false };
  return { from: pos, quoted: false, path: [], empty: true };
}

/** True in text that isn't SQL: strings and comments. */
export function inText(tree: Tree, pos: number): boolean {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === "String" || node.name === "LineComment" || node.name === "BlockComment") return true;
  }
  return false;
}

/** The function call around the cursor, if the text before a `(` can be one. */
export function callAtCursor(tree: Tree, slice: Slice, pos: number): CallAtCursor | null {
  if (inText(tree, pos)) return null;
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    if (node.name !== "Parens" || pos <= node.from) continue;
    if (node.lastChild?.name === ")" && pos >= node.to) continue;
    const callee = tokenBefore(node);
    if (!callee) continue;
    const text = slice(callee.from, callee.to);
    let path: string[] | null = null;
    if (callee.name === "CompositeIdentifier") {
      path = tokensOf(callee.parent!, slice, pos).find((t) => t.from === callee.from)?.path ?? null;
    } else if (NAME_NODES.has(callee.name) && !NOT_A_CALL.has(text.toUpperCase())) {
      path = [identifierName(text)];
    }
    if (!path) continue;
    let argument = 0;
    for (let child = node.firstChild; child && child.from < pos; child = child.nextSibling) {
      if (child.name === "Punctuation" && slice(child.from, child.to) === ",") argument++;
    }
    return { path, argument, open: node.from };
  }
  return null;
}
