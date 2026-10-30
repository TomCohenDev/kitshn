import type { Edit } from "../core/changes.ts";
import type { Point, State } from "../core/model.ts";
import { leaveStacks, refusal, stackOntoEdits } from "./actions.ts";

/**
 * Where a drag of cards ends: on a card (K-522), over the tray (K-509), on the map, or away: over the side panel or
 * the toolbar, where a card would land out of sight, so nothing changes.
 */
export type DropTarget =
  | { readonly _tag: "card"; readonly id: string }
  | { readonly _tag: "tray" }
  | { readonly _tag: "map" }
  | { readonly _tag: "away" };

/** The edits of a drop with the toast text, why kitshn refuses it, or null when nothing changes. */
export type DropPlan =
  { readonly edits: Array<Edit>; readonly done: string | undefined } | { readonly refused: string } | null;

/**
 * K-509, K-522: what a drop of cards does. Cards from the map and from the tray take the same path: onto a card
 * they stack with it, over the tray they leave every circle, elsewhere each lands at its point in `moves`.
 */
export function dropPlan(
  state: State,
  moves: ReadonlyMap<string, Point>,
  target: DropTarget,
  newStackId: string,
): DropPlan {
  const ids = [...moves.keys()].filter((id) => state.resources.has(id));
  const names = (list: ReadonlyArray<string>) =>
    list.flatMap((id) => state.resources.get(id)?.name ?? []).join(", ");
  if (target._tag === "away") return null;
  if (target._tag === "card") return stackOntoEdits(state, ids, target.id, newStackId);
  if (target._tag === "tray") {
    const placed = ids.filter((id) => state.places.has(id));
    if (placed.length === 0) return null;
    const edits: Array<Edit> = [
      ...placed.map((id): Edit => ({ _tag: "place", id, after: null })),
      ...leaveStacks(state, placed),
    ];
    return checked(state, edits, `Moved ${names(placed)} to the tray.`);
  }
  const edits = ids.flatMap((id): Array<Edit> => {
    const after = moves.get(id);
    const before = state.places.get(id);
    return after && (!before || before.x !== after.x || before.y !== after.y)
      ? [{ _tag: "place", id, after }]
      : [];
  });
  if (edits.length === 0) return null;
  // A move on the map shows its share changes; a card that comes from the tray says that it is on the map now.
  const fresh = ids.filter((id) => !state.places.has(id));
  return checked(state, edits, fresh.length > 0 ? `Placed ${names(fresh)} on the map.` : undefined);
}

const checked = (state: State, edits: Array<Edit>, done: string | undefined): DropPlan => {
  const refused = refusal(state, edits);
  return refused ? { refused } : { edits, done };
};
