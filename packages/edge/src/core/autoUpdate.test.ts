import { describe, expect, it } from "vitest";
import {
  type AutoUpdateMachine,
  type LiveStatus,
  NO_ROLLOUT,
  type Rollout,
  advanceRollout,
  daemonUpdate,
  nextAutoUpdate,
  startStep,
  stepSent,
} from "./autoUpdate.ts";

const NEW = "aaaaaaaaaaaa";
const NEWER = "cccccccccccc";
const OLD = "bbbbbbbbbbbb";
const online = (version: string, connectedAt = 0): LiveStatus => ({
  version,
  capabilities: ["update"],
  connectedAt,
});
const behind = (id: string, order: number, more: Partial<AutoUpdateMachine> = {}): AutoUpdateMachine => ({
  id,
  order,
  autoUpdate: true,
  hasKey: true,
  status: online(OLD),
  ...more,
});
/** A rollout of NEW whose step on "a" went out at time 10. */
const sent: Rollout = stepSent(startStep(NO_ROLLOUT, NEW, "a", 1), NEW, 10);

describe("next automatic update (K-627)", () => {
  it("picks the first BEHIND machine in the owner's order, and only one", () => {
    expect(nextAutoUpdate(NEW, false, NO_ROLLOUT, [behind("b", 2), behind("a", 1)])).toBe("a");
  });
  it("skips a machine whose setting is off (K-626)", () => {
    expect(nextAutoUpdate(NEW, false, NO_ROLLOUT, [behind("a", 1, { autoUpdate: false })])).toBeNull();
  });
  it("waits while kitshn is paused (K-1618)", () => {
    expect(nextAutoUpdate(NEW, true, NO_ROLLOUT, [behind("a", 1)])).toBeNull();
  });
  it("lets the second machine wait while a step runs, also one of an older release after a deploy", () => {
    expect(nextAutoUpdate(NEW, false, sent, [behind("b", 2)])).toBeNull();
    expect(nextAutoUpdate(NEWER, false, sent, [behind("b", 2)])).toBeNull();
  });
  it("stops the others after the release failed on one machine, but not the next release", () => {
    const failed: Rollout = {
      ...NO_ROLLOUT,
      version: NEW,
      failed: { machineId: "a", reason: "start check" },
    };
    expect(nextAutoUpdate(NEW, false, failed, [behind("b", 2)])).toBeNull();
    expect(nextAutoUpdate(NEWER, false, failed, [behind("b", 2)])).toBe("b");
  });
  it("skips offline, unkeyed, source and NEWEST daemons, and a local Worker build", () => {
    expect(
      nextAutoUpdate(NEW, false, NO_ROLLOUT, [
        behind("off", 1, { status: null }),
        behind("nokey", 1, { hasKey: false }),
        behind("dev", 1, { status: online("dev") }),
        behind("new", 1, { status: online(NEW) }),
        behind("old", 1, { status: { version: OLD, connectedAt: 0 } }),
      ]),
    ).toBeNull();
    expect(nextAutoUpdate("local", false, NO_ROLLOUT, [behind("a", 1)])).toBeNull();
  });
});

describe("a step of the rollout (K-627)", () => {
  type State = "queued" | "sent" | "done" | "failed" | "closed" | "gone";
  const job = (state: State, output = "") => ({ state, output });
  it("holds the rest while the machine stays offline, also after a done job", () => {
    expect(advanceRollout(sent, job("done"), () => null)).toEqual(sent);
    expect(advanceRollout(sent, job("closed"), () => null)).toEqual(sent);
  });
  it("ends when the machine is online on the release, and the card says updated", () => {
    const next = advanceRollout(sent, job("done"), () => online(NEW, 20));
    expect(next).toEqual({ ...sent, step: null, updated: ["a"] });
    expect(daemonUpdate(next, "a", NEW)).toEqual({ state: "updated" });
  });
  it("waits while the connection that ran the job still reports the old release", () => {
    expect(advanceRollout(sent, job("done"), () => online(OLD, 5))).toEqual(sent);
  });
  it("fails when a later connection comes back on another release, or with the last line of a failed job", () => {
    expect(advanceRollout(sent, job("done"), () => online(OLD, 20)).failed).toEqual({
      machineId: "a",
      reason: `The daemon came back on edge-${OLD}.`,
    });
    const failed = advanceRollout(
      sent,
      job("failed", "download\nThe new daemon failed its start check.\n"),
      () => null,
    );
    expect(daemonUpdate(failed, "a", NEW)).toEqual({
      state: "failed",
      reason: "The new daemon failed its start check.",
    });
  });
  it("drops an expired step without a failure, and ends a failure when a retry runs the release", () => {
    expect(advanceRollout(sent, job("gone"), () => null)).toEqual({ ...sent, step: null });
    const failed: Rollout = { ...NO_ROLLOUT, version: NEW, failed: { machineId: "a", reason: "x" } };
    expect(advanceRollout(failed, null, () => online(NEW))).toEqual({
      ...failed,
      failed: null,
      updated: ["a"],
    });
  });
  it("follows the release that delivery names after a deploy", () => {
    const queued = startStep(NO_ROLLOUT, NEW, "a", 1);
    expect(stepSent(queued, NEWER, 10)).toMatchObject({
      version: NEWER,
      step: { machineId: "a", sentAt: 10 },
    });
  });
});
