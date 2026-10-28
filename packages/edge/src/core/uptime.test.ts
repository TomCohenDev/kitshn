import { describe, expect, it } from "vitest";
import { addressesOfRun, nextUptime, probeUp } from "./uptime.ts";

describe("uptime (K-1125, K-1126)", () => {
  it("counts a server error or no answer as a failure, and an Access login as up", () => {
    expect([200, 302, 404, 499].map(probeUp)).toEqual([true, true, true, true]);
    expect([500, 502, 530, null].map(probeUp)).toEqual([false, false, false, false]);
  });

  it("makes a fetched card down after two failures in a row, and up after one success", () => {
    const up = { up: true, fails: 0, since: 0 };
    const once = nextUptime(up, false, 10, 2);
    expect(once).toEqual({ up: true, fails: 1, since: 0 });
    expect(nextUptime(once, true, 20, 2)).toEqual(up);
    const down = nextUptime(once, false, 20, 2);
    expect(down).toEqual({ up: false, fails: 0, since: 20 });
    expect(nextUptime(down, true, 30, 2)).toEqual({ up: true, fails: 0, since: 30 });
  });

  it("makes a daemon site down at once", () => {
    expect(nextUptime({ up: true, fails: 0, since: 0 }, false, 10, 1)).toEqual({
      up: false,
      fails: 0,
      since: 10,
    });
  });

  it("returns the same state when nothing changes, so no row is written", () => {
    const up = { up: true, fails: 0, since: 0 };
    const down = { up: false, fails: 0, since: 5 };
    expect(nextUptime(up, true, 10, 2)).toBe(up);
    expect(nextUptime(down, false, 10, 2)).toBe(down);
  });

  it("gives each address a turn across runs", () => {
    const all = Array.from({ length: 20 }, (_, index) => index);
    const seen = [0, 1, 2].flatMap((slot) => addressesOfRun(all, slot, 8));
    expect(new Set(seen)).toEqual(new Set(all));
    expect(addressesOfRun(all, 0, 8)).toHaveLength(8);
  });
});
