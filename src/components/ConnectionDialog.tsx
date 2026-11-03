import { useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Check, Plug, X } from "lucide-react";
import { errorMessage, testConnection } from "../lib/api";
import { CONNECTION_COLORS, SSL_MODES } from "../lib/types";
import type { ConnectionConfig, SslMode } from "../lib/types";
import { useConnections } from "../stores/connections";
import { Modal } from "./Modal";

/** Form values; port stays a string while being typed. */
interface Draft {
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  sslMode: SslMode;
  color: string | null;
}

type Tab = "general" | "ssl";
type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; version: string }
  | { status: "failed"; error: string };

const toDraft = (c: ConnectionConfig): Draft => ({
  ...c,
  port: String(c.port),
  database: c.database ?? "",
});

/** Client-side checks mirroring `ConnectionConfig::validate` in Rust. */
function validate(d: Draft, others: ConnectionConfig[]): Partial<Record<keyof Draft, string>> {
  const errors: Partial<Record<keyof Draft, string>> = {};
  const name = d.name.trim();
  if (!name) errors.name = "Connection name is required.";
  else if (others.some((c) => c.name.toLowerCase() === name.toLowerCase()))
    errors.name = "A connection with this name already exists.";
  if (!d.host.trim()) errors.host = "Host is required.";
  const port = Number(d.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = "Port must be between 1 and 65535.";
  if (!d.username.trim()) errors.username = "User name is required.";
  return errors;
}

export function ConnectionDialog() {
  const editing = useConnections((s) => s.editing);
  // Keyed so the form re-initializes for each connection opened.
  return editing ? <ConnectionForm key={editing.id || "new"} initial={editing} /> : null;
}

function ConnectionForm({ initial }: { initial: ConnectionConfig }) {
  const { connections, save, closeEditor } = useConnections();
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [tab, setTab] = useState<Tab>("general");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  // Bumped on every edit/test so a slow test can't report on settings that have since changed.
  const testRun = useRef(0);

  const isNew = initial.id === "";
  const errors = validate(
    draft,
    connections.filter((c) => c.id !== initial.id),
  );
  const valid = Object.keys(errors).length === 0;

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    testRun.current++;
    setTest({ status: "idle" });
  };

  const toConfig = (): ConnectionConfig => ({
    id: initial.id,
    name: draft.name.trim(),
    host: draft.host.trim(),
    port: Number(draft.port),
    username: draft.username.trim(),
    password: draft.password,
    database: draft.database.trim() || null,
    sslMode: draft.sslMode,
    color: draft.color,
  });

  /** Shows field errors and jumps to the General tab, where all validated fields live. */
  const ensureValid = () => {
    if (valid) return true;
    setShowErrors(true);
    setTab("general");
    return false;
  };

  const onTest = async () => {
    if (!ensureValid()) return;
    const run = ++testRun.current;
    setTest({ status: "testing" });
    let result: TestState;
    try {
      result = { status: "ok", version: await testConnection(toConfig()) };
    } catch (err) {
      result = { status: "failed", error: errorMessage(err) };
    }
    if (run === testRun.current) setTest(result);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ensureValid()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await save(toConfig());
    } catch (err) {
      setSaveError(errorMessage(err));
      setSaving(false);
    }
  };

  const fieldError = (key: keyof Draft) => (showErrors ? errors[key] : undefined);

  return (
    <Modal title={isNew ? "New Connection - PostgreSQL" : `Edit Connection - ${initial.name}`} onClose={closeEditor} dismissible={!saving} className="max-w-xl">
      <form onSubmit={onSubmit} noValidate>
        <div role="tablist" className="tabs tabs-border mb-4">
          {(["general", "ssl"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              className={`tab ${tab === t ? "tab-active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "general" ? "General" : "SSL"}
            </button>
          ))}
        </div>

        {tab === "general" ? (
          <div className="space-y-3">
            <Field label="Connection Name" error={fieldError("name")}>
              <input
                className="input input-sm w-full"
                value={draft.name}
                onChange={(e) => update("name", e.target.value)}
                data-autofocus
              />
            </Field>
            <Field label="Host" error={fieldError("host")}>
              <input
                className="input input-sm w-full"
                value={draft.host}
                onChange={(e) => update("host", e.target.value)}
                autoCapitalize="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Port" error={fieldError("port")}>
              <input
                className="input input-sm w-28"
                inputMode="numeric"
                value={draft.port}
                onChange={(e) => update("port", e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field label="Initial Database">
              <input
                className="input input-sm w-full"
                value={draft.database}
                placeholder="(defaults to postgres)"
                onChange={(e) => update("database", e.target.value)}
                autoCapitalize="off"
                spellCheck={false}
              />
            </Field>
            <Field label="User Name" error={fieldError("username")}>
              <input
                className="input input-sm w-full"
                value={draft.username}
                onChange={(e) => update("username", e.target.value)}
                autoCapitalize="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                className="input input-sm w-full"
                value={draft.password}
                onChange={(e) => update("password", e.target.value)}
              />
            </Field>
            <Field label="Color">
              <ColorPicker value={draft.color} onChange={(color) => update("color", color)} />
            </Field>
          </div>
        ) : (
          <div className="space-y-2">
            {SSL_MODES.map((mode) => (
              <label key={mode.value} className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="sslMode"
                  className="radio radio-sm radio-primary mt-0.5"
                  checked={draft.sslMode === mode.value}
                  onChange={() => update("sslMode", mode.value)}
                />
                <span>
                  <span className="block text-sm font-medium">{mode.label}</span>
                  <span className="block text-xs text-base-content/60">{mode.description}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        {test.status === "ok" && (
          <div className="alert alert-success mt-4 text-sm select-text">
            <Check className="size-4" /> Connection successful. <span className="truncate">{test.version}</span>
          </div>
        )}
        {test.status === "failed" && (
          <div className="alert alert-error mt-4 text-sm select-text">{test.error}</div>
        )}
        {saveError && <div className="alert alert-error mt-4 text-sm select-text">{saveError}</div>}

        <div className="modal-action items-center">
          <button type="button" className="btn btn-sm mr-auto" onClick={onTest} disabled={test.status === "testing"}>
            {test.status === "testing" ? <span className="loading loading-spinner loading-xs" /> : <Plug className="size-4" />}
            Test Connection
          </button>
          <button type="button" className="btn btn-sm" onClick={closeEditor} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={saving}>
            {saving && <span className="loading loading-spinner loading-xs" />}
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-center gap-x-3">
      <span className="text-right text-sm">{label}:</span>
      <div>{children}</div>
      {error && <span className="col-start-2 mt-1 text-xs text-error">{error}</span>}
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string | null; onChange: (color: string | null) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        title="No color"
        className={`flex size-6 items-center justify-center rounded-full border border-base-300 ${value === null ? "ring-2 ring-primary ring-offset-1" : ""}`}
        onClick={() => onChange(null)}
      >
        <X className="size-3 text-base-content/50" />
      </button>
      {CONNECTION_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          title={color}
          className={`size-6 rounded-full ${value === color ? "ring-2 ring-primary ring-offset-1" : ""}`}
          style={{ backgroundColor: color }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}
