// What changed in the database since a diagram was saved. Pure.
//
// Names are identity: an OID survives a rename but not a drop and re-create, and a stale one
// can match something unrelated after a restore. So an OID is only ever a hint, offered as a
// possible rename for the user to confirm.

import type { DiagramCandidate, DiagramForeignKey, DiagramStructure, DiagramTable } from "./types";

type Named = { schema: string; name: string };

/** Exact and case-sensitive. JSON, because a dot can appear in a name. */
export const tableKey = ({ schema, name }: Named) => JSON.stringify([schema, name]);

/** A constraint's name is unique per table only, so its table is part of its key. */
export const foreignKeyKey = (fk: DiagramForeignKey, child: Named) => JSON.stringify([child.schema, child.name, fk.name]);

export interface RemovedTable extends Named {
  key: string;
  /** The saved OID now has this name. A hint for the user to confirm, never applied by itself. */
  renamedTo: DiagramCandidate | null;
}

export interface ModifiedTable extends Named {
  key: string;
  changes: string[];
}

export interface DriftReport {
  /** New in the database, in a schema the diagram uses. Not on the diagram until ticked. */
  added: DiagramCandidate[];
  removed: RemovedTable[];
  modified: ModifiedTable[];
  /** Foreign keys between tables on both sides. These apply at once. */
  foreignKeys: string[];
}

export const reportCount = ({ added, removed, modified, foreignKeys }: DriftReport) => added.length + removed.length + modified.length + foreignKeys.length;

/** The saved tables' OIDs today, found by name. */
export function resolveOids(snapshot: DiagramStructure, candidates: DiagramCandidate[]) {
  const byKey = new Map(candidates.map((c) => [tableKey(c), c.oid]));
  return snapshot.tables.flatMap((t) => byKey.get(tableKey(t)) ?? []);
}

function columnChanges(before: DiagramTable, after: DiagramTable) {
  const changes: string[] = [];
  const old = new Map(before.columns.map((c) => [c.name, c]));
  const now = new Map(after.columns.map((c) => [c.name, c]));
  for (const c of after.columns) if (!old.has(c.name)) changes.push(`Column ${c.name} added`);
  for (const c of before.columns) if (!now.has(c.name)) changes.push(`Column ${c.name} removed`);
  for (const c of after.columns) {
    const was = old.get(c.name);
    if (!was) continue;
    if (was.dataType !== c.dataType) changes.push(`Column ${c.name}: ${was.dataType} → ${c.dataType}`);
    if (was.notNull !== c.notNull) changes.push(`Column ${c.name}: ${c.notNull ? "now NOT NULL" : "no longer NOT NULL"}`);
  }
  const primaryKey = (t: DiagramTable) => t.columns.filter((c) => c.primaryKey).map((c) => c.name).join(", ");
  if (primaryKey(before) !== primaryKey(after)) changes.push(`Primary key: (${primaryKey(before)}) → (${primaryKey(after)})`);
  return changes;
}

function foreignKeyChanges(before: DiagramStructure, after: DiagramStructure, onBothSides: Set<string>) {
  const definitions = (s: DiagramStructure) => {
    const tables = new Map(s.tables.map((t) => [t.oid, t]));
    const found = new Map<string, { name: string; definition: string }>();
    for (const fk of s.foreignKeys) {
      const child = tables.get(fk.childOid);
      const parent = tables.get(fk.parentOid);
      if (!child || !parent || !onBothSides.has(tableKey(child)) || !onBothSides.has(tableKey(parent))) continue;
      found.set(foreignKeyKey(fk, child), { name: `${child.name}.${fk.name}`, definition: JSON.stringify([tableKey(parent), fk.childColumns, fk.parentColumns]) });
    }
    return found;
  };
  const old = definitions(before);
  const now = definitions(after);
  const changes: string[] = [];
  for (const [key, { name, definition }] of now) {
    const was = old.get(key);
    if (!was) changes.push(`${name} added`);
    else if (was.definition !== definition) changes.push(`${name} changed`);
  }
  for (const [key, { name }] of old) if (!now.has(key)) changes.push(`${name} removed`);
  return changes;
}

/**
 * `known` is every table the database had at the last save. A diagram holds only the tables
 * someone chose, so this is what tells a new table from one they left out.
 */
export function compareStructure(saved: DiagramStructure, known: string[], current: DiagramStructure, candidates: DiagramCandidate[]): DriftReport {
  const now = new Map(current.tables.map((t) => [tableKey(t), t]));
  const byOid = new Map(candidates.map((c) => [c.oid, c]));
  const knownKeys = new Set(known);

  const removed: RemovedTable[] = [];
  const modified: ModifiedTable[] = [];
  for (const table of saved.tables) {
    const key = tableKey(table);
    const after = now.get(key);
    if (!after) {
      const hint = byOid.get(table.oid);
      removed.push({ key, schema: table.schema, name: table.name, renamedTo: hint && tableKey(hint) !== key ? hint : null });
      continue;
    }
    const changes = columnChanges(table, after);
    if (changes.length) modified.push({ key, schema: table.schema, name: table.name, changes });
  }

  const renameTargets = new Set(removed.flatMap((r) => (r.renamedTo ? [tableKey(r.renamedTo)] : [])));
  const schemas = new Set(saved.tables.map((t) => t.schema));
  const added = candidates.filter((c) => {
    const key = tableKey(c);
    return schemas.has(c.schema) && !knownKeys.has(key) && !now.has(key) && !renameTargets.has(key);
  });

  const onBothSides = new Set(saved.tables.map(tableKey).filter((key) => now.has(key)));
  return { added, removed, modified, foreignKeys: foreignKeyChanges(saved, current, onBothSides) };
}
