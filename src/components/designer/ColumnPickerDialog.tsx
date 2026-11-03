import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Modal } from "../Modal";

/** A picked field or expression, with a sort order (indexes) or operator (excludes). */
export interface PickedKey {
  column: string;
  descending?: boolean;
  operator?: string;
}

/** Common exclusion operators, suggested for each element. */
const OPERATORS = ["=", "&&", "<>", "<@", "@>", "~=", "-|-"];
const OPERATORS_LIST_ID = "huxdb-exclude-operators";

interface ColumnPickerProps {
  title: string;
  /** Fields that can be picked, in table order. */
  available: string[];
  value: PickedKey[];
  /** Offer ASC / DESC per picked field (indexes). */
  withOrder?: boolean;
  /** Ask for an operator per picked field (exclusion constraints). */
  withOperator?: boolean;
  /** Allow typing an expression key (indexes). */
  withExpressions?: boolean;
  onSave: (value: PickedKey[]) => void;
  onClose: () => void;
}

/** Picks an ordered list of fields: available on the left, picked on the right. */
export function ColumnPickerDialog({ title, available, value, withOrder, withOperator, withExpressions, onSave, onClose }: ColumnPickerProps) {
  const [picked, setPicked] = useState<PickedKey[]>(value);
  const [expression, setExpression] = useState("");
  const unpicked = available.filter((name) => !picked.some((p) => p.column === name));

  const add = (column: string) =>
    setPicked((p) => [...p, withOperator ? { column, operator: "=" } : { column, descending: false }]);
  const move = (i: number, by: -1 | 1) =>
    setPicked((p) => {
      const next = [...p];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });

  return (
    <Modal title={title} onClose={onClose} className="max-w-2xl">
      {withOperator && (
        <datalist id={OPERATORS_LIST_ID}>
          {OPERATORS.map((op) => (
            <option key={op} value={op} />
          ))}
        </datalist>
      )}
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div className="flex flex-col gap-1">
          <span className="text-base-content/60">Available</span>
          <ul className="menu menu-sm h-56 w-full flex-nowrap overflow-auto rounded-box border border-base-300 p-1">
            {unpicked.map((name) => (
              <li key={name}>
                <button type="button" onClick={() => add(name)} title="Add">
                  {name}
                </button>
              </li>
            ))}
            {unpicked.length === 0 && <li className="menu-disabled px-3 py-1 text-base-content/50">No more fields</li>}
          </ul>
          {withExpressions && (
            <form
              className="join w-full"
              onSubmit={(e) => {
                e.preventDefault();
                if (expression.trim()) add(expression.trim());
                setExpression("");
              }}
            >
              <input
                className="input input-sm join-item w-full font-mono"
                placeholder="Expression, e.g. lower(email)"
                value={expression}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setExpression(e.target.value)}
              />
              <button type="submit" className="btn btn-sm join-item" disabled={!expression.trim()} aria-label="Add expression">
                <Plus className="size-4" />
              </button>
            </form>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-base-content/60">Selected (in order)</span>
          <ul className="h-56 overflow-auto rounded-box border border-base-300 p-1">
            {picked.map((p, i) => (
              <li key={`${p.column}-${i}`} className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-base-200">
                <span className="min-w-0 flex-1 truncate" title={p.column}>
                  {p.column}
                </span>
                {withOperator && (
                  <input
                    className="input input-xs w-16 font-mono"
                    list={OPERATORS_LIST_ID}
                    value={p.operator ?? ""}
                    aria-label={`Operator for ${p.column}`}
                    spellCheck={false}
                    onChange={(e) => setPicked((all) => all.map((q, j) => (j === i ? { ...q, operator: e.target.value } : q)))}
                  />
                )}
                {withOrder && (
                  <select
                    className="select select-xs w-20"
                    value={p.descending ? "desc" : "asc"}
                    aria-label={`Sort order of ${p.column}`}
                    onChange={(e) =>
                      setPicked((all) => all.map((q, j) => (j === i ? { ...q, descending: e.target.value === "desc" } : q)))
                    }
                  >
                    <option value="asc">ASC</option>
                    <option value="desc">DESC</option>
                  </select>
                )}
                <button type="button" className="btn btn-ghost btn-xs btn-square" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <ArrowUp className="size-3.5" />
                </button>
                <button type="button" className="btn btn-ghost btn-xs btn-square" disabled={i === picked.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                  <ArrowDown className="size-3.5" />
                </button>
                <button type="button" className="btn btn-ghost btn-xs btn-square" onClick={() => setPicked((all) => all.filter((_, j) => j !== i))} aria-label={`Remove ${p.column}`}>
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
            {picked.length === 0 && <li className="px-2 py-1 text-base-content/50">Click a field to add it</li>}
          </ul>
        </div>
      </div>
      <div className="modal-action">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-autofocus
          onClick={() => {
            onSave(picked);
            onClose();
          }}
        >
          OK
        </button>
      </div>
    </Modal>
  );
}
