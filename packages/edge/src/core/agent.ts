import type { Change } from "./changes.ts";
import type { Command } from "./machine.ts";
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
  const unpaused = { ...state, paused: null };
  return (
    circlesOf(state, visitor, now).size > 0 &&
    (!admin || visitorLevel(unpaused, admin, visitor, now) !== "control")
  );
}

/** The last finished deploy of a card, as kitshn stores it (K-807, K-812). */
export interface LastDeploy {
  readonly app: "static" | "compose";
  readonly repo: string;
  readonly branch: string;
  readonly resourceId: string;
  readonly environment: string;
  /** The address without the zone, which the daemon exposes. */
  readonly name: string;
  readonly composeFile: string | null;
}

/**
 * K-718: what a deploy by an agent key does. `redeploy` starts the last build that came up, from the copy
 * on the machine; `build` runs the repo's own workflow on the environment's branch. Neither takes code from
 * the key (K-812).
 */
export function agentDeployPlan(
  last: LastDeploy | null,
  mode: "redeploy" | "build",
  machine: {
    /** The daemon knows `compose-redeploy`. */
    readonly canRedeploy: boolean;
    /** The owner still lets deploys run there (K-610). */
    readonly takesDeploys: boolean;
    /** The card still runs on that machine (K-611). */
    readonly runsCard: boolean;
  } | null,
):
  | { readonly kind: "redeploy"; readonly command: Extract<Command, { kind: "compose-redeploy" }> }
  | { readonly kind: "build"; readonly repo: string; readonly branch: string }
  | { readonly kind: "refused"; readonly status: 409; readonly error: string } {
  const refused = (error: string) => ({ kind: "refused", status: 409, error }) as const;
  if (!last) return refused("kitshn has no finished deploy of this card to start again.");
  if (mode === "build") {
    // A pull request environment is always `pr-<n>` (K-807); its build comes from a push to the pull request.
    if (/^pr-\d+$/.test(last.environment))
      return refused("A preview builds again on a new push to its pull request, not from an agent key.");
    return last.branch
      ? { kind: "build", repo: last.repo, branch: last.branch }
      : refused("kitshn does not know the branch of this environment.");
  }
  if (last.app !== "compose")
    return refused("A static site keeps serving its last build; a new build comes from the repo (build).");
  if (!machine || !machine.runsCard) return refused("This app no longer runs on the machine of its last deploy.");
  if (!machine.takesDeploys) return refused("The machine of this app no longer has the label deploy (K-610).");
  if (!machine.canRedeploy) return refused("The daemon of this app cannot redeploy yet. Update the daemon first.");
  return {
    kind: "redeploy",
    command: {
      kind: "compose-redeploy",
      project: last.resourceId,
      name: last.name,
      environment: last.environment,
      repo: last.repo,
      file: last.composeFile,
    },
  };
}
