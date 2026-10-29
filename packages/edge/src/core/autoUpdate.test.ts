import { describe, expect, it } from "vitest";
import { type AutoUpdateMachine, daemonUpdate, nextAutoUpdate } from "./autoUpdate.ts";

const NEW = "aaaaaaaaaaaa";
const OLD = "bbbbbbbbbbbb";
const behind = (id: string, order: number, more: Partial<AutoUpdateMachine> = {}): AutoUpdateMachine => ({
  id,
  order,
  autoUpdate: true,
  hasKey: true,
  status: { version: OLD, capabilities: ["update"] },
  update: null,
  ...more,
});

describe("next automatic update (K-627)", () => {
  it("picks the first BEHIND machine in the owner's order, and only one", () => {
    expect(nextAutoUpdate(NEW, false, [behind("b", 2), behind("a", 1)])).toBe("a");
  });
  it("skips a machine whose setting is off (K-626)", () => {
    expect(nextAutoUpdate(NEW, false, [behind("a", 1, { autoUpdate: false })])).toBeNull();
  });
  it("waits while kitshn is paused (K-1618)", () => {
    expect(nextAutoUpdate(NEW, true, [behind("a", 1)])).toBeNull();
  });
  it("lets the second machine wait until the first runs the release", () => {
    const first = (update: AutoUpdateMachine["update"]) => behind("a", 1, { update });
    expect(nextAutoUpdate(NEW, false, [first({ state: "updating" }), behind("b", 2)])).toBeNull();
    expect(nextAutoUpdate(NEW, false, [first({ state: "updated" }), behind("b", 2)])).toBe("b");
  });
  it("stops the others after the release failed on one machine", () => {
    const failed = behind("a", 1, { update: { state: "failed", reason: "start check" } });
    expect(nextAutoUpdate(NEW, false, [failed, behind("b", 2)])).toBeNull();
  });
  it("skips offline, unkeyed, source and NEWEST daemons, and a local Worker build", () => {
    expect(
      nextAutoUpdate(NEW, false, [
        behind("off", 1, { status: null }),
        behind("nokey", 1, { hasKey: false }),
        behind("dev", 1, { status: { version: "dev", capabilities: ["update"] } }),
        behind("new", 1, { status: { version: NEW, capabilities: ["update"] } }),
        behind("old", 1, { status: { version: OLD } }),
      ]),
    ).toBeNull();
    expect(nextAutoUpdate("local", false, [behind("a", 1)])).toBeNull();
  });
});

describe("update state of a daemon (K-627)", () => {
  const online = (version: string) => ({ version, capabilities: ["update"] });
  it("is updating until the daemon reports again after its restart", () => {
    expect(daemonUpdate(NEW, { state: "queued", output: "" }, online(OLD))).toEqual({ state: "updating" });
    expect(daemonUpdate(NEW, { state: "closed", output: "" }, null)).toEqual({ state: "updating" });
  });
  it("stays updated when an updated machine goes offline later", () => {
    expect(daemonUpdate(NEW, { state: "done", output: "" }, null)).toEqual({ state: "updated" });
  });
  it("is updated when the daemon runs the release, also after a closed connection", () => {
    expect(daemonUpdate(NEW, { state: "closed", output: "" }, online(NEW))).toEqual({ state: "updated" });
  });
  it("failed when the daemon came back on another release, or with the last line of a failed job", () => {
    expect(daemonUpdate(NEW, { state: "done", output: "" }, online(OLD))).toEqual({
      state: "failed",
      reason: `The daemon came back on edge-${OLD}.`,
    });
    expect(
      daemonUpdate(
        NEW,
        { state: "failed", output: "downloading\nThe new daemon failed its start check.\n" },
        null,
      ),
    ).toEqual({ state: "failed", reason: "The new daemon failed its start check." });
  });
});
