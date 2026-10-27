import { describe, expect, it } from "vitest";
import { agentRefusal } from "./agent.ts";
import { type Edit, applyChanges, resolveEdits } from "./changes.ts";
import type { Circle, Resource, State } from "./model.ts";
import { seed } from "./seed.ts";

const agent = { email: null, clientId: "agent-1", ip: null };

function start(): State {
  const s = seed(["owner@example.com"], "kit.example.com");
  const base = s.circles[0]!;
  const circle = (id: string, x: number, level: "view" | "control"): Circle => ({
    ...base,
    id,
    name: id,
    level,
    needsPasskey: false,
    members: [{ _tag: "device", tokenId: "t1", clientId: "agent-1", name: "Agent" }],
    x,
    y: 1000,
    r: 200,
  });
  const site: Resource = {
    id: "site",
    kind: "site.compose",
    name: "site",
    addresses: [],
    status: "running",
    group: null,
    machine: null,
  };
  return {
    circles: new Map(
      [...s.circles, circle("agents", 0, "control"), circle("staging", 600, "control")].map((c) => [c.id, c]),
    ),
    resources: new Map([...s.resources, site].map((r) => [r.id, r])),
    places: new Map([...s.places, ["site", { x: 0, y: 1000 }]]),
    shareSettings: new Map(),
    paused: false,
    machines: new Map(),
  };
}

const check = (state: State, edits: Array<Edit>) =>
  agentRefusal(state, applyChanges(state, resolveEdits(state, edits)), agent, edits, 0);

describe("agent keys (K-718)", () => {
  it("moves a card it controls between its own circles", () => {
    expect(check(start(), [{ _tag: "place", id: "site", after: { x: 600, y: 1000 } }])).toBeNull();
  });
  it("never moves a card into a circle it is not in, nor the admin, nor edits a circle", () => {
    expect(check(start(), [{ _tag: "place", id: "site", after: { x: 0, y: 40 } }])).toMatch(/Owner/);
    expect(check(start(), [{ _tag: "place", id: "kitshn-admin", after: { x: 0, y: 1000 } }])).toMatch(
      /no control/,
    );
    const owner = start().circles.get("owner")!;
    expect(check(start(), [{ _tag: "circle", id: "owner", after: { ...owner, name: "x" } }])).toMatch(
      /only move/,
    );
  });
});
