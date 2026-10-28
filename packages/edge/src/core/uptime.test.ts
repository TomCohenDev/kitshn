import { describe, expect, it } from "vitest";
import { UP, cardsOfRun, nextUptime, probeUp, stored } from "./uptime.ts";

describe("uptime (K-1125, K-1126)", () => {
  it("counts a server error or no answer as a failure, and an Access login as up", () => {
    expect([200, 302, 404, 499].map(probeUp)).toEqual([true, true, true, true]);
    expect([500, 502, 530, null].map(probeUp)).toEqual([false, false, false, false]);
  });

  it("makes a fetched card down when it still fails a turn after its first failure, and up after one success", () => {
    const turn = 120_000;
    const once = nextUptime(UP, false, 1_000, turn);
    expect(once).toEqual({ up: true, failingSince: 1_000, since: 0 });
    // A second run soon after, for example right after a wake, does not make the card down.
    expect(nextUptime(once, false, 5_000, turn)).toBe(once);
    expect(nextUptime(once, true, 5_000, turn)).toEqual(UP);
    const down = nextUptime(once, false, 1_000 + turn, turn);
    expect(down).toEqual({ up: false, failingSince: null, since: 1_000 + turn });
    expect(nextUptime(down, true, 200_000, turn)).toEqual({ up: true, failingSince: null, since: 200_000 });
  });

  it("makes a daemon site down at once", () => {
    expect(nextUptime(UP, false, 10, 0)).toEqual({ up: false, failingSince: null, since: 10 });
  });

  it("returns the same state when nothing changes, and keeps a row only for a card that is down or failing", () => {
    const down = { up: false, failingSince: null, since: 5 };
    expect(nextUptime(UP, true, 10, 120_000)).toBe(UP);
    expect(nextUptime(down, false, 10, 120_000)).toBe(down);
    expect(stored(UP)).toBe(false);
    expect(stored({ ...UP, since: 30 })).toBe(false);
    expect(stored({ ...UP, failingSince: 1 })).toBe(true);
    expect(stored(down)).toBe(true);
  });

  it("gives each card a turn, with all its addresses in the same run", () => {
    const card = (id: string, count: number) => ({
      id,
      addresses: Array.from({ length: count }, (_, i) => `${id}${i}`),
    });
    const cards = [card("a", 5), card("b", 4), card("c", 3), card("d", 1)];
    const runs = [0, 1, 2].map((slot) => cardsOfRun(cards, slot, 8).map((each) => each.id));
    expect(runs).toEqual([["a"], ["b", "c", "d"], ["a"]]);
    for (const run of runs)
      expect(
        run.reduce((total, id) => total + (cards.find((each) => each.id === id)?.addresses.length ?? 0), 0),
      ).toBeLessThanOrEqual(8);
  });
});
