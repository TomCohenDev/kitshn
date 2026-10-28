/** K-1125, K-1126: uptime of app and live site cards. */

export interface Uptime {
  readonly up: boolean;
  /** When an up card first failed in a row of failures, or null; a daemon site never has one. */
  readonly failingSince: number | null;
  /** When `up` last changed; 0 for a card that kitshn never saw down. */
  readonly since: number;
}

export interface UptimeChange {
  readonly at: number;
  readonly up: boolean;
}

/** A card with no row: up, with no failure. kitshn keeps rows only for cards that are down or failing (K-1126). */
export const UP: Uptime = { up: true, failingSince: null, since: 0 };

/** True when the state needs a row; a card that is up with no failure has none. */
export const stored = (uptime: Uptime) => !uptime.up || uptime.failingSince !== null;

/**
 * K-1125: a fetched card goes down when it still fails at least one turn after its first failure. kitshn counts by
 * time, not by alarm runs, so two runs close together after a wake never make a card down.
 */
export const FAILING_FOR_MS = 2 * 60_000;
/** K-1126: fetches per alarm run, inside the 50 subrequests of one run (K-406). */
export const UPTIME_FETCHES_PER_RUN = 8;
/** K-1126: the length of one turn; an alarm in the same turn fetches nothing. */
export const UPTIME_RUN_MS = 2 * 60_000;
/** K-1126: while no daemon keeps the 2-minute alarm going, uptime wakes the Durable Object at most this often. */
export const UPTIME_IDLE_MS = 10 * 60_000;
/** K-1126: changes stay this long. */
export const UPTIME_KEEP_MS = 30 * 24 * 60 * 60_000;

/** K-1125: a status of 500 or higher, or no answer (null), is a failure. Access answers a login, so 3xx counts as up. */
export const probeUp = (status: number | null) => status !== null && status < 500;

/**
 * The next state of a card after one probe. `failingFor` is 0 for a daemon site, whose daemon already checks every
 * 10 seconds (K-1107). It returns the same object when nothing changes, so the caller writes no row.
 */
export function nextUptime(before: Uptime, probe: boolean, now: number, failingFor: number): Uptime {
  if (probe)
    return before.up && before.failingSince === null
      ? before
      : { up: true, failingSince: null, since: before.up ? before.since : now };
  if (!before.up) return before;
  const first = before.failingSince ?? now;
  if (now - first >= failingFor) return { up: false, failingSince: null, since: now };
  return before.failingSince === null ? { ...before, failingSince: now } : before;
}

/**
 * K-1126: the cards whose addresses this run fetches. The cards go into groups of at most `perRun` addresses, in
 * order, and run `slot` takes the next group, so each card gets a turn with no stored state and all its addresses
 * in the same run (K-817 allows at most 5, which fit in one group). Known limit: a run that comes late can skip a
 * group for one cycle. Revisit when checks must be exact.
 */
export function cardsOfRun<T extends { readonly addresses: ReadonlyArray<string> }>(
  cards: ReadonlyArray<T>,
  slot: number,
  perRun: number,
): Array<T> {
  const groups: Array<Array<T>> = [];
  let size = perRun;
  for (const card of cards) {
    if (card.addresses.length > perRun)
      throw new Error(
        `A card has ${card.addresses.length} addresses; one uptime run fetches at most ${perRun}.`,
      );
    if (size + card.addresses.length > perRun) {
      groups.push([]);
      size = 0;
    }
    groups.at(-1)?.push(card);
    size += card.addresses.length;
  }
  return groups.length === 0 ? [] : (groups[slot % groups.length] ?? []);
}
