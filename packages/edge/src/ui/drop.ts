import { type Edit, applyChanges, resolveEdits } from "../core/changes.ts";
import { type Point, type State, circlesHolding, insideCircle } from "../core/model.ts";
import { placeInside } from "../core/place.ts";
import { leaveStacks, refusal, stackOntoEdits } from "./actions.ts";
import { joinPlan, machineMember } from "./members.ts";

/**
 * Where a drag of cards ends: on a card (K-522), on the title of a circle (K-539), over the tray (K-509), on the map,
 * or away: over the side panel or the toolbar, where a card would land out of sight, so nothing changes.
 */
export type DropTarget =
  | { readonly _tag: "card"; readonly id: string }
  | { readonly _tag: "title"; readonly id: string }
  | { readonly _tag: "tray" }
  | { readonly _tag: "map" }
  | { readonly _tag: "away" };

/**
 * The edits of a drop with the toast text, why kitshn refuses it, or null when nothing changes. `note` follows the
 * share changes on the toast; `rightsIn` and `ask` come from `joinPlan`.
 */
export type DropPlan =
  | {
      readonly edits: Array<Edit>;
      readonly done: string | undefined;
      readonly note?: string;
      readonly rightsIn?: string | null;
      readonly ask?: string | null;
    }
  | { readonly refused: string }
  | null;

const machinesOf = (state: State, ids: ReadonlyArray<string>) =>
  ids.filter((id) => state.resources.get(id)?.kind === "machine");

/**
 * K-539: what the hover over a circle's title says, or null when the title acts as the circle's body: a card that is
 * no machine is only shared, as anywhere in the circle.
 */
export function titleHover(state: State, ids: ReadonlyArray<string>, circleId: string): string | null {
  const circle = state.circles.get(circleId);
  const machines = machinesOf(state, ids);
  if (!circle || machines.length === 0) return null;
  const name = (list: ReadonlyArray<string>) =>
    list.map((id) => state.resources.get(id)?.name ?? id).join(", ");
  const joining = machines.filter((id) => !machineMember(circle, id));
  if (joining.length > 0)
    return `+ ${name(joining)} ${joining.length === 1 ? "joins" : "join"} ${circle.name}`;
  return `${name(machines)} ${machines.length === 1 ? "is a member" : "are members"} of ${circle.name} already`;
}

/**
 * K-509: several cards from the tray fan out from the pointer, each in exactly the circles at the pointer, so none
 * falls out of a circle or into a neighbour. A card from the map keeps its own offset, as a group move does.
 */
export function landingPoints(state: State, moves: ReadonlyMap<string, Point>): ReadonlyMap<string, Point> {
  const fresh = [...moves.keys()].filter((id) => !state.places.has(id));
  const anchor = moves.get(fresh[0] ?? "");
  if (!anchor || fresh.length < 2) return moves;
  const wanted = new Set(
    [...state.circles.values()].filter((circle) => insideCircle(anchor, circle)).map((circle) => circle.id),
  );
  return new Map(
    [...moves].map(([id, point]): [string, Point] => [
      id,
      fresh.includes(id) ? (placeInside(state, point, wanted) ?? anchor) : point,
    ]),
  );
}

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
  if (target._tag === "title") return titlePlan(state, moves, ids, target.id, newStackId);
  if (target._tag === "card")
    return withShareNote(state, ids, stackOntoEdits(state, ids, target.id, newStackId));
  if (target._tag === "tray") {
    const placed = ids.filter((id) => state.places.has(id));
    if (placed.length === 0) return null;
    const edits: Array<Edit> = [
      ...placed.map((id): Edit => ({ _tag: "place", id, after: null })),
      ...leaveStacks(state, placed),
    ];
    return checked(state, edits, `Moved ${names(placed)} to the tray.`);
  }
  const landing = landingPoints(state, moves);
  const edits = ids.flatMap((id): Array<Edit> => {
    const after = landing.get(id);
    const before = state.places.get(id);
    return after && (!before || before.x !== after.x || before.y !== after.y)
      ? [{ _tag: "place", id, after }]
      : [];
  });
  if (edits.length === 0) return null;
  // A move on the map shows its share changes; a card that comes from the tray says that it is on the map now.
  const fresh = ids.filter((id) => !state.places.has(id));
  return withShareNote(
    state,
    ids,
    checked(state, edits, fresh.length > 0 ? `Placed ${names(fresh)} on the map.` : undefined),
  );
}

/**
 * K-539: a machine on a circle's title joins it and goes back to where the drag started, because control is not a
 * place. Other cards of the same drag land where they were dropped, as in the circle's body.
 */
function titlePlan(
  state: State,
  moves: ReadonlyMap<string, Point>,
  ids: ReadonlyArray<string>,
  circleId: string,
  newStackId: string,
): DropPlan {
  const circle = state.circles.get(circleId);
  const machines = machinesOf(state, ids);
  const others = new Map([...moves].filter(([id]) => !machines.includes(id)));
  const shared = others.size > 0 ? dropPlan(state, others, { _tag: "map" }, newStackId) : null;
  const joining = circle ? machines.filter((id) => !machineMember(circle, id)) : [];
  if (!circle || joining.length === 0) return shared;
  const join = joinPlan(state, joining, circle);
  if ("refused" in join) return join;
  const edits = [...(shared && "edits" in shared ? shared.edits : []), ...join.edits];
  const refused = refusal(state, edits);
  return refused ? { refused } : { edits, done: join.done, rightsIn: join.rightsIn, ask: join.ask };
}

/** K-539: a machine card in the body of a circle is shared with it, and the toast says that it is no member. */
function withShareNote(state: State, ids: ReadonlyArray<string>, plan: DropPlan): DropPlan {
  if (!plan || "refused" in plan) return plan;
  const next = applyChanges(state, resolveEdits(state, plan.edits));
  const entered = machinesOf(state, ids).some((id) => {
    const before = circlesHolding(state, id);
    return circlesHolding(next, id).some(
      (circle) => !before.some((each) => each.id === circle.id) && !machineMember(circle, id),
    );
  });
  return entered ? { ...plan, note: "Shared, not a member: its title takes members." } : plan;
}

const checked = (state: State, edits: Array<Edit>, done: string | undefined): DropPlan => {
  const refused = refusal(state, edits);
  return refused ? { refused } : { edits, done };
};
