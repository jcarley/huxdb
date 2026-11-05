// State of each query tab, keyed by tab id. Like the other stores it lives
// outside the components, so the close prompt can commit a tab that isn't showing.
//
// A Run sends its statements' outcomes over a Channel as they finish. The last
// event, run-done, is what ends a run here: large messages can arrive after the
// command returns, so its promise only reports the runs that never started.
//
// `savedSql` is the text as last saved, so a tab is dirty with text that differs
// from it or with an open transaction. Saving the text is `stores/savedQueries.ts`.

import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import * as api from "../lib/api";
import { normalizeText } from "../lib/queryFiles";
import type { QueryEvent, RunScope, StatementOutcome, TxState } from "../lib/types";
import { useCompletionCatalog } from "./completionCatalog";
import type { DesignerTab } from "./tabs";

/** What the panel under the editor shows: a statement's rows, by its index, or Messages. */
export type ResultView = number | "messages";

export interface QueryEditor {
  tab: DesignerTab;
  sql: string;
  /** The text as last saved or loaded; empty for a tab that was never saved. */
  savedSql: string;
  /** The file's modification time then, to notice a change made elsewhere. */
  savedStamp: number | null;
  /** The run in progress. */
  runId: number | null;
  /** Statement being run and how many there are. */
  progress: { index: number; total: number } | null;
  tx: TxState;
  continueOnError: boolean;
  /** The last run's statements, in order. */
  outcomes: StatementOutcome[];
  view: ResultView;
  /** Something that stopped the run from starting, or a failed commit. */
  error: string | null;
  /** A passing message: cancelled, or the connection was lost. */
  notice: string | null;
  /** DDL ran since completion's catalog last loaded. It waits for the transaction,
   * because the catalog is read over another connection, which can't see it before that. */
  catalogStale: boolean;
}

interface QueryEditorState {
  editors: Record<string, QueryEditor>;

  /** `sql` is the text of a file being opened, which starts out saved. */
  open: (tab: DesignerTab, sql?: string, stamp?: number | null) => void;
  dispose: (id: string) => void;
  setSql: (id: string, sql: string) => void;
  setContinueOnError: (id: string, value: boolean) => void;
  /** The next run uses these. Changing while a transaction is open is blocked in the UI. */
  setTarget: (id: string, database: string, schema: string) => void;
  setView: (id: string, view: ResultView) => void;
  run: (id: string, scope: RunScope) => Promise<void>;
  stop: (id: string) => void;
  /** For the close prompt: commits the open transaction. */
  commit: (id: string) => Promise<boolean>;
  /** `sql` is now what's on disk, as of `stamp`. */
  markSaved: (id: string, sql: string, stamp: number | null) => void;
  setError: (id: string, error: string) => void;
  dismissMessages: (id: string) => void;
}

/** The text differs from what's saved. */
export const queryTextDirty = (q: QueryEditor | undefined) => !!q && q.sql !== q.savedSql;

/** Unsaved: edited text, or a transaction that's open or failed and waiting for a rollback. */
export const queryDirty = (q: QueryEditor | undefined) => queryTextDirty(q) || (!!q && q.tx !== "idle");

export const isQueryDirty = (id: string) => queryDirty(useQueryEditor.getState().editors[id]);

/** Identifies a run across the app, so a stale event or Stop can't reach another one. */
let lastRunId = 0;

/** After a run: the first result, unless something went wrong that Messages explains. */
function viewAfterRun(outcomes: StatementOutcome[], lost: boolean): ResultView {
  if (lost || outcomes.some((o) => o.error)) return "messages";
  return outcomes.find((o) => o.result)?.index ?? "messages";
}

export const useQueryEditor = create<QueryEditorState>((set, get) => {
  const update = (id: string, change: Partial<QueryEditor> | ((q: QueryEditor) => Partial<QueryEditor>)) =>
    set((s) => {
      const q = s.editors[id];
      if (!q) return s;
      return { editors: { ...s.editors, [id]: { ...q, ...(typeof change === "function" ? change(q) : change) } } };
    });

  const refreshStaleCatalog = (id: string) => {
    const q = get().editors[id];
    if (!q?.catalogStale || q.tx !== "idle") return;
    update(id, { catalogStale: false });
    useCompletionCatalog.getState().refresh(q.tab.connectionId, q.tab.database);
  };

  const onEvent = (id: string, runId: number, event: QueryEvent) => {
    update(id, (q) => {
      if (q.runId !== runId) return {};
      switch (event.event) {
        case "statement-started":
          return { progress: { index: event.index, total: event.total } };
        case "statement-finished":
          return {
            outcomes: [...q.outcomes, event.outcome],
            tx: event.outcome.tx,
            catalogStale: q.catalogStale || (event.outcome.changesCatalog && !event.outcome.error),
          };
        case "run-done":
          return {
            runId: null,
            progress: null,
            tx: event.tx,
            view: viewAfterRun(q.outcomes, event.sessionLost !== null),
            notice: event.sessionLost ?? (event.stopped ? "Cancelled" : null),
          };
      }
    });
    if (event.event === "run-done") refreshStaleCatalog(id);
  };

  return {
    editors: {},

    open: (tab, sql = "", stamp = null) =>
      set((s) => ({
        editors: {
          ...s.editors,
          [tab.id]: { tab, sql: normalizeText(sql), savedSql: normalizeText(sql), savedStamp: stamp, runId: null, progress: null, tx: "idle", continueOnError: false, outcomes: [], view: "messages", error: null, notice: null, catalogStale: false },
        },
      })),

    dispose: (id) => {
      void api.queryClose(id).catch(() => {});
      set((s) => {
        const { [id]: _, ...editors } = s.editors;
        return { editors };
      });
    },

    setSql: (id, sql) => update(id, { sql }),
    setContinueOnError: (id, continueOnError) => update(id, { continueOnError }),
    setTarget: (id, database, schema) => update(id, (q) => ({ tab: { ...q.tab, database, schema } })),
    setView: (id, view) => update(id, { view }),
    dismissMessages: (id) => update(id, { error: null, notice: null }),

    run: async (id, scope) => {
      const q = get().editors[id];
      if (!q || q.runId !== null) return;
      const runId = ++lastRunId;
      update(id, { runId, progress: null, outcomes: [], view: "messages", error: null, notice: null });
      const channel = new Channel<QueryEvent>();
      channel.onmessage = (event) => onEvent(id, runId, event);
      const { connectionId, database, schema } = q.tab;
      try {
        await api.queryRun(id, runId, { connectionId, database, schema }, q.sql, scope, q.continueOnError, channel);
      } catch (err) {
        update(id, (now) => (now.runId === runId ? { runId: null, error: api.errorMessage(err) } : {}));
      }
    },

    stop: (id) => {
      const runId = get().editors[id]?.runId;
      if (runId == null) return;
      api.queryCancel(id, runId).catch((err) => update(id, { error: api.errorMessage(err) }));
    },

    markSaved: (id, savedSql, savedStamp) => update(id, { savedSql, savedStamp }),
    setError: (id, error) => update(id, { error }),

    commit: async (id) => {
      const q = get().editors[id];
      if (!q) return true;
      if (q.runId !== null) {
        update(id, { error: "A query is running. Stop it first." });
        return false;
      }
      try {
        await api.queryEnd(id, true);
        update(id, { tx: "idle" });
        refreshStaleCatalog(id);
        return true;
      } catch (err) {
        // The transaction is over either way.
        update(id, { tx: "idle", error: api.errorMessage(err) });
        return false;
      }
    },
  };
});
