import {
  ADMIN_RESOURCE_ID,
  AGENT_RIGHTS,
  AGENT_RIGHT_NAMES,
  type Circle,
  type Level,
  type Member,
  OWNER_CIRCLE_ID,
  type PauseMode,
  type Point,
  type Resource,
  type ShareSetting,
  type Stack,
  type State,
  circlesHolding,
  isPublicCircle,
  levelRank,
  shareKey,
  shareLevel,
} from "./model.ts";

/** One edit that a client asks for. `after: null` deletes. */
export type Edit =
  | { readonly _tag: "circle"; readonly id: string; readonly after: Circle | null }
  | { readonly _tag: "place"; readonly id: string; readonly after: Point | null }
  | {
      readonly _tag: "shareSetting";
      readonly resourceId: string;
      readonly circleId: string;
      readonly after: ShareSetting | null;
    }
  | { readonly _tag: "pause"; readonly after: PauseMode | null }
  | { readonly _tag: "stack"; readonly id: string; readonly after: Stack | null };

/** K-909: the card kinds that a deploy makes; only these come and go as an app. */
export const APP_KINDS = ["site.static", "site.worker", "site.compose"] as const;

/** K-909: the card of a deployed app as History keeps it. Its status is live data, so History leaves it out. */
export type AppCard = Omit<Resource, "status"> & { readonly kind: (typeof APP_KINDS)[number] };

export const isAppCard = (card: Omit<Resource, "status">): card is AppCard =>
  (APP_KINDS as ReadonlyArray<string>).includes(card.kind);

const withoutStatus = ({ status: _status, ...card }: Resource): Omit<Resource, "status"> => card;

/** K-909: a restored app card; the next report or deploy sets its status. */
export const restoredResource = (card: AppCard): Resource => ({ ...card, status: "unknown" });

/** One stored change of a revision. Undo swaps `before` and `after`. */
export type Change =
  | {
      readonly _tag: "circle";
      readonly id: string;
      readonly before: Circle | null;
      readonly after: Circle | null;
    }
  | {
      readonly _tag: "place";
      readonly id: string;
      readonly before: Point | null;
      readonly after: Point | null;
    }
  | {
      readonly _tag: "shareSetting";
      readonly id: string;
      readonly before: ShareSetting | null;
      readonly after: ShareSetting | null;
    }
  | { readonly _tag: "pause"; readonly id: "pause"; readonly before: PauseMode | null; readonly after: PauseMode | null }
  | {
      readonly _tag: "stack";
      readonly id: string;
      readonly before: Stack | null;
      readonly after: Stack | null;
    }
  /** K-909: an app card goes (removal) or comes back (its undo). The worker runs the teardown or the start. */
  | {
      readonly _tag: "app";
      readonly id: string;
      readonly before: AppCard | null;
      readonly after: AppCard | null;
    };

export type Actor =
  | { readonly _tag: "person"; readonly email: string }
  | { readonly _tag: "device"; readonly clientId: string; readonly name: string }
  | { readonly _tag: "kitshn"; readonly reason: string };

export interface Revision {
  readonly id: number;
  readonly at: number;
  readonly actor: Actor;
  readonly summary: string;
  readonly changes: ReadonlyArray<Change>;
  readonly undoes: number | null;
}

export class RuleError extends Error {
  override readonly name = "RuleError";
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const current = (state: State, change: Pick<Change, "_tag" | "id">) => {
  switch (change._tag) {
    case "circle":
      return state.circles.get(change.id) ?? null;
    case "place":
      return state.places.get(change.id) ?? null;
    case "shareSetting":
      return state.shareSettings.get(change.id) ?? null;
    case "pause":
      return state.paused;
    case "stack":
      return state.stacks.get(change.id) ?? null;
    case "app": {
      const resource = state.resources.get(change.id);
      return resource ? withoutStatus(resource) : null;
    }
  }
};

/** Turns edits into changes against the current state. Edits that change nothing drop out (K-1302). */
export function resolveEdits(state: State, edits: ReadonlyArray<Edit>): Array<Change> {
  const seen = new Set<string>();
  const changes: Array<Change> = [];
  for (const edit of edits) {
    const id =
      edit._tag === "shareSetting"
        ? shareKey(edit.resourceId, edit.circleId)
        : edit._tag === "pause"
          ? "pause"
          : edit.id;
    const key = `${edit._tag}:${id}`;
    if (seen.has(key)) throw new RuleError(`The same ${edit._tag} "${id}" is edited twice in one change.`);
    seen.add(key);
    if (edit._tag === "circle" && edit.after && edit.after.id !== edit.id) {
      throw new RuleError(`A circle edit cannot change the circle id "${edit.id}".`);
    }
    if (edit._tag === "stack" && edit.after) {
      if (edit.after.id !== edit.id)
        throw new RuleError(`A stack edit cannot change the stack id "${edit.id}".`);
      if (edit.after.members.length < 2) throw new RuleError("A stack holds at least two cards.");
      const missing = edit.after.members.find((id) => !state.resources.has(id));
      if (missing) throw new RuleError(`No card "${missing}" exists.`);
    }
    if (edit._tag === "place" && !state.resources.has(edit.id)) {
      throw new RuleError(`No card "${edit.id}" exists.`);
    }
    if (edit._tag === "shareSetting" && edit.after) {
      if (!state.resources.has(edit.resourceId)) throw new RuleError(`No card "${edit.resourceId}" exists.`);
      if (!state.circles.has(edit.circleId)) throw new RuleError(`No circle "${edit.circleId}" exists.`);
    }
    const before = current(state, { _tag: edit._tag, id });
    if (deepEqual(before, edit.after)) continue;
    changes.push({ _tag: edit._tag, id, before, after: edit.after } as Change);
  }
  return withStackMates(state, changes);
}

/**
 * K-521: a stack moves as one, so a change that moves one of its cards also moves the others of the stack
 * after the change. Edits and undo both go through this.
 */
export function withStackMates(state: State, changes: ReadonlyArray<Change>): Array<Change> {
  const stacks = new Map(state.stacks);
  for (const change of changes) {
    if (change._tag !== "stack") continue;
    if (change.after) stacks.set(change.id, change.after);
    else stacks.delete(change.id);
  }
  const placed = new Set(changes.flatMap((change) => (change._tag === "place" ? [change.id] : [])));
  const mates: Array<Change> = [];
  for (const change of changes) {
    if (change._tag !== "place") continue;
    // A card that goes back to the tray leaves its stack, as a deleted card does; the stack stays put.
    if (change.after === null) {
      for (const left of stacksWithout(stacks.values(), change.id)) {
        mates.push({ _tag: "stack", id: left.id, before: stacks.get(left.id) ?? null, after: left.after });
        if (left.after) stacks.set(left.id, left.after);
        else stacks.delete(left.id);
      }
      continue;
    }
    const stack = [...stacks.values()].find((candidate) => candidate.members.includes(change.id));
    for (const mate of stack?.members ?? []) {
      if (placed.has(mate)) continue;
      placed.add(mate);
      const before = state.places.get(mate) ?? null;
      if (!deepEqual(before, change.after)) mates.push({ _tag: "place", id: mate, before, after: change.after });
    }
  }
  return [...changes, ...mates];
}

/**
 * K-909: the changes that remove a deployed app: its card, its place, its share settings and its place in a
 * stack. Undo of them restores the card in the same place and circles.
 */
export function removeAppChanges(state: State, id: string): Array<Change> {
  const resource = state.resources.get(id);
  if (!resource) throw new RuleError(`No card "${id}" exists.`);
  const card = withoutStatus(resource);
  if (!isAppCard(card)) throw new RuleError(`${resource.name} is not an app that a deploy made (K-909).`);
  const edits: Array<Edit> = [
    ...(state.places.has(id) ? [{ _tag: "place", id, after: null } as const] : []),
    ...[...state.shareSettings.keys()]
      .filter((key) => key.startsWith(`${id}/`))
      .map((key): Edit => ({ _tag: "shareSetting", resourceId: id, circleId: key.slice(id.length + 1), after: null })),
  ];
  return [...resolveEdits(state, edits), { _tag: "app", id, before: card, after: null }];
}

export const invert = (changes: ReadonlyArray<Change>): Array<Change> =>
  changes.map((change) => ({ ...change, before: change.after, after: change.before }) as Change);

/** The first change whose current value is not its `before`, or null. */
export function conflictOf(state: State, changes: ReadonlyArray<Change>): Change | null {
  return changes.find((change) => !deepEqual(current(state, change), change.before)) ?? null;
}

export function applyChanges(state: State, changes: ReadonlyArray<Change>): State {
  const circles = new Map(state.circles);
  const resources = new Map(state.resources);
  const places = new Map(state.places);
  const shareSettings = new Map(state.shareSettings);
  const stacks = new Map(state.stacks);
  let paused = state.paused;
  const put = <V>(map: Map<string, V>, id: string, value: V | null) =>
    value === null ? map.delete(id) : map.set(id, value);
  for (const change of changes) {
    if (change._tag === "circle") put(circles, change.id, change.after);
    else if (change._tag === "place") put(places, change.id, change.after);
    else if (change._tag === "shareSetting") put(shareSettings, change.id, change.after);
    else if (change._tag === "stack") put(stacks, change.id, change.after);
    else if (change._tag === "app") put(resources, change.id, change.after && restoredResource(change.after));
    else paused = change.after;
  }
  return { ...state, circles, resources, places, shareSettings, stacks, paused };
}

/**
 * The rules that every write must keep (K-105, K-211). Returns the reason a state is refused, or null.
 * K-105 also refuses a public admin: a circle with "everyone" would compile to an Access Bypass policy.
 */
export function ruleViolation(state: State): string | null {
  if (!state.circles.has(OWNER_CIRCLE_ID)) return "The Owner circle cannot be deleted.";
  // K-521: a card is in one stack at most, and the cards of a stack share one point.
  const stacked = new Set<string>();
  for (const stack of state.stacks.values()) {
    for (const id of stack.members) {
      if (!state.resources.has(id)) return `The stack "${stack.name}" holds a card that no longer exists.`;
      if (stacked.has(id)) return `The card "${state.resources.get(id)?.name ?? id}" is in two stacks.`;
      stacked.add(id);
    }
    const points = new Set(stack.members.map((id) => JSON.stringify(state.places.get(id) ?? null)));
    if (points.size > 1) return `The cards of the stack "${stack.name}" must share one place.`;
  }
  const admin = state.resources.get(ADMIN_RESOURCE_ID);
  if (!admin) return "The kitshn admin card is missing.";
  const all = circlesHolding(state, admin.id);
  const publicCircle = all.find((circle) => isPublicCircle(circle) && shareLevel(state, admin, circle));
  const holding = all.filter((circle) => !state.paused || circle.id === OWNER_CIRCLE_ID);
  if (publicCircle) return `The kitshn admin cannot be shared with "${publicCircle.name}", which is public.`;
  const guarded = holding.some(
    (circle) =>
      circle.needsPasskey &&
      circle.endsAt === null &&
      circle.members.some((member) => member._tag === "email") &&
      (circle.match === "any" || allCircleCanMatch(circle)) &&
      shareLevel(state, admin, circle) === "control" &&
      (state.shareSettings.get(shareKey(admin.id, circle.id))?.endsAt ?? null) === null,
  );
  if (!guarded && state.paused) {
    return "A pause keeps only the Owner circle's share of the admin, so the Owner circle must hold the admin at control with a person and a passkey.";
  }
  if (!guarded) {
    return "The kitshn admin must stay shared at control with a circle that has a person and needs a passkey.";
  }
  return null;
}

/** An "all" circle matches someone only with one person, no device or machine, and domains of that person. */
function allCircleCanMatch(circle: Circle): boolean {
  const emails = circle.members.flatMap((member) =>
    member._tag === "email" ? [member.email.toLowerCase()] : [],
  );
  const [email] = emails;
  if (emails.length !== 1 || !email) return false;
  return circle.members.every((member) =>
    member._tag === "device" || member._tag === "machine"
      ? false
      : member._tag === "domain"
        ? email.endsWith(`@${member.domain.toLowerCase()}`)
        : true,
  );
}

export interface ShareDiff {
  readonly resource: Resource;
  readonly circle: Circle;
  readonly from: Level | null;
  readonly to: Level | null;
}

/** Every share that differs between two states (K-502 preview, K-503 toast). */
export function shareDiff(before: State, after: State): Array<ShareDiff> {
  const diffs: Array<ShareDiff> = [];
  const circleIds = new Set([...before.circles.keys(), ...after.circles.keys()]);
  for (const resource of after.resources.values()) {
    const was = new Set(circlesHolding(before, resource.id).map((circle) => circle.id));
    const is = new Set(circlesHolding(after, resource.id).map((circle) => circle.id));
    for (const circleId of circleIds) {
      const oldCircle = before.circles.get(circleId);
      const newCircle = after.circles.get(circleId);
      const from = was.has(circleId) && oldCircle ? shareLevel(before, resource, oldCircle) : null;
      const to = is.has(circleId) && newCircle ? shareLevel(after, resource, newCircle) : null;
      const circle = newCircle ?? oldCircle;
      if (from !== to && circle) diffs.push({ resource, circle, from, to });
    }
  }
  return diffs;
}

export const describeDiff = (diff: ShareDiff) =>
  diff.to
    ? `${diff.resource.name}: + ${diff.circle.name} · ${diff.to}`
    : `${diff.resource.name}: − ${diff.circle.name}`;

export function summarize(before: State, after: State, changes: ReadonlyArray<Change>): string {
  const app = changes.find((change) => change._tag === "app");
  if (app?.after) return `Restored the app ${app.after.name} (K-909)`;
  if (app?.before) return `Removed the app ${app.before.name} (K-909)`;
  const pause = changes.find((change) => change._tag === "pause");
  if (pause) {
    if (pause.after === null) return "Resumed all shares";
    if (pause.after === "keep-public") return "Paused all shares except public sites, apps, pages and files (K-1504)";
    return pause.before ? "Closed public sites too: lockdown (K-1504)" : "Paused all shares: lockdown (K-1504)";
  }
  const diffs = shareDiff(before, after);
  if (diffs.length > 0) {
    const shown = diffs.slice(0, 3).map(describeDiff).join("; ");
    return diffs.length > 3 ? `${shown}; and ${diffs.length - 3} more` : shown;
  }
  const circles = changes.filter((change) => change._tag === "circle");
  if (circles.length === 1 && circles[0]) {
    const rights = rightChanges(circles[0].before, circles[0].after);
    if (rights.length > 0) return rights.join("; ");
    const circle = circles[0].after ?? circles[0].before;
    const verb = !circles[0].before ? "Created" : !circles[0].after ? "Deleted" : "Changed";
    return `${verb} circle ${circle?.name ?? circles[0].id}`;
  }
  const stacks = changes.filter((change) => change._tag === "stack");
  if (stacks.length > 0) {
    const name = (id: string) => after.resources.get(id)?.name ?? before.resources.get(id)?.name ?? id;
    const names = (ids: ReadonlyArray<string>) => ids.map(name).join(", ");
    return stacks
      .map(({ before: was, after: is, id }) => {
        if (!was) return `Stacked ${names(is?.members ?? [])}`;
        if (!is) return `Unstacked ${was.name}`;
        const added = is.members.filter((member) => !was.members.includes(member));
        const removed = was.members.filter((member) => !is.members.includes(member));
        if (added.length > 0) return `Added ${names(added)} to ${is.name}`;
        if (removed.length > 0) return `Took ${names(removed)} out of ${is.name}`;
        return was.name === is.name ? `Changed the stack ${is.name || id}` : `Renamed ${was.name} to ${is.name}`;
      })
      .join("; ");
  }
  const moved = changes.filter((change) => change._tag === "place").length;
  if (moved > 0 && moved === changes.length) return moved === 1 ? "Moved a card" : `Moved ${moved} cards`;
  return `Changed ${changes.length} items`;
}

/** K-718: "Gave Bot may publish in Agents" for each agent right that a circle edit turns on or off. */
function rightChanges(before: Circle | null, after: Circle | null): Array<string> {
  if (!before || !after) return [];
  return after.members.flatMap((member) => {
    if (member._tag !== "device") return [];
    const old = before.members.find((other) => other._tag === "device" && other.tokenId === member.tokenId);
    if (old?._tag !== "device") return [];
    return AGENT_RIGHTS.filter((right) => old[right] !== member[right]).map((right) =>
      member[right]
        ? `Gave ${member.name} ${AGENT_RIGHT_NAMES[right]} in ${after.name}`
        : `Took ${AGENT_RIGHT_NAMES[right]} from ${member.name} in ${after.name}`,
    );
  });
}

/** K-522: the stacks that change when a card is gone; a stack left with fewer than two cards goes. */
export function stacksWithout(stacks: Iterable<Stack>, id: string): Array<{ id: string; after: Stack | null }> {
  return [...stacks]
    .filter((stack) => stack.members.includes(id))
    .map((stack) => {
      const members = stack.members.filter((member) => member !== id);
      return { id: stack.id, after: members.length > 1 ? { ...stack, members } : null };
    });
}

/**
 * K-1504: only "Resume" with a fresh passkey ends a pause or reopens public sites after a lockdown; an edit or
 * an undo never does.
 */
export function refuseResume(changes: Array<Change>): Array<Change> {
  const opens = (change: Change) =>
    change._tag === "pause" && (!change.after || (change.before === "lockdown" && change.after === "keep-public"));
  if (changes.some(opens))
    throw new RuleError("Resume needs your passkey again: press Resume on the map.");
  return changes;
}

/**
 * K-1504, MM-711: while paused, a change that would raise access when Resume returns the shares is refused:
 * a new share or a higher level, a new circle member, "needs passkey" off, "all must match" to "any", or a
 * later or removed end date. Changes that lower access still work.
 */
export function refuseRaiseWhilePaused(before: State, after: State): void {
  if (!before.paused || !after.paused) return;
  const raised = shareDiff(before, after).find(
    (diff) => diff.to !== null && (diff.from === null || levelRank(diff.to) > levelRank(diff.from)),
  );
  if (raised)
    throw new RuleError(`While paused, access only goes down: ${raised.resource.name} would gain ${raised.circle.name}.`);
  const ends = (time: number | null | undefined) => time ?? Number.POSITIVE_INFINITY;
  for (const key of new Set([...before.shareSettings.keys(), ...after.shareSettings.keys()]))
    if (ends(after.shareSettings.get(key)?.endsAt) > ends(before.shareSettings.get(key)?.endsAt))
      throw new RuleError("While paused, access only goes down: a share would end later.");
  for (const circle of after.circles.values()) {
    const old = before.circles.get(circle.id);
    if (!old) continue;
    // A device stays the same member when its name or an agent right changes; only a right that turns on raises.
    const key = (member: Member) =>
      JSON.stringify(member._tag === "device" ? { tokenId: member.tokenId, clientId: member.clientId } : member);
    const rights = (members: ReadonlyArray<Member>) =>
      members.flatMap((member) =>
        member._tag === "device" ? AGENT_RIGHTS.filter((right) => member[right]).map((right) => `${key(member)}/${right}`) : [],
      );
    const had = new Set([...old.members.map(key), ...rights(old.members)]);
    const has = new Set(circle.members.map(key));
    if (
      [...circle.members.map(key), ...rights(circle.members)].some((entry) => !had.has(entry)) ||
      // In an "all must match" circle, a member that goes lets more visitors in.
      (old.match === "all" && old.members.some((member) => !has.has(key(member)))) ||
      (old.needsPasskey && !circle.needsPasskey) ||
      (old.match === "all" && circle.match === "any") ||
      ends(circle.endsAt) > ends(old.endsAt) ||
      levelRank(circle.level) > levelRank(old.level)
    )
      throw new RuleError(`While paused, access only goes down: the circle ${circle.name} would let in more.`);
  }
}
