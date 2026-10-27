import {
  ADMIN_RESOURCE_ID,
  type Circle,
  type Level,
  OWNER_CIRCLE_ID,
  type Point,
  type Resource,
  type ShareSetting,
  type State,
  circlesHolding,
  isPublicCircle,
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
    };

/** One stored change of a revision. Undo swaps `before` and `after`. */
export type Change =
  | { readonly _tag: "circle"; readonly id: string; readonly before: Circle | null; readonly after: Circle | null }
  | { readonly _tag: "place"; readonly id: string; readonly before: Point | null; readonly after: Point | null }
  | {
      readonly _tag: "shareSetting";
      readonly id: string;
      readonly before: ShareSetting | null;
      readonly after: ShareSetting | null;
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
  }
};

/** Turns edits into changes against the current state. Edits that change nothing drop out (K-1302). */
export function resolveEdits(state: State, edits: ReadonlyArray<Edit>): Array<Change> {
  const seen = new Set<string>();
  const changes: Array<Change> = [];
  for (const edit of edits) {
    const id = edit._tag === "shareSetting" ? shareKey(edit.resourceId, edit.circleId) : edit.id;
    const key = `${edit._tag}:${id}`;
    if (seen.has(key)) throw new RuleError(`The same ${edit._tag} "${id}" is edited twice in one change.`);
    seen.add(key);
    if (edit._tag === "circle" && edit.after && edit.after.id !== edit.id) {
      throw new RuleError(`A circle edit cannot change the circle id "${edit.id}".`);
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
  return changes;
}

export const invert = (changes: ReadonlyArray<Change>): Array<Change> =>
  changes.map((change) => ({ ...change, before: change.after, after: change.before }) as Change);

/** Names the first change whose current value is not its `before`, or null. */
export function conflictOf(state: State, changes: ReadonlyArray<Change>): string | null {
  for (const change of changes) {
    if (!deepEqual(current(state, change), change.before)) return `${change._tag} "${change.id}"`;
  }
  return null;
}

export function applyChanges(state: State, changes: ReadonlyArray<Change>): State {
  const circles = new Map(state.circles);
  const places = new Map(state.places);
  const shareSettings = new Map(state.shareSettings);
  const put = <V>(map: Map<string, V>, id: string, value: V | null) =>
    value === null ? map.delete(id) : map.set(id, value);
  for (const change of changes) {
    if (change._tag === "circle") put(circles, change.id, change.after);
    else if (change._tag === "place") put(places, change.id, change.after);
    else put(shareSettings, change.id, change.after);
  }
  return { circles, resources: state.resources, places, shareSettings };
}

/**
 * The rules that every write must keep (K-105, K-211). Returns the reason a state is refused, or null.
 * K-105 also refuses a public admin: a circle with "everyone" would compile to an Access Bypass policy.
 */
export function ruleViolation(state: State): string | null {
  if (!state.circles.has(OWNER_CIRCLE_ID)) return "The Owner circle cannot be deleted.";
  const admin = state.resources.get(ADMIN_RESOURCE_ID);
  if (!admin) return "The kitshn admin card is missing.";
  const holding = circlesHolding(state, admin.id);
  const publicCircle = holding.find((circle) => isPublicCircle(circle) && shareLevel(state, admin, circle));
  if (publicCircle) return `The kitshn admin cannot be shared with "${publicCircle.name}", which is public.`;
  const guarded = holding.some(
    (circle) =>
      circle.needsPasskey &&
      circle.endsAt === null &&
      circle.members.some((member) => member._tag === "email") &&
      shareLevel(state, admin, circle) === "control" &&
      (state.shareSettings.get(shareKey(admin.id, circle.id))?.endsAt ?? null) === null,
  );
  if (!guarded) {
    return "The kitshn admin must stay shared at control with a circle that has a person and needs a passkey.";
  }
  return null;
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
  const diffs = shareDiff(before, after);
  if (diffs.length > 0) {
    const shown = diffs.slice(0, 3).map(describeDiff).join("; ");
    return diffs.length > 3 ? `${shown}; and ${diffs.length - 3} more` : shown;
  }
  const circles = changes.filter((change) => change._tag === "circle");
  if (circles.length === 1 && circles[0]) {
    const circle = circles[0].after ?? circles[0].before;
    const verb = !circles[0].before ? "Created" : !circles[0].after ? "Deleted" : "Changed";
    return `${verb} circle ${circle?.name ?? circles[0].id}`;
  }
  const moved = changes.filter((change) => change._tag === "place").length;
  if (moved > 0 && moved === changes.length) return moved === 1 ? "Moved a card" : `Moved ${moved} cards`;
  return `Changed ${changes.length} items`;
}
