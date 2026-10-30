import { describe, expect, it } from "vitest";
import { applyChanges, resolveEdits } from "../core/changes.ts";
import { type Circle, type Resource, type State, circlesHolding } from "../core/model.ts";
import { seed } from "../core/seed.ts";
import { dropPlan } from "./drop.ts";

/** K-509, K-522: a card from the tray drops as a card from the map does. */

const card = (id: string, kind: Resource["kind"]): Resource => ({
  id,
  kind,
  name: id,
  addresses: [],
  status: "running",
  group: null,
  machine: null,
});

const her: Circle = {
  id: "her",
  name: "Her",
  color: "#FF5277",
  level: "use",
  members: [{ _tag: "email", email: "her@example.com" }],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: -400,
  y: 0,
  r: 200,
};

function state(): State {
  const s = seed(["owner@example.com"], "kit.example.com");
  const resources = [
    ...s.resources,
    card("riffle", "site.static"),
    card("map", "file"),
    card("tray", "file"),
  ];
  return {
    circles: new Map([...s.circles, her].map((circle) => [circle.id, circle])),
    resources: new Map(resources.map((resource) => [resource.id, resource])),
    // "map" lies outside every circle; "tray" has no place.
    places: new Map([...s.places, ["riffle", { x: -400, y: 50 }], ["map", { x: 2000, y: 2000 }]]),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
  };
}

/** The state after a plan, so map and tray drops compare by their outcome, not by their edits. */
const after = (base: State, plan: ReturnType<typeof dropPlan>) => {
  if (!plan || "refused" in plan) throw new Error(`no edits: ${JSON.stringify(plan)}`);
  return applyChanges(base, resolveEdits(base, plan.edits));
};

describe("dropPlan", () => {
  const point = { x: -420, y: -30 };

  it.each(["map", "tray"])("stacks a %s card onto the card under the pointer", (id) => {
    const base = state();
    const next = after(base, dropPlan(base, new Map([[id, point]]), { _tag: "card", id: "riffle" }, "s-new"));
    expect(next.stacks.get("s-new")?.members).toEqual(["riffle", id]);
    expect(next.places.get(id)).toEqual(base.places.get("riffle"));
    expect(circlesHolding(next, id).map((circle) => circle.id)).toEqual(["her"]);
  });

  it.each(["map", "tray"])("puts a %s card at its point, in exactly the circles there", (id) => {
    const base = state();
    const next = after(base, dropPlan(base, new Map([[id, point]]), { _tag: "map" }, "s-new"));
    expect(next.places.get(id)).toEqual(point);
    expect(circlesHolding(next, id).map((circle) => circle.id)).toEqual(["her"]);
  });

  it("takes a map card out of every circle over the tray, and leaves a tray card as it is", () => {
    const base = state();
    const back = dropPlan(base, new Map([["riffle", point]]), { _tag: "tray" }, "s-new");
    expect(after(base, back).places.has("riffle")).toBe(false);
    expect(dropPlan(base, new Map([["tray", point]]), { _tag: "tray" }, "s-new")).toBeNull();
  });

  it.each(["map", "tray"])("changes nothing for a %s card let go over the panel or the toolbar", (id) => {
    expect(dropPlan(state(), new Map([[id, point]]), { _tag: "away" }, "s-new")).toBeNull();
  });
});
