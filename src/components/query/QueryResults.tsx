import { Check, CircleX, Crosshair, Info, OctagonX } from "lucide-react";
import type { StatementOutcome } from "../../lib/types";
import { useQueryEditor } from "../../stores/queryEditor";
import type { QueryEditor } from "../../stores/queryEditor";
import { ResultGrid } from "./ResultGrid";

function ViewTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="tab" className={`tab ${active ? "tab-active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}

function summary(outcome: StatementOutcome) {
  if (outcome.cancelled) return "Cancelled";
  if (outcome.error) return "Failed";
  const n = outcome.rowsAffected ?? outcome.result?.rows.length ?? 0;
  return `OK, ${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;
}

function OutcomeIcon({ outcome }: { outcome: StatementOutcome }) {
  if (outcome.error) return <CircleX className="size-4 shrink-0 text-error" />;
  if (outcome.cancelled) return <OctagonX className="size-4 shrink-0 text-warning" />;
  return <Check className="size-4 shrink-0 text-success" />;
}

/** One statement in Messages: outcome, rows, time, and what the server had to say. */
function OutcomeRow({ outcome, onJump }: { outcome: StatementOutcome; onJump: (pos: number, to?: number) => void }) {
  const { error } = outcome;
  return (
    <li className="flex flex-col gap-0.5 border-b border-base-300 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <OutcomeIcon outcome={outcome} />
        <span className="font-medium">{summary(outcome)}</span>
        <span className="text-base-content/50 tabular-nums">{outcome.elapsedMs.toLocaleString()} ms</span>
        <button type="button" className="min-w-0 flex-1 truncate text-left font-mono text-xs text-base-content/70 hover:underline" title="Select this statement" onClick={() => onJump(outcome.range.from, outcome.range.to)}>
          {outcome.sql}
        </button>
      </div>
      {error && (
        <div className="ml-6 flex flex-col gap-0.5 text-error select-text">
          <p className="whitespace-pre-wrap">
            {error.code && <span className="mr-2 font-mono text-xs">{error.code}</span>}
            {error.message}
          </p>
          {error.detail && <p className="whitespace-pre-wrap text-base-content/70">{error.detail}</p>}
          {error.hint && <p className="whitespace-pre-wrap text-base-content/70">{error.hint}</p>}
          {error.position !== null && (
            <button type="button" className="btn btn-ghost btn-xs self-start font-normal" onClick={() => onJump(error.position!)}>
              <Crosshair className="size-3.5" /> Go to Position
            </button>
          )}
        </div>
      )}
      {outcome.note && <p className="ml-6 text-warning">{outcome.note}</p>}
      {outcome.notices.map((notice, i) => (
        <p key={i} className="ml-6 flex items-center gap-1 text-base-content/70 select-text">
          <Info className="size-3.5 shrink-0" /> {notice}
        </p>
      ))}
    </li>
  );
}

/** The panel under the editor: one tab per statement's rows, plus Messages. */
export function QueryResults({ id, editor, onJump }: { id: string; editor: QueryEditor; onJump: (pos: number, to?: number) => void }) {
  const { outcomes, view } = editor;
  const setView = useQueryEditor((s) => s.setView);
  const results = outcomes.filter((o) => o.result);
  const shown = view === "messages" ? undefined : outcomes.find((o) => o.index === view);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" className="tabs tabs-border tabs-xs shrink-0 overflow-x-auto bg-base-200/50">
        {results.map((outcome, i) => (
          <ViewTab key={outcome.index} active={view === outcome.index} onClick={() => setView(id, outcome.index)} label={`Result ${i + 1}`} />
        ))}
        <ViewTab active={view === "messages"} onClick={() => setView(id, "messages")} label="Messages" />
      </div>
      {shown?.result ? (
        <ResultGrid key={shown.index} result={shown.result} rowsAffected={shown.rowsAffected} />
      ) : outcomes.length > 0 ? (
        <ul className="min-h-0 flex-1 overflow-auto text-sm">
          {outcomes.map((outcome) => (
            <OutcomeRow key={outcome.index} outcome={outcome} onJump={onJump} />
          ))}
        </ul>
      ) : (
        <p className="p-4 text-center text-sm text-base-content/50">{editor.runId === null ? "Run a statement to see its results." : "Running…"}</p>
      )}
    </div>
  );
}
