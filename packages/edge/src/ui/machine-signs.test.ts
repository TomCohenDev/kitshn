import { describe, expect, it } from "vitest";
import type { MachineView } from "../core/protocol.ts";
import { seed } from "../core/seed.ts";
import type { State } from "../core/model.ts";
import { connectChecklist, machineProblems } from "./machine-signs.ts";

const view = (over: Partial<MachineView>): MachineView =>
  ({
    machine: { id: "mac", name: "Mac" },
    online: true,
    status: { tunnel: "running" },
    keyFailure: null,
    ...over,
  }) as MachineView;

describe("machineProblems (K-515)", () => {
  it("shows nothing for a healthy machine or an offline one", () => {
    expect(machineProblems(view({}), [])).toEqual([]);
    const lost = { offlineProviders: [{ provider: "t3", reason: "the connection closed", at: 1 }] };
    expect(machineProblems(view({ online: false, status: lost as never }), [])).toEqual([]);
  });

  it("names a provider that lost its connection, and puts a refusal first", () => {
    const status = {
      tunnel: "running",
      offlineProviders: [{ provider: "t3", reason: "the connection closed", at: 1 }],
      refusedProviders: [{ provider: "riffle", reason: "no", at: 1 }],
    };
    expect(machineProblems(view({ status: status as never }), []).map((sign) => sign.short)).toEqual([
      "kitshn refused Riffle",
      "T3 lost kitshn",
    ]);
  });
});

describe("connectChecklist (K-633)", () => {
  const s = seed(["owner@example.com"], "kit.example.com");
  const state = (over: Partial<State>): State =>
    ({
      circles: new Map(s.circles.map((circle) => [circle.id, circle])),
      resources: new Map(),
      places: new Map(),
      shareSettings: new Map(),
      ends: new Map(),
      stacks: new Map(),
      paused: null,
      machines: new Map(),
      ...over,
    }) as State;
  const done = (rows: ReturnType<typeof connectChecklist>) =>
    rows.filter((row) => row.done).map((row) => row.label);

  it("starts with nothing done for a machine that never connected", () => {
    expect(done(connectChecklist(view({ lastSeen: null }), state({}), {}))).toEqual([]);
  });

  it("keeps every tick while the machine is offline, so an old machine never falls back into the list", () => {
    const t3 = {
      id: "t3-mac",
      kind: "t3.app",
      name: "T3 on Mac",
      addresses: ["t3-mac.example.com"],
      status: "offline",
      group: null,
      machine: "mac",
      provider: { name: "t3" },
    };
    const circle = { ...s.circles[0]!, members: [{ _tag: "machine" as const, machineId: "mac" }] };
    const rows = connectChecklist(
      view({ online: false, lastSeen: 5 }),
      state({
        circles: new Map([[circle.id, circle]]),
        resources: new Map([["t3-mac", t3 as never]]),
      }),
      { "t3-mac": { state: "applied" } },
    );
    expect(rows.every((row) => row.done)).toBe(true);
  });
});
