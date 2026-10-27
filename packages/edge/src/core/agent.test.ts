import { describe, expect, it } from "vitest";

const as = (clientId: string) => ({ email: null, clientId, ip: null });
import { agentDeployPlan, agentMayRunOn, agentRefusal, cardsControlledBy, isAgentKey } from "./agent.ts";
import { type Edit, applyChanges, resolveEdits } from "./changes.ts";
import type { Circle, Resource, State } from "./model.ts";
import { seed } from "./seed.ts";


function start(): State {
  const s = seed(["owner@example.com"], "kit.example.com");
  const base = s.circles[0]!;
  const circle = (
    id: string,
    x: number,
    level: "view" | "control",
    members: Circle["members"] = [{ _tag: "device", tokenId: "t1", clientId: "agent-1", name: "Agent" }],
  ): Circle => ({
    ...base,
    id,
    name: id,
    level,
    needsPasskey: false,
    members,
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
      [
        ...s.circles,
        circle("agents", 0, "control"),
        circle("staging", 600, "control"),
        circle("watch", 1200, "view"),
        circle("public", 1800, "control", [
          { _tag: "everyone" },
          { _tag: "device", tokenId: "t1", clientId: "agent-1", name: "Agent" },
        ]),
        circle("home", 2400, "control", [{ _tag: "ip", range: "10.0.0.0/24" }]),
      ].map((c) => [c.id, c]),
    ),
    resources: new Map([...s.resources, site, { ...site, id: "nas", name: "nas" }].map((r) => [r.id, r])),
    places: new Map([...s.places, ["site", { x: 0, y: 1000 }], ["nas", { x: 2400, y: 1000 }]]),
    shareSettings: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
  };
}

const check = (state: State, edits: Array<Edit>) => {
  const changes = resolveEdits(state, edits);
  return agentRefusal(state, applyChanges(state, changes), as("agent-1"), changes, 0);
};

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
  it("never makes a card public, nor moves it into a circle without control", () => {
    expect(check(start(), [{ _tag: "place", id: "site", after: { x: 1800, y: 1000 } }])).toMatch(/public/);
    expect(check(start(), [{ _tag: "place", id: "site", after: { x: 1200, y: 1000 } }])).toMatch(/watch/);
    expect(
      check(start(), [{ _tag: "shareSetting", resourceId: "site", circleId: "agents", after: { level: "view", endsAt: null } }]),
    ).toMatch(/only move/);
  });
  it("gets nothing from network or Everyone circles, and a token that no circle names manages nothing", () => {
    expect(cardsControlledBy(start(), as("agent-1"), 0).has("nas")).toBe(false);
    expect(cardsControlledBy(start(), as("stranger"), 0).size).toBe(0);
    expect(check(start(), [{ _tag: "place", id: "nas", after: { x: 0, y: 1000 } }])).toMatch(/no control/);
  });
  it("does not call the owner's device an agent during a pause", () => {
    const base = start();
    const owner = base.circles.get("owner")!;
    const device = { _tag: "device", tokenId: "t2", clientId: "owner-phone", name: "Phone" } as const;
    const circles = new Map(base.circles).set("owner", { ...owner, members: [...owner.members, device] });
    const state = { ...base, circles };
    expect(isAgentKey({ ...state, paused: "lockdown" as const }, device, 0)).toBe(false);
    expect(isAgentKey(state, { ...device, clientId: "agent-1" }, 0)).toBe(true);
  });
  it("counts only circles of devices that have not ended, and may take a card out of every circle", () => {
    const base = start();
    const agents = base.circles.get("agents")!;
    const mixed = { ...agents, members: [...agents.members, { _tag: "email", email: "her@example.com" } as const] };
    expect(cardsControlledBy({ ...base, circles: new Map(base.circles).set("agents", mixed) }, as("agent-1"), 0).size).toBe(0);
    const ended = { ...agents, endsAt: 1 };
    expect(cardsControlledBy({ ...base, circles: new Map(base.circles).set("agents", ended) }, as("agent-1"), 5).size).toBe(0);
    expect(check(base, [{ _tag: "place", id: "site", after: null }])).toBeNull();
  });
  it("runs jobs on a machine only when it manages every card on it", () => {
    const base = start();
    const machine = { ...base.resources.get("site")!, id: "m1", name: "m1", kind: "machine" as const };
    const app = { ...base.resources.get("site")!, id: "app", machine: "m1" };
    const resources = new Map(base.resources).set("m1", machine).set("app", app);
    const places = new Map(base.places).set("m1", { x: 0, y: 1000 }).set("app", { x: -5000, y: 0 });
    const m1 = { id: "m1", name: "m1", labels: [], order: 0, serviceTokenId: "s", clientId: "m1-token", tunnelId: "t" };
    const state = { ...base, resources, places, machines: new Map([["m1", m1]]) };
    expect(agentMayRunOn(state, as("agent-1"), "m1", 0)).toBe(false);
    const inside = { ...state, places: new Map(places).set("app", { x: 0, y: 1000 }) };
    expect(agentMayRunOn(inside, as("agent-1"), "m1", 0)).toBe(true);
    // The machine's own token opens the NAS through the "home" circle, which the agent does not manage.
    const home = inside.circles.get("home")!;
    const circles = new Map(inside.circles).set("home", { ...home, members: [{ _tag: "machine", machineId: "m1" }] });
    expect(agentMayRunOn({ ...inside, circles }, as("agent-1"), "m1", 0)).toBe(false);
  });
  it("calls a device an agent only when it has an agent circle", () => {
    expect(isAgentKey(start(), { _tag: "device", tokenId: "t9", clientId: "tv", name: "TV" }, 0)).toBe(false);
  });
  it("refuses a move that takes along a stacked card the key does not manage", () => {
    const base = start();
    const other = { ...base.resources.get("site")!, id: "other", name: "other" };
    const state: State = {
      ...base,
      resources: new Map(base.resources).set("other", other),
      places: new Map(base.places).set("other", { x: 0, y: 1000 }),
      shareSettings: new Map([["other/agents", { level: "view", endsAt: null }]]),
      stacks: new Map([["s1", { id: "s1", name: "pair", members: ["site", "other"] }]]),
    };
    expect(check(state, [{ _tag: "place", id: "site", after: { x: 600, y: 1000 } }])).toMatch(/other/);
  });
  it("deploys only the repo's code: the last good build, or the repo's workflow on its branch", () => {
    const last = {
      app: "compose" as const,
      repo: "o/app",
      branch: "main",
      resourceId: "app-o-1-prod",
      environment: "prod",
      name: "app",
      composeFile: null,
    };
    const ready = { canRedeploy: true, takesDeploys: true, runsCard: true, allowed: [] };
    expect(agentDeployPlan(last, "redeploy", ready)).toMatchObject({
      kind: "redeploy",
      command: { kind: "compose-redeploy", project: "app-o-1-prod", name: "app" },
    });
    expect(agentDeployPlan(last, "build", null)).toEqual({ kind: "build", repo: "o/app", branch: "main" });
    expect(agentDeployPlan(last, "redeploy", { ...ready, canRedeploy: false })).toMatchObject({ error: /Update the daemon/ });
    expect(agentDeployPlan(last, "redeploy", { ...ready, takesDeploys: false })).toMatchObject({ error: /label deploy/ });
    expect(agentDeployPlan(last, "redeploy", { ...ready, runsCard: false })).toMatchObject({ error: /no longer runs/ });
    expect(agentDeployPlan(last, "redeploy", null)).toMatchObject({ kind: "refused" });
    expect(agentDeployPlan({ ...last, app: "static" }, "redeploy", ready)).toMatchObject({ kind: "refused" });
    expect(agentDeployPlan({ ...last, branch: "" }, "build", null)).toMatchObject({ kind: "refused" });
    expect(agentDeployPlan({ ...last, environment: "pr-7" }, "build", null)).toMatchObject({ error: /preview/ });
    expect(agentDeployPlan(null, "build", null)).toMatchObject({ kind: "refused", error: /no finished deploy/ });
  });
});
