/** K-1125, K-1126: uptime of app and live site cards. */

export interface Uptime {
  readonly up: boolean;
  /** Failures in a row of a fetched address; a daemon site never counts any. */
  readonly fails: number;
  /** When `up` last changed. */
  readonly since: number;
}

export interface UptimeChange {
  readonly at: number;
  readonly up: boolean;
}

/** K-1125: two failures in a row make a fetched card down. */
export const FAILS_TO_DOWN = 2;
/** K-1126: fetches per alarm run, inside the 50 subrequests of one run (K-406). */
export const UPTIME_FETCHES_PER_RUN = 8;
/** K-1126: the alarm runs at least this often while a card has an address to check. */
export const UPTIME_RUN_MS = 2 * 60_000;
/** K-1126: changes stay this long. */
export const UPTIME_KEEP_MS = 30 * 24 * 60 * 60_000;

/** K-1125: a status of 500 or higher, or no answer (null), is a failure. Access answers a login, so 3xx counts as up. */
export const probeUp = (status: number | null) => status !== null && status < 500;

/**
 * The next state of a card after one probe. `failsToDown` is 1 for a daemon site, whose daemon already checks every
 * 10 seconds (K-1107). It returns the same object when nothing changes, so the caller writes no row.
 */
export function nextUptime(
  previous: Uptime | undefined,
  probe: boolean,
  now: number,
  failsToDown: number,
): Uptime {
  const before = previous ?? { up: true, fails: 0, since: now };
  if (probe)
    return before.up && before.fails === 0 && previous
      ? before
      : { up: true, fails: 0, since: before.up ? before.since : now };
  if (!before.up) return before;
  const fails = before.fails + 1;
  return fails >= failsToDown ? { up: false, fails: 0, since: now } : { ...before, fails };
}

/**
 * K-1126: the addresses that this run fetches. Run `slot` (the time of the run divided by the run interval) takes
 * the next group of at most `perRun`, so each address gets a turn with no stored state. Known limit: a run that
 * comes early or late can skip or repeat a group. Revisit when checks must be exact.
 */
export function addressesOfRun<T>(addresses: ReadonlyArray<T>, slot: number, perRun: number): Array<T> {
  if (addresses.length <= perRun) return [...addresses];
  const groups = Math.ceil(addresses.length / perRun);
  const group = slot % groups;
  return addresses.slice(group * perRun, group * perRun + perRun);
}
