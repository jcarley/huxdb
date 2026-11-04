// The structured filter as a tree: pure helpers for the filter builder, the
// chips and the cell menu. Nodes keep a client-side `id`, which the backend
// ignores, so React keys and focus survive edits to their siblings.

import type { DataColumn, FilterCondition, FilterCustom, FilterGroup, FilterNode, FilterOp } from "./types";

let nextId = 0;
const newId = () => `f${++nextId}`;

/** What the builder's operator menu picks: a condition's operator, or a custom expression. */
export type Operator = FilterOp | "custom";

const OPERATORS: { op: Operator; label: string; needs?: "comparable" | "text" }[] = [
  { op: "eq", label: "=", needs: "comparable" },
  { op: "ne", label: "≠", needs: "comparable" },
  { op: "lt", label: "<", needs: "comparable" },
  { op: "le", label: "≤", needs: "comparable" },
  { op: "gt", label: ">", needs: "comparable" },
  { op: "ge", label: "≥", needs: "comparable" },
  { op: "contains", label: "contains" },
  { op: "begins-with", label: "begins with" },
  { op: "ends-with", label: "ends with" },
  { op: "is-null", label: "is null" },
  { op: "is-not-null", label: "is not null" },
  { op: "is-empty", label: "is empty", needs: "text" },
  { op: "between", label: "between", needs: "comparable" },
  { op: "in", label: "in list", needs: "comparable" },
  { op: "custom", label: "custom" },
];

/** The operators a column allows; all of them for a column that no longer exists. */
export const operatorsFor = (column: DataColumn | undefined) =>
  OPERATORS.filter(({ needs }) => !column || !needs || (needs === "comparable" ? column.comparable : column.textLike));

/** A custom row has no column yet: the operators some column allows. */
export const operatorsForAny = (columns: DataColumn[]) =>
  OPERATORS.filter(({ op }) => columns.some((c) => operatorsFor(c).some((o) => o.op === op)));

const defaultOp = (column: DataColumn): FilterOp => (column.comparable ? "eq" : "contains");

/** Which value inputs an operator takes. */
export const valueKind = (op: FilterOp): "none" | "one" | "two" | "list" =>
  op === "is-null" || op === "is-not-null" || op === "is-empty" ? "none" : op === "between" ? "two" : op === "in" ? "list" : "one";

export const newCondition = (column: DataColumn): FilterCondition => ({
  kind: "condition",
  id: newId(),
  column: column.name,
  op: defaultOp(column),
  value: "",
  values: [],
  negated: false,
  disabled: false,
});

export const conditionNode = (fields: Pick<FilterCondition, "column" | "op" | "value"> & { negated?: boolean }): FilterCondition => ({
  kind: "condition",
  id: newId(),
  values: [],
  disabled: false,
  ...fields,
  negated: fields.negated ?? false,
});

export const newGroup = (op: FilterGroup["op"], children: FilterNode[] = []): FilterGroup => ({
  kind: "group",
  id: newId(),
  op,
  children,
  negated: false,
  disabled: false,
});

const newCustom = (): FilterCustom => ({ kind: "custom", id: newId(), sql: "", negated: false, disabled: false });

/** `change` applied to the node with this id. */
export const updateNode = (root: FilterGroup, id: string, change: (node: FilterNode) => FilterNode): FilterGroup => {
  const visit = (node: FilterNode): FilterNode => {
    if (node.id === id) return change(node);
    return node.kind === "group" ? { ...node, children: node.children.map(visit) } : node;
  };
  return visit(root) as FilterGroup;
};

/** The tree without the node with this id. Groups left empty stay, for the user to fill. */
export const removeNode = (root: FilterGroup, id: string): FilterGroup => ({
  ...root,
  children: root.children.filter((c) => c.id !== id).map((c) => (c.kind === "group" ? removeNode(c, id) : c)),
});

/** `node` ANDed with the whole tree: appended to an AND root, otherwise it wraps the root. */
export const andWith = (root: FilterGroup | null, node: FilterNode): FilterGroup => {
  if (!root || root.children.length === 0) return newGroup("and", [node]);
  return root.op === "and" ? { ...root, children: [...root.children, node] } : newGroup("and", [root, node]);
};

/** The node changed to another column, keeping its operator if that allows it. */
export const withColumn = (node: FilterCondition, column: DataColumn): FilterCondition => ({
  ...withValuesFor(node, operatorsFor(column).some((o) => o.op === node.op) ? node.op : defaultOp(column)),
  column: column.name,
});

/** The node with `op` and the fields it uses, carrying over the first value. A
 * condition's shape depends only on its operator and values, so going back to
 * the applied operator compares as unchanged. */
const withValuesFor = (node: FilterCondition, op: FilterOp): FilterCondition => {
  const first = node.value ?? node.values[0] ?? "";
  switch (valueKind(op)) {
    case "none":
      return { ...node, op, value: null, values: [] };
    case "one":
      return { ...node, op, value: first, values: [] };
    case "two":
      return { ...node, op, value: null, values: [first, node.values[1] ?? ""] };
    case "list":
      return { ...node, op, value: null, values: node.values.length ? node.values : [first] };
  }
};

/** The node changed to another operator, keeping what values still fit. */
export const withOperator = (node: FilterCondition | FilterCustom, op: Operator, columns: DataColumn[]): FilterNode => {
  const flags = { id: node.id, negated: node.negated, disabled: node.disabled };
  if (op === "custom") return { ...newCustom(), ...flags };
  // Leaving custom: the first column that allows the operator.
  const allowing = () => columns.find((c) => operatorsFor(c).some((o) => o.op === op)) ?? columns[0];
  const condition = node.kind === "condition" ? node : { ...newCondition(allowing()), ...flags };
  return withValuesFor(condition, op);
};

/** The node takes part in the filter: it's enabled, and a group has an enabled child. */
export const isActive = (node: FilterNode): boolean =>
  !node.disabled && (node.kind !== "group" || node.children.some(isActive));

export const activeChildren = (group: FilterGroup | null) => group?.children.filter(isActive) ?? [];

/** Whether a node needs no more input. Disabled nodes never reach the query. */
export const isFilled = (node: FilterNode): boolean => {
  if (node.disabled) return true;
  if (node.kind === "group") return true;
  if (node.kind === "custom") return node.sql.trim() !== "";
  switch (valueKind(node.op)) {
    case "none":
      return true;
    case "one":
      return !!node.value;
    case "two":
      return node.values.length === 2 && node.values.every((v) => v !== "");
    case "list":
      return node.values.some((v) => v !== "");
  }
};

/** Every enabled condition has its values, so the tree can be applied. */
export const isComplete = (node: FilterNode): boolean =>
  node.disabled || (node.kind === "group" ? node.children.every(isComplete) : isFilled(node));

/** The tree without its ids, to compare a draft with what's applied. */
const shape = (root: FilterGroup | null) =>
  JSON.stringify(root?.children.length ? root : null, (key, value) => (key === "id" ? undefined : value));

export const sameFilter = (a: FilterGroup | null, b: FilterGroup | null) => shape(a) === shape(b);

const SYMBOLS: Partial<Record<FilterOp, string>> = {
  eq: "=",
  ne: "≠",
  lt: "<",
  le: "≤",
  gt: ">",
  ge: "≥",
  contains: "contains",
  "begins-with": "begins with",
  "ends-with": "ends with",
};

const describeCondition = ({ column, op, value, values }: FilterCondition) => {
  switch (op) {
    case "is-null":
      return `${column} is null`;
    case "is-not-null":
      return `${column} is not null`;
    case "is-empty":
      return `${column} is empty`;
    case "between":
      return `${column} between ${values[0]} and ${values[1]}`;
    case "in":
      return `${column} in (${values.filter((v) => v !== "").join(", ")})`;
    default:
      return `${column} ${SYMBOLS[op]} ${value}`;
  }
};

/** A node as one line of text, for a chip. Disabled nodes are left out. */
export const describeNode = (node: FilterNode): string => {
  const text =
    node.kind === "condition"
      ? describeCondition(node)
      : node.kind === "custom"
        ? node.sql.trim()
        : `(${activeChildren(node).map(describeNode).join(` ${node.op.toUpperCase()} `)})`;
  return node.negated ? `NOT ${text}` : text;
};
