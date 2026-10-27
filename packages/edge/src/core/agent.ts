import type { Edit } from "./changes.ts";
import {
  ADMIN_RESOURCE_ID,
  type Member,
  type State,
  activeShares,
  circlesHolding,
  isPublicCircle,
  shareKey,
} from "./model.ts";
import { visitorLevel } from "./visitor.ts";

/**
 * K-718: the circles that name the device itself as a member. Everyone, network and machine members do not
 * count: they match many callers, so they give an agent key nothing.
 */
export const circlesOf = (state: State, clientId: string | null) =>
  new Set(
    clientId === null
      ? []
      : [...state.circles.values()]
          .filter((circle) =>
            circle.members.some((member) => member._tag === "device" && member.clientId === clientId),
          )
          .map((circle) => circle.id),
  );

/**
 * K-718: the cards that a device manages: one of its own circles holds the card at the circle level
 * `control` (or a `control` override). This is the level of the circle, before a kind cuts it down: a site
 * has only `view` (K-301), and an agent key still manages it.
 */
export function cardsControlledBy(state: State, clientId: string | null, now: number) {
  const own = circlesOf(state, clientId);
  return new Set(
    [...state.resources.values()]
      .filter((resource) =>
        activeShares(state, resource, now).some(
          (share) =>
            own.has(share.circle.id) &&
            (state.shareSettings.get(shareKey(resource.id, share.circle.id))?.level ?? share.circle.level) ===
              "control",
        ),
      )
      .map((resource) => resource.id),
  );
}

/**
 * K-718: why an agent key may not make these edits, or null. It may only move cards that it controls, and
 * only from and to places inside its own circles at the level `control` that are not public; circles,
 * members, stacks, levels and the pause stay with the admin.
 */
export function agentRefusal(
  state: State,
  after: State,
  clientId: string | null,
  edits: ReadonlyArray<Edit>,
  now: number,
) {
  const controlled = cardsControlledBy(state, clientId, now);
  const own = circlesOf(state, clientId);
  for (const edit of edits) {
    if (edit._tag !== "place") return `An agent key may only move cards; it cannot change a ${edit._tag}.`;
    if (!controlled.has(edit.id))
      return `This key has no control on the card "${state.resources.get(edit.id)?.name ?? edit.id}".`;
    for (const side of [state, after]) {
      const foreign = circlesHolding(side, edit.id).find(
        (circle) => !own.has(circle.id) || circle.level !== "control" || isPublicCircle(circle),
      );
      if (foreign)
        return `An agent key moves cards only between its own circles with control that are not public, and "${foreign.name}" is not one of them.`;
    }
  }
  return null;
}

/** K-718: a device member that cannot run kitshn: no control on the admin card. The map calls it an agent. */
export function isAgentKey(state: State, member: Member, now: number): boolean {
  if (member._tag !== "device") return false;
  const admin = state.resources.get(ADMIN_RESOURCE_ID);
  // The pause takes every device off the admin for a while; that does not make the owner's devices agents.
  const unpaused = { ...state, paused: false };
  return (
    !admin ||
    visitorLevel(unpaused, admin, { email: null, clientId: member.clientId, ip: null }, now) !== "control"
  );
}
