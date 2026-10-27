import type { Change } from "./changes.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  type Member,
  type State,
  activeShares,
  circlesHolding,
  shareKey,
} from "./model.ts";
import { type Visitor, circleMatches, visitorLevel } from "./visitor.ts";

/**
 * K-718: the agent circles of a device: circles of devices only that name it, have not ended, and that it
 * matches. A circle with people, networks, domains or Everyone is never an agent circle, so an agent key
 * cannot move a card to anyone but other devices.
 */
export const circlesOf = (state: State, visitor: Visitor, now: number) =>
  new Set(
    visitor.clientId === null
      ? []
      : [...state.circles.values()]
          .filter(
            (circle) =>
              circle.members.every((member) => member._tag === "device") &&
              circle.members.some((member) => member._tag === "device" && member.clientId === visitor.clientId) &&
              (circle.endsAt === null || circle.endsAt > now) &&
              circleMatches(circle, visitor, state.machines),
          )
          .map((circle) => circle.id),
  );

/**
 * K-718: the cards that a device manages: one of its own circles holds the card at the circle level
 * `control` (or a `control` override). This is the level of the circle, before a kind cuts it down: a site
 * has only `view` (K-301), and an agent key still manages it.
 */
export function cardsControlledBy(state: State, visitor: Visitor, now: number) {
  const own = circlesOf(state, visitor, now);
  return new Set(
    [...state.resources.values()]
      .filter((resource) =>
        activeShares(state, resource, now).some(
          (share) => own.has(share.circle.id) && levelIn(state, resource.id, share.circle) === "control",
        ),
      )
      .map((resource) => resource.id),
  );
}

/** The level a circle gives a card: its override, or the circle level, before the kind cuts it down. */
const levelIn = (state: State, resourceId: string, circle: Circle) =>
  state.shareSettings.get(shareKey(resourceId, circle.id))?.level ?? circle.level;

/**
 * K-718: an agent key runs jobs on a machine only when it manages the machine card, every card that runs on
 * the machine, and every card that the machine's own token opens (K-107), because a shell there reaches all.
 */
export function agentMayRunOn(state: State, visitor: Visitor, machineId: string, now: number) {
  const managed = cardsControlledBy(state, visitor, now);
  const machine = state.machines.get(machineId);
  const token = { email: null, clientId: machine?.clientId ?? null, ip: null };
  return (
    machine !== undefined &&
    managed.has(machineId) &&
    [...state.resources.values()].every(
      (resource) =>
        managed.has(resource.id) ||
        (resource.machine !== machineId && visitorLevel(state, resource, token, now) === null),
    )
  );
}

/**
 * K-718: why an agent key may not make these changes, or null. It may only move cards that it controls, and
 * only from and to places inside its agent circles at the level `control`, or out of every circle; circles,
 * members, stacks, levels and the pause stay with the admin. These are the resolved changes, so the other
 * cards of a stack that a move takes along (K-521) pass the same check.
 */
export function agentRefusal(
  state: State,
  after: State,
  visitor: Visitor,
  changes: ReadonlyArray<Change>,
  now: number,
) {
  const controlled = cardsControlledBy(state, visitor, now);
  const own = circlesOf(state, visitor, now);
  for (const edit of changes) {
    if (edit._tag !== "place") return `An agent key may only move cards; it cannot change a ${edit._tag}.`;
    if (!controlled.has(edit.id))
      return `This key has no control on the card "${state.resources.get(edit.id)?.name ?? edit.id}".`;
    for (const side of [state, after]) {
      const foreign = circlesHolding(side, edit.id).find(
        (circle) => !own.has(circle.id) || levelIn(side, edit.id, circle) !== "control",
      );
      if (foreign)
        return `An agent key moves cards only between its own agent circles with control, and "${foreign.name}" is not one of them.`;
    }
  }
  return null;
}

/** K-718: a device member in an agent circle, without the admin card. The map calls it an agent. */
export function isAgentKey(state: State, member: Member, now: number): boolean {
  if (member._tag !== "device") return false;
  const visitor = { email: null, clientId: member.clientId, ip: null };
  const admin = state.resources.get(ADMIN_RESOURCE_ID);
  // The pause takes every device off the admin for a while; that does not make the owner's devices agents.
  const unpaused = { ...state, paused: false };
  return (
    circlesOf(state, visitor, now).size > 0 &&
    (!admin || visitorLevel(unpaused, admin, visitor, now) !== "control")
  );
}
