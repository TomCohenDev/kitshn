import { type Edit, applyChanges, resolveEdits } from "../core/changes.ts";
import type { State } from "../core/model.ts";

/**
 * Edits that the map shows before the server holds them: a dropped card stays where the owner let go
 * while the save runs. `revision` is the revision that saved them; null until the server answers.
 */
export interface Held {
  readonly requestId: string;
  readonly edits: ReadonlyArray<Edit>;
  readonly revision: number | null;
}

/**
 * Drops the held edits that a snapshot already contains: the snapshot reached the revision that saved
 * them. Returns the same array when nothing changed.
 */
export function settle(held: ReadonlyArray<Held>, snapshotRevision: number): ReadonlyArray<Held> {
  const open = held.filter((item) => item.revision === null || item.revision > snapshotRevision);
  return open.length === held.length ? held : open;
}

/** The state with the held edits on top, oldest first. An edit that no longer fits is left out. */
export function overlay(state: State, held: ReadonlyArray<Held>): State {
  let shown = state;
  for (const item of held) {
    try {
      shown = applyChanges(shown, resolveEdits(shown, item.edits));
    } catch {
      // The server refuses this edit too; its answer removes it.
    }
  }
  return shown;
}

/** A snapshot older than the one shown would move cards back; the map ignores it. */
export const isNewer = (incoming: number, shown: number | null) => shown === null || incoming >= shown;
