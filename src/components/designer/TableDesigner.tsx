import { useEffect, useState } from "react";
import type { ComponentType, FormEvent } from "react";
import { ArrowDown, ArrowUp, KeyRound, ListPlus, Plus, RotateCw, Save, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as api from "../../lib/api";
import { columnErrors, objectErrors, optionErrors, useTableDesigner } from "../../stores/tableDesigner";
import type { Designer, ObjectKind } from "../../stores/tableDesigner";
import { Modal } from "../Modal";
import { SqlEditor } from "../SqlEditor";
import { FieldsGrid } from "./FieldsGrid";
import { ChecksGrid, ExcludesGrid, ForeignKeysGrid, IndexesGrid, TriggersGrid, UniquesGrid } from "./ObjectGrids";
import { OptionsForm } from "./OptionsForm";

type DesignerTabName = "fields" | ObjectKind | "options" | "comment" | "sql";

const SUB_TABS: { tab: DesignerTabName; label: string }[] = [
  { tab: "fields", label: "Fields" },
  { tab: "indexes", label: "Indexes" },
  { tab: "foreignKeys", label: "Foreign Keys" },
  { tab: "uniques", label: "Uniques" },
  { tab: "checks", label: "Checks" },
  { tab: "excludes", label: "Excludes" },
  { tab: "triggers", label: "Triggers" },
  { tab: "options", label: "Options" },
  { tab: "comment", label: "Comment" },
  { tab: "sql", label: "SQL Preview" },
];

/** What the toolbar's Add / Delete buttons call the rows of each object tab. */
const OBJECT_NOUNS: Record<ObjectKind, string> = {
  indexes: "Index",
  foreignKeys: "Foreign Key",
  uniques: "Unique",
  checks: "Check",
  excludes: "Exclude",
  triggers: "Trigger",
};

const OBJECT_GRIDS: Record<ObjectKind, ComponentType<{ id: string }>> = {
  indexes: IndexesGrid,
  foreignKeys: ForeignKeysGrid,
  uniques: UniquesGrid,
  checks: ChecksGrid,
  excludes: ExcludesGrid,
  triggers: TriggersGrid,
};

const isObjectTab = (tab: DesignerTabName): tab is ObjectKind => tab in OBJECT_NOUNS;

/** Whether a sub-tab has a cell to fix, once errors show. */
function tabHasErrors(designer: Designer, tab: DesignerTabName): boolean {
  if (!designer.showErrors) return false;
  const { edited } = designer;
  if (tab === "fields") return edited.columns.some((_, row) => Object.keys(columnErrors(edited.columns, row)).length > 0);
  if (isObjectTab(tab)) return edited[tab].some((_, row) => Object.keys(objectErrors(edited, tab, row)).length > 0);
  if (tab === "options") return Object.keys(optionErrors(edited)).length > 0;
  return false;
}

function ToolButton({ icon: Icon, label, disabled, onClick }: { icon: LucideIcon; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm font-normal" disabled={disabled} onClick={onClick}>
      <Icon className="size-4 text-primary" strokeWidth={1.75} />
      {label}
    </button>
  );
}

/** Navicat-style table designer for one tab: create a table, or alter an existing one. */
export function TableDesigner({ id }: { id: string }) {
  const designer = useTableDesigner((s) => s.designers[id]);
  const [subTab, setSubTab] = useState<DesignerTabName>("fields");
  if (!designer) return null;

  const store = useTableDesigner.getState();
  const isNew = designer.original === null;
  const hasRow = designer.selectedRow !== null;
  const lastRow = designer.edited.columns.length - 1;
  const ObjectGrid = isObjectTab(subTab) ? OBJECT_GRIDS[subTab] : null;

  if (designer.status !== "loaded") {
    return (
      <div className="flex flex-1 flex-col items-center gap-3 p-6 text-sm">
        {designer.status === "loading" ? (
          <span className="loading loading-spinner loading-md" />
        ) : (
          <>
            <p className="text-error select-text">{designer.loadError}</p>
            <button type="button" className="btn btn-sm" onClick={() => store.load(id)}>
              <RotateCw className="size-4" /> Retry
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-0.5 border-b border-base-300 bg-base-200/50 px-2 py-1">
        <ToolButton icon={Save} label="Save" disabled={designer.saving} onClick={() => store.requestSave(id)} />
        {subTab === "fields" && (
          <>
            <div className="divider divider-horizontal mx-1 my-1" />
            <ToolButton icon={Plus} label="Add Field" onClick={() => store.addColumn(id)} />
            {isNew && <ToolButton icon={ListPlus} label="Insert Field" onClick={() => store.insertColumn(id)} />}
            <ToolButton icon={Trash2} label="Delete Field" disabled={!hasRow} onClick={() => store.deleteColumn(id)} />
            <ToolButton icon={KeyRound} label="Primary Key" disabled={!hasRow} onClick={() => store.toggleKey(id)} />
            {isNew && (
              <>
                <ToolButton icon={ArrowUp} label="Move Up" disabled={!hasRow || designer.selectedRow === 0} onClick={() => store.moveColumn(id, -1)} />
                <ToolButton icon={ArrowDown} label="Move Down" disabled={!hasRow || designer.selectedRow === lastRow} onClick={() => store.moveColumn(id, 1)} />
              </>
            )}
          </>
        )}
        {isObjectTab(subTab) && (
          <>
            <div className="divider divider-horizontal mx-1 my-1" />
            <ToolButton icon={Plus} label={`Add ${OBJECT_NOUNS[subTab]}`} onClick={() => store.addObject(id, subTab)} />
            <ToolButton
              icon={Trash2}
              label={`Delete ${OBJECT_NOUNS[subTab]}`}
              disabled={designer.selectedObjects[subTab] === null}
              onClick={() => store.deleteObject(id, subTab)}
            />
          </>
        )}
        {designer.saving && <span className="loading loading-spinner loading-sm ml-2" />}
      </div>

      <div role="tablist" className="tabs tabs-border tabs-sm border-b border-base-300 px-2">
        {SUB_TABS.map(({ tab, label }) => (
          <button key={tab} type="button" role="tab" className={`tab gap-1 ${subTab === tab ? "tab-active" : ""}`} onClick={() => setSubTab(tab)}>
            {label}
            {tabHasErrors(designer, tab) && <span className="status status-error" aria-label="Has errors" />}
          </button>
        ))}
      </div>

      {designer.saveError && (
        <div role="alert" className="alert alert-error alert-soft m-2 items-start rounded-md py-2 text-sm">
          <pre className="font-sans whitespace-pre-wrap select-text">{designer.saveError}</pre>
        </div>
      )}

      {subTab === "fields" && <FieldsGrid id={id} designer={designer} />}
      {ObjectGrid && <ObjectGrid id={id} />}
      {subTab === "options" && <OptionsForm id={id} />}
      {subTab === "comment" && (
        <textarea
          className="textarea m-3 min-h-40 w-auto max-w-2xl"
          placeholder="Table comment"
          value={designer.edited.comment ?? ""}
          onChange={(e) => store.setComment(id, e.target.value)}
        />
      )}
      {subTab === "sql" && <SqlPreview designer={designer} />}

      {designer.askingName && <TableNameDialog id={id} initial={designer.edited.name} />}
    </section>
  );
}

/** The statements Save would run, regenerated whenever this tab is shown. */
function SqlPreview({ designer }: { designer: Designer }) {
  const { original, edited } = designer;
  const [text, setText] = useState("");

  useEffect(() => {
    let ignore = false;
    // A new table has no name until its first save.
    const design = edited.name.trim() ? edited : { ...edited, name: "Untitled" };
    api.previewTableDdl(original, design).then(
      (statements) => !ignore && setText(statements.length ? statements.map((s) => `${s};`).join("\n\n") : "-- No changes"),
      (err) => !ignore && setText(`-- ${api.errorMessage(err)}`),
    );
    return () => {
      ignore = true;
    };
  }, [original, edited]);

  return <SqlEditor value={text} readOnly className="flex-1" />;
}

/** Asks for a new table's name on its first save, as Navicat does. */
function TableNameDialog({ id, initial }: { id: string; initial: string }) {
  const [name, setName] = useState(initial);
  const { setAskingName, save } = useTableDesigner.getState();
  const close = () => setAskingName(id, false);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    close();
    void save(id, name.trim());
  };

  return (
    <Modal title="Table Name" onClose={close}>
      <form onSubmit={onSubmit}>
        <input
          className="input w-full"
          data-autofocus
          value={name}
          placeholder="Enter a table name"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setName(e.target.value)}
        />
        <div className="modal-action">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
