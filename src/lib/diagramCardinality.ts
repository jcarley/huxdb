// What a foreign key's line says, from what the catalog can prove. Pure.
//
// Three of a line's four marks are facts. A parent's maximum is one, because a foreign key
// references a unique key. Its minimum comes from nullability, and the child's maximum from a
// unique index. The child's minimum is drawn as zero because the database can't express that a
// parent must have children.
//
// A domain's NOT NULL isn't in `attnotnull`, and a `CHECK (x IS NOT NULL)` isn't either, so such
// a column shows an optional parent. That errs safely, and is left alone.

import type { DiagramForeignKey } from "./types";

export type ParentEnd = "one" | "zero-or-one";
export type ChildEnd = "zero-or-one" | "zero-or-many";

/** How a line is drawn. Its marks describe the declared rule either way. */
export type LineKind = "plain" | "unchecked" | "partition";

export const parentEnd = (fk: DiagramForeignKey): ParentEnd => (fk.childRequiresParent ? "one" : "zero-or-one");
export const childEnd = (fk: DiagramForeignKey): ChildEnd => (fk.uniqueVia ? "zero-or-one" : "zero-or-many");

/** Orphans can exist under an unchecked key, which matters more than where a key is held. */
export const lineKind = (fk: DiagramForeignKey): LineKind => (!fk.enforced || !fk.validated ? "unchecked" : fk.childPartition || fk.parentPartition ? "partition" : "plain");

/** The line in words, each sentence from one end's marks. */
export const relationshipFacts = (fk: DiagramForeignKey, child: string, parent: string) => [
  `Each ${child} row ${fk.childRequiresParent ? "needs one" : "can have one"} ${parent} row.`,
  `Each ${parent} row can have ${fk.uniqueVia ? `one ${child} row` : `many ${child} rows`}.`,
];

/** What the marks can't say on their own. */
export function relationshipNotes(fk: DiagramForeignKey) {
  const notes = ["The database can't express that a parent must have children, so the child end always starts at zero."];
  if (!fk.enforced) notes.push("Not enforced: no row is checked, so a row can have no parent.");
  else if (!fk.validated) notes.push("Not validated: rows older than this key weren't checked, so some can have no parent.");
  if (fk.childPartition) notes.push(`Held by the partition ${fk.childPartition}. Its unique indexes and NOT NULL columns say nothing about other partitions, so this shows them as not proven.`);
  if (fk.parentPartition) notes.push(`References the partition ${fk.parentPartition}.`);
  return notes;
}
