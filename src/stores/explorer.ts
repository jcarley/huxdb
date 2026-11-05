// State for the sidebar object tree: Connection → Database → Schema → group → object.
// Each level is loaded from the backend the first time it is expanded.

import { create } from "zustand";
import * as api from "../lib/api";
import type { SchemaObjects } from "../lib/types";
import { useConnections } from "./connections";
import { useTabs } from "./tabs";

export type ObjectGroup = "tables" | "views" | "materializedViews" | "functions";

/** Identifies a tree node. Only connection, database and schema nodes load data. */
export type TreeNodeRef =
  | { kind: "connection"; connectionId: string }
  | { kind: "database"; connectionId: string; database: string }
  | { kind: "schema"; connectionId: string; database: string; schema: string }
  | { kind: "group"; connectionId: string; database: string; schema: string; group: ObjectGroup }
  | { kind: "object"; connectionId: string; database: string; schema: string; group: ObjectGroup; name: string }
  | { kind: "queries"; connectionId: string }
  | { kind: "query"; connectionId: string; id: string };

export type LoadState = { status: "loading" } | { status: "loaded" } | { status: "error"; error: string };

// Separator that can't appear in PostgreSQL identifiers typed by humans in practice
// (unlike "/" or "."), so keys never collide.
const SEP = "\u001f";
/** In the place a database's name goes, where "#queries" could be a real name. */
const QUERIES = "\u001equeries";

/** Stable string key for a node; a node's key is a prefix of all its descendants' keys. */
export function nodeKey(node: TreeNodeRef): string {
  switch (node.kind) {
    case "connection":
      return node.connectionId;
    case "database":
      return [node.connectionId, node.database].join(SEP);
    case "schema":
      return [node.connectionId, node.database, node.schema].join(SEP);
    case "group":
      return [node.connectionId, node.database, node.schema, `#${node.group}`].join(SEP);
    case "object":
      return [node.connectionId, node.database, node.schema, `#${node.group}`, node.name].join(SEP);
    case "queries":
      return [node.connectionId, QUERIES].join(SEP);
    case "query":
      return [node.connectionId, QUERIES, node.id].join(SEP);
  }
}

/** A group or object node, i.e. one that lives under a schema's object group. */
type GroupedRef = Extract<TreeNodeRef, { kind: "group" | "object" }>;

/** Whether `node` is a schema's `group` node or an object under it; the details pane shows that group's list then. */
export function isGroupSelection(node: TreeNodeRef | null, group: ObjectGroup): node is GroupedRef {
  return (node?.kind === "group" || node?.kind === "object") && node.group === group;
}

/** Whether `node` is a connection's Queries node or a query under it. */
export const isQueriesSelection = (node: TreeNodeRef | null): node is Extract<TreeNodeRef, { kind: "queries" | "query" }> =>
  node?.kind === "queries" || node?.kind === "query";

const isWithin = (key: string, ancestor: string) => key === ancestor || key.startsWith(ancestor + SEP);
const isBelow = (key: string, ancestor: string) => key.startsWith(ancestor + SEP);

/** Copy of `record` without the keys matching `drop`. */
function omitKeys<T>(record: Record<string, T>, drop: (key: string) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !drop(k)));
}

/** Latest request id per node key; a response for an older id is ignored as stale. */
const requests = new Map<string, number>();
let nextRequest = 0;

interface ExplorerState {
  expanded: Record<string, true>;
  loads: Record<string, LoadState>;
  /** Databases per connection key. Present ⇔ the connection is open. */
  databases: Record<string, string[]>;
  /** Schemas per database key. */
  schemas: Record<string, string[]>;
  /** Objects per schema key. */
  objects: Record<string, SchemaObjects>;
  selectedKey: string | null;
  /** The node behind `selectedKey`; drives the details pane. */
  selected: TreeNodeRef | null;

  /** Expands a node, loading its children the first time (or after an error). */
  expand: (node: TreeNodeRef) => void;
  /** Collapses an expanded node, expands a collapsed one. */
  toggle: (node: TreeNodeRef) => void;
  /** Re-runs a node's load; its descendants are collapsed and reloaded when reopened. */
  refresh: (node: TreeNodeRef) => void;
  /** Re-runs a node's load in place, keeping expansion and the selection (e.g. after a designer save). */
  reload: (node: TreeNodeRef) => void;
  /** Selects a node and shows it in the main pane's Objects tab. */
  select: (node: TreeNodeRef) => void;
  /** Selects `group` in the selected node's schema (expanding the schema). No-op outside a schema. */
  showGroup: (group: ObjectGroup) => void;
  /** Selects the Queries node of the selected node's connection. */
  showQueries: () => void;
  /** Closes the connection's pools in the backend and forgets its tree state. */
  closeConnection: (connectionId: string) => Promise<void>;
  /** Drops all tree state for a connection (e.g. after it was edited or deleted). */
  forget: (connectionId: string) => void;
}

export const useExplorer = create<ExplorerState>((set, get) => {
  /** Drops expansion, load state, data, and in-flight requests for every key matching `drop`. */
  const clear = (drop: (key: string) => boolean) => {
    for (const k of [...requests.keys()]) if (drop(k)) requests.delete(k);
    set((s) => ({
      expanded: omitKeys(s.expanded, drop),
      loads: omitKeys(s.loads, drop),
      databases: omitKeys(s.databases, drop),
      schemas: omitKeys(s.schemas, drop),
      objects: omitKeys(s.objects, drop),
      ...(s.selectedKey && drop(s.selectedKey) ? { selectedKey: null, selected: null } : {}),
    }));
  };

  const load = async (node: TreeNodeRef) => {
    const key = nodeKey(node);
    const id = ++nextRequest;
    requests.set(key, id);
    set((s) => ({ loads: { ...s.loads, [key]: { status: "loading" } } }));

    let apply: (s: ExplorerState) => Partial<ExplorerState>;
    try {
      switch (node.kind) {
        case "connection": {
          const list = await api.openConnection(node.connectionId);
          apply = (s) => ({ databases: { ...s.databases, [key]: list } });
          break;
        }
        case "database": {
          const list = await api.listSchemas(node.connectionId, node.database);
          apply = (s) => ({ schemas: { ...s.schemas, [key]: list } });
          break;
        }
        case "schema": {
          const objects = await api.listSchemaObjects(node.connectionId, node.database, node.schema);
          apply = (s) => ({ objects: { ...s.objects, [key]: objects } });
          break;
        }
        default:
          return;
      }
      if (requests.get(key) !== id) return;
      set((s) => ({ ...apply(s), loads: { ...s.loads, [key]: { status: "loaded" } } }));
    } catch (err) {
      if (requests.get(key) !== id) return;
      set((s) => ({ loads: { ...s.loads, [key]: { status: "error", error: api.errorMessage(err) } } }));
    }
  };

  const loadsData = (node: TreeNodeRef) =>
    node.kind === "connection" || node.kind === "database" || node.kind === "schema";

  return {
    expanded: {},
    loads: {},
    databases: {},
    schemas: {},
    objects: {},
    selectedKey: null,
    selected: null,

    expand: (node) => {
      const key = nodeKey(node);
      set((s) => ({ expanded: { ...s.expanded, [key]: true } }));
      const state = get().loads[key];
      if (loadsData(node) && (!state || state.status === "error")) void load(node);
    },

    toggle: (node) => {
      const key = nodeKey(node);
      if (get().expanded[key]) {
        set((s) => ({ expanded: omitKeys(s.expanded, (k) => k === key) }));
      } else {
        get().expand(node);
      }
    },

    refresh: (node) => {
      if (!loadsData(node)) return;
      const key = nodeKey(node);
      clear((k) => isBelow(k, key));
      set((s) => ({ expanded: { ...s.expanded, [key]: true } }));
      void load(node);
    },

    reload: (node) => {
      if (loadsData(node) && get().loads[nodeKey(node)]) void load(node);
    },

    select: (node) => {
      set({ selectedKey: nodeKey(node), selected: node });
      useTabs.getState().activate(null);
      useConnections.getState().select(node.connectionId);
    },

    showGroup: (group) => {
      const node = get().selected;
      if (!node || !("schema" in node)) return;
      const { connectionId, database, schema } = node;
      get().expand({ kind: "schema", connectionId, database, schema });
      get().select({ kind: "group", connectionId, database, schema, group });
    },

    showQueries: () => {
      const node = get().selected;
      if (!node) return;
      const { connectionId } = node;
      get().expand({ kind: "connection", connectionId });
      get().select({ kind: "queries", connectionId });
    },

    closeConnection: async (connectionId) => {
      get().forget(connectionId);
      await api.closeConnection(connectionId);
    },

    forget: (connectionId) => clear((k) => isWithin(k, connectionId)),
  };
});
