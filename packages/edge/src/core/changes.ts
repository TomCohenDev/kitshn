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
  insideCircle,
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

/**
 * K-1505: moves of the same cards or circles by the same actor join the revision of the move or drop that
 * started them, while each comes within this time of the one before. Two minutes covers the nudges after a
 * drop, and a later rearrangement gets its own History entry.
 */
export const MOVE_MERGE_MS = 2 * 60 * 1000;

const onlyMoved = (before: Circle, after: Circle) => deepEqual({ ...before, x: 0, y: 0 }, { ...after, x: 0, y: 0 });

/** K-1505: a card or circle that lands somewhere: a drop from the tray, a new circle, or a move. */
const lands = (change: Change) =>
  (change._tag === "place" && change.after !== null) ||
  (change._tag === "circle" &&
    change.after !== null &&
    (change.before === null || onlyMoved(change.before, change.after)));

const isMove = (change: Change) => change.before !== null && lands(change);

/**
 * K-1505: the changes of `previous` with the moves of `changes` merged in (first `before`, last `after`), or
 * null when the moves start a revision of their own. `previous` must be the newest revision.
 */
export function mergeMoves(
  previous: Pick<Revision, "actor" | "at" | "changes" | "undoes">,
  actor: Actor,
  now: number,
  changes: ReadonlyArray<Change>,
): Array<Change> | null {
  if (previous.undoes !== null || !deepEqual(previous.actor, actor) || now - previous.at > MOVE_MERGE_MS) return null;
  if (previous.changes.length === 0 || !previous.changes.every(lands) || !changes.every(isMove)) return null;
  const key = (change: Change) => `${change._tag}:${change.id}`;
  const merged = new Map(previous.changes.map((change) => [key(change), change]));
  for (const change of changes) {
    const first = merged.get(key(change));
    if (!first) return null;
    merged.set(key(change), { ...first, after: change.after } as Change);
  }
  return [...merged.values()];
}

/**
 * K-1505: the summary of a revision that moves joined. A move that changes a share gives the net summary
 * from `start` (History is the audit trail); a pure move keeps the first summary and says that it moved.
 */
export function mergedSummary(
  first: string,
  start: State,
  before: State,
  after: State,
  merged: ReadonlyArray<Change>,
): string {
  if (shareDiff(before, after).length > 0) return summarize(start, after, merged);
  if (first.startsWith("Moved ") || first.endsWith(" and moved it") || first.endsWith(" and moved them")) return first;
  return `${first}${merged.length === 1 ? " and moved it" : " and moved them"}`;
}

/** K-1506: what an undo reverses now, and a plain note for each part that it leaves as it is. */
export interface UndoPlan {
  readonly changes: Array<Change>;
  readonly kept: Array<string>;
}

const FIELD_NAMES: Readonly<Record<string, string>> = { x: "place", y: "place", r: "size", color: "colour" };

/**
 * K-1506: the access fields of a circle go back together or not at all, because a mix of old and new could
 * let in more than anyone chose.
 */
const CIRCLE_ACCESS = ["members", "level", "match", "needsPasskey", "endsAt"];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * K-1506: the value an undo sets for one change, from the current value. With `group` (and records on all
 * three sides), the fields of `group` go back as one unit and every other field on its own, each only while
 * nobody changed it since; `kept` names the units that stay. Otherwise the whole value goes back only while
 * it is still `after`, else "changed".
 */
function revertValue(
  now: unknown,
  before: unknown,
  after: unknown,
  group: ReadonlyArray<string> | null,
): { readonly value: unknown; readonly kept: ReadonlyArray<string> } | "changed" {
  if (deepEqual(now, before)) return { value: now, kept: [] };
  if (deepEqual(now, after)) return { value: before, kept: [] };
  if (group === null || !isRecord(now) || !isRecord(before) || !isRecord(after)) return "changed";
  const value: Record<string, unknown> = { ...now };
  const kept = new Set<string>();
  const units = [group, ...Object.keys(before).filter((field) => !group.includes(field)).map((field) => [field])];
  for (const unit of units) {
    const pick = (record: Readonly<Record<string, unknown>>) => unit.map((field) => record[field]);
    if (unit.length === 0 || deepEqual(pick(before), pick(after))) continue;
    if (deepEqual(pick(value), pick(after))) for (const field of unit) value[field] = before[field];
    else if (!deepEqual(pick(value), pick(before)))
      kept.add(unit === group ? "access (members, level, rules, end date)" : (FIELD_NAMES[unit[0] ?? ""] ?? unit[0] ?? ""));
  }
  return { value, kept: [...kept] };
}

/**
 * K-1506: the undo of a revision, against the current state. A card that the revision put on the map goes back
 * to the tray from wherever it is now, and a circle that it made goes while only its place changed since.
 * Every other part goes back only where nobody changed it since; the rest stays, with a note. The cards of a
 * stack that stays do not move. An app part that no longer fits refuses the whole undo (K-909), and so does
 * an undo that lets in more than the revision took away.
 */
export function undoPlan(
  state: State,
  changes: ReadonlyArray<Change>,
  since: () => Since = () => NOTHING_SINCE,
): UndoPlan {
  const restored = new Set(
    changes.flatMap((change) => (change._tag === "app" && change.before && !change.after ? [change.id] : [])),
  );
  const exists = (id: string) => state.resources.has(id) || restored.has(id);
  const cardName = (id: string) => state.resources.get(id)?.name ?? id;
  const out: Array<Change> = [];
  const kept: Array<string> = [];
  const keptStacks: Array<string> = [];
  for (const change of changes) {
    const now = current(state, change);
    if (change._tag === "app") {
      if (!deepEqual(now, change.after))
        throw new RuleError(`A later deploy or removal changed the app "${change.id}", so this undo no longer fits (K-909).`);
      out.push({ ...change, before: change.after, after: change.before });
      continue;
    }
    const [cardId, circleId] =
      change._tag === "place" ? [change.id] : change._tag === "shareSetting" ? change.id.split("/") : [];
    const what =
      change._tag === "place"
        ? cardName(change.id)
        : change._tag === "circle"
          ? `The circle ${(change.after ?? change.before)?.name ?? change.id}`
          : change._tag === "stack"
            ? `The stack ${(change.after ?? change.before)?.name ?? change.id}`
            : change._tag === "shareSetting"
              ? `The share of ${cardName(cardId ?? "")} with ${state.circles.get(circleId ?? "")?.name ?? circleId}`
              : "The pause";
    // The card or circle of the change itself is gone, or a card or circle that it names.
    const self =
      (change._tag === "place" && !exists(change.id)) ||
      (change._tag === "circle" && change.before && change.after && !now);
    const gone =
      cardId !== undefined && !exists(cardId)
        ? cardId
        : circleId !== undefined && !state.circles.has(circleId)
          ? circleId
          : change._tag === "stack"
            ? change.before?.members.find((id) => !exists(id))
            : undefined;
    if (self) {
      kept.push(`${what} no longer exists.`);
      continue;
    }
    if (gone !== undefined) {
      kept.push(`${what} stays as it is: ${gone} no longer exists.`);
      continue;
    }
    if (deepEqual(now, change.before)) continue;
    const back =
      (change._tag === "place" && change.before === null) ||
      (change._tag === "circle" &&
        change.before === null &&
        change.after !== null &&
        onlyMoved(state.circles.get(change.id) ?? change.after, change.after));
    const reverted = back
      ? { value: change.before, kept: [] }
      : revertValue(
          now,
          change.before,
          change.after,
          change._tag === "circle" ? CIRCLE_ACCESS : change._tag === "stack" ? [] : null,
        );
    if (reverted === "changed" || (change._tag === "stack" && reverted.kept.length > 0)) {
      if (change._tag === "stack") keptStacks.push(change.id);
      kept.push(
        change._tag === "place"
          ? `${what} stays where it is: a later change moved it.`
          : `${what} stays as it is: a later change changed it.`,
      );
      continue;
    }
    if (reverted.kept.length > 0) kept.push(`${what} keeps its ${reverted.kept.join(", ")}: a later change set it.`);
    if (!deepEqual(reverted.value, now))
      out.push({ _tag: change._tag, id: change.id, before: now, after: reverted.value } as Change);
  }
  // K-521: the cards of a stack that stays keep their place with it, so the undo moves none of them.
  const stayWithStack = new Set(keptStacks.flatMap((id) => state.stacks.get(id)?.members ?? []));
  let plan = out.filter((change) => !(change._tag === "place" && stayWithStack.has(change.id)));
  for (const id of keptStacks) {
    const stack = state.stacks.get(id);
    if (stack && out.some((change) => change._tag === "place" && stack.members.includes(change.id)))
      kept.push(`The cards of the stack ${stack.name} stay with it.`);
  }
  // A share that a card does not have now comes back only while its circle and its share setting are
  // unchanged since the revision; otherwise the parts that give it stay out (fail closed).
  const later = since();
  for (;;) {
    const after = applyChanges(state, withStackMates(state, plan));
    const gain = shareDiff(state, after).find(
      (diff) =>
        diff.to !== null &&
        (diff.from === null || levelRank(diff.to) > levelRank(diff.from)) &&
        (later.circles.has(diff.circle.id) || later.shares.has(shareKey(diff.resource.id, diff.circle.id))),
    );
    if (!gain) break;
    const card = gain.resource.id;
    const mates = [...state.stacks.values()].find((stack) => stack.members.includes(card))?.members ?? [card];
    const gives = (change: Change) =>
      (change._tag === "place" && mates.includes(change.id)) ||
      (change._tag === "circle" && change.id === gain.circle.id) ||
      (change._tag === "shareSetting" && change.id === shareKey(card, gain.circle.id));
    if (!plan.some(gives))
      throw new RuleError(`This undo would give ${gain.resource.name} a share with ${gain.circle.name}, which changed since.`);
    plan = plan.filter((change) => !gives(change));
    kept.push(
      restored.has(card)
        ? `${gain.resource.name} comes back in the tray: ${gain.circle.name} changed since.`
        : `${gain.circle.name} changed since; place ${gain.resource.name} by hand.`,
    );
  }
  // A circle that comes back holds the cards that are in its area now (K-204).
  const after = applyChanges(state, withStackMates(state, plan));
  for (const change of plan) {
    if (change._tag !== "circle" || change.before !== null || change.after === null) continue;
    const circle = change.after;
    const held = [...after.resources.values()].filter((card) =>
      circlesHolding(after, card.id).some((holding) => holding.id === circle.id),
    );
    if (held.length > 0 && isPublicCircle(circle))
      throw new RuleError(`Re-creating ${circle.name} would make its cards public; drag them in by hand.`);
    const moved = held.filter((card) => later.moved.has(card.id)).map((card) => card.name);
    if (moved.length > 0)
      kept.push(`The circle ${circle.name} is back and now also holds ${moved.join(", ")}, which moved into its area since.`);
  }
  // A card that joined a stack since then takes its stack along (K-521), but never into a public circle
  // without the question of K-210, which an undo does not ask.
  const own = new Set(plan.flatMap((change) => (change._tag === "place" ? [change.id] : [])));
  plan = withStackMates(state, plan);
  const goingPublic = shareDiff(state, applyChanges(state, plan)).find(
    (diff) => !own.has(diff.resource.id) && diff.to && !diff.from && isPublicCircle(diff.circle),
  );
  if (goingPublic)
    throw new RuleError(`This undo would make ${goingPublic.resource.name} public through its stack. Move the stack by hand.`);
  // An undo may let in more than now only where the revision took that access away.
  const at = (side: "before" | "after") =>
    applyChanges(state, changes.map((change) => ({ ...change, after: change[side] }) as Change));
  const allowed = new Set(accessRaises(at("after"), at("before")).map((raise) => raise.key));
  const raise = accessRaises(state, applyChanges(state, plan)).find((entry) => !allowed.has(entry.key));
  if (raise)
    throw new RuleError(
      [`This undo would let in more than anyone chose: ${raise.message}. Undo it by hand.`, ...kept].join(" "),
    );
  return { changes: plan, kept };
}

/** K-1506: what the revisions after an undone revision changed: cards moved, circles and share settings. */
export interface Since {
  readonly moved: ReadonlySet<string>;
  readonly circles: ReadonlySet<string>;
  readonly shares: ReadonlySet<string>;
}

const NOTHING_SINCE: Since = { moved: new Set(), circles: new Set(), shares: new Set() };

/**
 * K-1506: the cards, circles and share settings that `later` (the changes of the later revisions) touched.
 * A circle counts when anything but its name or colour changed: its access, place, size or public status.
 */
export function changedSince(later: Iterable<ReadonlyArray<Change>>): Since {
  const moved = new Set<string>();
  const circles = new Set<string>();
  const shares = new Set<string>();
  const looks = (circle: Circle | null) => circle && { ...circle, name: "", color: "" };
  for (const changes of later)
    for (const change of changes) {
      if (change._tag === "place") moved.add(change.id);
      if (change._tag === "shareSetting") shares.add(change.id);
      if (change._tag === "circle" && !deepEqual(looks(change.before), looks(change.after))) circles.add(change.id);
    }
  return { moved, circles, shares };
}

/**
 * K-1502: each revision that a whole undo in effect reverses, with that undo. An undo is in effect while no
 * undo in effect reverses it, so an undo of an undo puts the first revision back in effect.
 */
export function undoneRevisions(
  undos: ReadonlyArray<{ readonly id: number; readonly undoes: number }>,
): Map<number, number> {
  const byTarget = new Map<number, Array<number>>();
  for (const { id, undoes } of undos) byTarget.set(undoes, [...(byTarget.get(undoes) ?? []), id]);
  const effect = new Map<number, boolean>();
  const inEffect = (id: number): boolean => {
    const known = effect.get(id);
    if (known !== undefined) return known;
    const result = !(byTarget.get(id) ?? []).some(inEffect);
    effect.set(id, result);
    return result;
  };
  const undone = new Map<number, number>();
  for (const [target, ids] of byTarget) {
    const active = ids.filter(inEffect).sort((a, b) => b - a)[0];
    if (active !== undefined) undone.set(target, active);
  }
  return undone;
}

/** K-1507: a card or a circle that a per-item undo names. */
export interface Item {
  readonly kind: "card" | "circle";
  readonly id: string;
}

/** K-1507: whether a change is part of an item: a card's place, shares, app and stack membership; a circle and its shares. */
export function touches(change: Change, item: Item): boolean {
  if (item.kind === "circle")
    return (
      (change._tag === "circle" && change.id === item.id) ||
      (change._tag === "shareSetting" && change.id.endsWith(`/${item.id}`))
    );
  switch (change._tag) {
    case "place":
    case "app":
      return change.id === item.id;
    case "shareSetting":
      return change.id.startsWith(`${item.id}/`);
    case "stack":
      return (change.before?.members.includes(item.id) ?? false) !== (change.after?.members.includes(item.id) ?? false);
    case "circle":
    case "pause":
      return false;
  }
}

/**
 * K-1507: the part of a revision for one item. A circle that the revision dragged by its head (K-504) takes
 * the cards that moved with it.
 */
export function itemParts(changes: ReadonlyArray<Change>, item: Item): Array<Change> {
  const dragged =
    item.kind === "circle" &&
    changes.some(
      (change) =>
        change._tag === "circle" &&
        change.id === item.id &&
        change.before !== null &&
        change.after !== null &&
        (change.before.x !== change.after.x || change.before.y !== change.after.y),
    );
  // K-504: the cards that moved with the circle are the ones that sat inside it before the drag.
  const circleBefore = changes.flatMap((change) =>
    change._tag === "circle" && change.id === item.id && change.before ? [change.before] : [],
  )[0];
  const inside = (change: Change) =>
    change._tag === "place" && change.before !== null && circleBefore !== undefined && insideCircle(change.before, circleBefore);
  return changes.filter((change) => touches(change, item) || (dragged && inside(change)));
}

/**
 * K-1507: the parts of a revision that the per-item undos in effect did not take back. `reverted` holds the
 * changes that those undos made; a part counts as taken back only when an undo set it fully to its `before`.
 */
export const partsLeft = (changes: ReadonlyArray<Change>, reverted: ReadonlyArray<Change>): Array<Change> =>
  changes.filter(
    (change) =>
      !reverted.some(
        (undo) => undo._tag === change._tag && undo.id === change.id && deepEqual(undo.after, change.before),
      ),
  );

/** K-1507: how `revisions.item` stores the item of a per-item undo. */
export const itemKey = (item: Item) => `${item.kind}:${item.id}`;


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
 * Every way that `after` lets in more than `before`: a new share or a higher level, a new circle member,
 * "needs passkey" off, "all must match" to "any", or a later or removed end date (K-1504, K-1506).
 */
export function accessRaises(before: State, after: State): Array<{ readonly key: string; readonly message: string }> {
  const raises = shareDiff(before, after)
    .filter((diff) => diff.to !== null && (diff.from === null || levelRank(diff.to) > levelRank(diff.from)))
    .map((diff) => ({
      key: `share:${shareKey(diff.resource.id, diff.circle.id)}:${diff.to}`,
      message: `${diff.resource.name} would gain ${diff.circle.name} · ${diff.to}`,
    }));
  const ends = (time: number | null | undefined) => time ?? Number.POSITIVE_INFINITY;
  for (const key of new Set([...before.shareSettings.keys(), ...after.shareSettings.keys()]))
    if (ends(after.shareSettings.get(key)?.endsAt) > ends(before.shareSettings.get(key)?.endsAt))
      raises.push({ key: `ends:${key}`, message: `the share ${key} would end later` });
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
      raises.push({ key: `circle:${circle.id}`, message: `the circle ${circle.name} would let in more` });
  }
  return raises;
}

/**
 * K-1504, MM-711: while paused, a change that would raise access when Resume returns the shares is refused.
 * Changes that lower access still work.
 */
export function refuseRaiseWhilePaused(before: State, after: State): void {
  if (!before.paused || !after.paused) return;
  const [raise] = accessRaises(before, after);
  if (raise) throw new RuleError(`While paused, access only goes down: ${raise.message}.`);
}

/**
 * K-1507: the newest revision whose part for the item still has something to undo, and the plan for that
 * part. `revisions` come newest first, without undos and without undone revisions. A revision whose part is
 * back as before already is skipped, so each per-item undo goes one step further back.
 */
export function itemUndo(
  state: State,
  revisions: Iterable<{ readonly id: number; readonly changes: ReadonlyArray<Change> }>,
  item: Item,
  since: (revision: number) => Since = () => NOTHING_SINCE,
): { readonly revision: number; readonly plan: UndoPlan } | null {
  for (const revision of revisions) {
    const parts = itemParts(revision.changes, item);
    if (parts.length === 0) continue;
    const plan = undoPlan(state, parts, () => since(revision.id));
    if (plan.changes.length > 0 || plan.kept.length > 0) return { revision: revision.id, plan };
  }
  return null;
}
