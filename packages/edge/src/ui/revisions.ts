import { type Actor, type RevisionKind, deepEqual } from "../core/changes.ts";
import type { RevisionView } from "../core/protocol.ts";

/** K-1508: History as plain sentences, grouped by day and by actor, with filters. Pure, for tests. */

export const actorLabel = (actor: Actor) =>
  actor._tag === "person" ? actor.email : actor._tag === "device" ? `📱 ${actor.name}` : `kitshn (${actor.reason})`;

/** One filter value per actor; every kitshn reason (an expiry, a deploy) is the same actor "kitshn". */
export const actorKey = (actor: Actor) =>
  actor._tag === "person" ? `person:${actor.email}` : actor._tag === "device" ? `device:${actor.clientId}` : "kitshn";

const who = (actor: Actor, me: Actor) => (deepEqual(actor, me) ? "You" : actorLabel(actor));

/** The first words of summaries that are a verb, so the sentence reads "<who> <verb> …". */
const VERBS = new Set([
  "Added",
  "Changed",
  "Closed",
  "Created",
  "Deleted",
  "Deployed",
  "Forgot",
  "Gave",
  "Made",
  "Moved",
  "Paused",
  "Ran",
  "Redeployed",
  "Removed",
  "Renamed",
  "Restored",
  "Resumed",
  "Set",
  "Stacked",
  "Started",
  "Took",
  "Unstacked",
]);

/** "tick3d: + Everyone · view" (describeDiff) as "shared tick3d with Everyone at view", else null. */
function shareSentence(part: string): string | null {
  const added = part.lastIndexOf(": + ");
  if (added > 0) {
    const rest = part.slice(added + 4);
    const dot = rest.lastIndexOf(" · ");
    if (dot <= 0) return null;
    return `shared ${part.slice(0, added)} with ${rest.slice(0, dot)} at ${rest.slice(dot + 3)}`;
  }
  const removed = part.lastIndexOf(": − ");
  return removed > 0 ? `removed ${part.slice(0, removed)} from ${part.slice(removed + 4)}` : null;
}

const listed = (parts: ReadonlyArray<string>) =>
  parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** The verb phrase of a summary, or null when the summary has no shape that this knows. */
function phrase(summary: string): string | null {
  if (summary.startsWith("Undo #")) {
    const colon = summary.indexOf(": ");
    const rest = colon > 0 ? phrase(summary.slice(colon + 2)) : null;
    // "Undo #12" or "Undo #12 for tick3d"; the rest says what the undo changed.
    const head = `undid #${summary.slice("Undo #".length, colon > 0 ? colon : undefined)}`;
    return rest === null ? null : `${head}: ${rest}`;
  }
  const parts = summary.split("; ");
  // summarize() ends a long list with "and 3 more".
  const last = parts.at(-1) ?? "";
  const more = parts.length > 1 && last.startsWith("and ") && last.endsWith(" more") ? last : null;
  const shares = (more === null ? parts : parts.slice(0, -1)).map(shareSentence);
  if (shares.every((part) => part !== null))
    return more === null ? listed(shares) : `${shares.join(", ")} ${more}`;
  const first = summary.split(" ", 1)[0] ?? "";
  return VERBS.has(first) ? summary.charAt(0).toLowerCase() + summary.slice(1) : null;
}

/**
 * A plain sentence for a revision, from its summary alone, so it adds no fact: "You shared tick3d with Everyone
 * at view". A summary of a shape that this does not know stays as it is after the actor.
 */
export function sentence(revision: Pick<RevisionView, "actor" | "summary">, me: Actor): string {
  const said = phrase(revision.summary);
  return said === null ? `${who(revision.actor, me)}: ${revision.summary}` : `${who(revision.actor, me)} ${said}`;
}

export type Day = "Today" | "Yesterday" | "Older";

export interface HistoryGroup {
  readonly day: Day;
  readonly actor: Actor;
  readonly revisions: ReadonlyArray<RevisionView>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayOf(at: number, now: number): Day {
  const today = new Date(now).setHours(0, 0, 0, 0);
  return at >= today ? "Today" : at >= today - DAY_MS ? "Yesterday" : "Older";
}

/** Newest first: the revisions of one day and one actor in a row make one group. */
export function groupHistory(revisions: ReadonlyArray<RevisionView>, now: number): Array<HistoryGroup> {
  const groups: Array<{ day: Day; actor: Actor; revisions: Array<RevisionView> }> = [];
  for (const revision of revisions) {
    const day = dayOf(revision.at, now);
    const last = groups.at(-1);
    if (last && last.day === day && actorKey(last.actor) === actorKey(revision.actor)) last.revisions.push(revision);
    else groups.push({ day, actor: revision.actor, revisions: [revision] });
  }
  return groups;
}

export interface HistoryFilter {
  readonly kind: RevisionKind | null;
  /** An `actorKey`, or null for every actor. */
  readonly actor: string | null;
  /** Words that the sentence or the name of a changed card or circle has. */
  readonly item: string;
}

export function filterHistory(
  revisions: ReadonlyArray<RevisionView>,
  filter: HistoryFilter,
  nameOf: (item: RevisionView["items"][number]) => string,
): Array<RevisionView> {
  const words = filter.item.toLowerCase().split(" ").filter(Boolean);
  return revisions.filter((revision) => {
    if (filter.kind !== null && revision.kind !== filter.kind) return false;
    if (filter.actor !== null && actorKey(revision.actor) !== filter.actor) return false;
    if (words.length === 0) return true;
    const text = [revision.summary, ...revision.items.map(nameOf)].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export type UndoState = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * K-1506: Undo of each History row, from the list alone: only the caller's own newest revision that changes
 * something and is not undone. kitshn still checks later revisions when the undo runs, and its toast says why.
 */
export function undoStates(revisions: ReadonlyArray<RevisionView>, me: Actor): (revision: RevisionView) => UndoState {
  const newest = revisions.find(
    (revision) =>
      revision.undoable && revision.undoes === null && revision.undoneBy === null && deepEqual(revision.actor, me),
  )?.id;
  return (revision) =>
    revision.id === newest
      ? { allowed: true }
      : {
          allowed: false,
          reason: !revision.undoable
            ? "This records an action and changes nothing that Undo can reverse."
            : revision.undoneBy !== null
              ? `Undone already: #${revision.undoneBy} reverses it.`
              : revision.undoes !== null
              ? "This is an undo. Make the change again instead."
              : !deepEqual(revision.actor, me)
                ? "Only the one who made a change can undo it."
                : `Only your newest change can be undone${newest === undefined ? "" : `: #${newest}`}.`,
        };
}
