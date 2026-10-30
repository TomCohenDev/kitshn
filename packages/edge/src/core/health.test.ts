import type { HealthReport } from "@kitshn/local";
import { describe, expect, it } from "vitest";
import { HEALTH_STALE_MS, type HealthMachine, healthCell, healthNotices, healthProblems } from "./health.ts";

const report = (at: number, links: HealthReport["links"], providers: HealthReport["providers"] = []) => ({
  at,
  links,
  providers,
});
const link = (
  machineId: string,
  failures: number,
  error: string | null = failures > 0 ? "answered 530" : null,
) => ({
  provider: "t3",
  machineId,
  status: failures > 0 ? 530 : 200,
  ms: 5,
  failures,
  since: failures > 0 ? 50 : null,
  error,
});
const machine = (id: string, health: HealthReport | null, online = true): HealthMachine => ({
  machine: { id, name: id.toUpperCase() },
  online,
  health,
});

describe("the health grid (K-631)", () => {
  it("shows ok, red, no link, and unknown for an offline machine, no report, or an old one", () => {
    const now = 1_000_000;
    const a = machine(
      "a",
      report(now, [link("b", 0), link("c", 1)], [{ provider: "t3", failures: 0, since: null, error: null }]),
    );
    expect(healthCell(a, "b", now)).toEqual({ state: "ok", at: now, errors: [] });
    expect(healthCell(a, "c", now)).toEqual({ state: "bad", at: now, errors: ["link t3: answered 530"] });
    expect(healthCell(a, "d", now)).toEqual({ state: "none" });
    expect(healthCell(a, "a", now).state).toBe("ok");
    expect(healthCell({ ...a, online: false }, "b", now)).toEqual({ state: "unknown", at: now });
    expect(healthCell(machine("x", null), "b", now)).toEqual({ state: "unknown", at: null });
    expect(healthCell(a, "b", now + HEALTH_STALE_MS + 1).state).toBe("unknown");
  });

  it("gives a machine card the red cells of its row and its column", () => {
    const now = 10;
    const down = [{ provider: "t3", failures: 1, since: 5, error: "no connection holds the provider" }];
    const machines = [machine("a", report(now, [link("b", 1)], down)), machine("b", report(now, []))];
    expect(healthProblems(machines, "b", now)).toEqual(["A → B: link t3: answered 530"]);
    expect(healthProblems(machines, "a", now)).toEqual(["A → B: link t3: answered 530"]);
  });

  it("opens a notification only after two link failures in a row, none for an offline machine or a provider", () => {
    const a = { id: "a", name: "A" };
    const others = new Map([
      ["b", { name: "B", online: true }],
      ["c", { name: "C", online: false }],
    ]);
    const providers = [{ provider: "t3", failures: 2, since: 40, error: "no connection holds the provider" }];
    const notices = healthNotices(
      a,
      report(10, [link("b", 1), link("b", 2), link("c", 3)], providers),
      others,
    );
    expect(notices.map(({ key, episode }) => ({ key, episode }))).toEqual([
      { key: "a:link:t3:b", episode: "50" },
    ]);
    expect(healthNotices(a, report(10, [link("b", 0)]), others)).toEqual([]);
  });
});
