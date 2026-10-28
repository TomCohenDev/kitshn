import { describe, expect, it } from "vitest";
import { applyChanges, invert, resolveEdits } from "./changes.ts";
import { type Circle, type Point, type Resource, type State, circlesHolding, insideCircle } from "./model.ts";
import { circleForCards, enclosingCircle } from "./place.ts";

/** K-529: "New circle for these" places one new circle around the selected cards and keeps every card's circles. */

const circle = (id: string, x: number, y: number, r: number): Circle => ({
  id,
  name: id,
  color: "#6C5CE7",
  level: "view",
  members: [],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y,
  r,
});
const card = (id: string): Resource => ({ id, kind: "file", name: id, addresses: [], status: "running", group: null, machine: null });

function world(circles: ReadonlyArray<Circle>, places: Record<string, Point>, stacks: Record<string, Array<string>> = {}): State {
  return {
    circles: new Map(circles.map((each) => [each.id, each])),
    resources: new Map(Object.keys(places).map((id) => [id, card(id)])),
    places: new Map(Object.entries(places)),
    shareSettings: new Map(),
    stacks: new Map(Object.entries(stacks).map(([id, members]) => [id, { id, name: id, members }])),
    paused: null,
    machines: new Map(),
  };
}

const template = { id: "new", name: "New circle", color: "#14B8A6", level: "view", members: [], match: "any", needsPasskey: false, endsAt: null } as const;

/** Applies the edits as the server does, and checks the rule of K-529 for every card of the map. */
function apply(state: State, selected: ReadonlyArray<string>) {
  const plan = circleForCards(state, selected, template);
  if ("refused" in plan) throw new Error(plan.refused);
  const changes = resolveEdits(state, plan.edits);
  const after = applyChanges(state, changes);
  const made = after.circles.get("new");
  if (!made) throw new Error("no new circle");
  for (const id of state.places.keys()) {
    const before = circlesHolding(state, id).map((each) => each.id).sort();
    const now = circlesHolding(after, id).map((each) => each.id).filter((each) => each !== "new").sort();
    expect(now, `${id} keeps its circles`).toEqual(before);
    expect(insideCircle(after.places.get(id) as Point, made), `${id} is inside the new circle only when selected`).toBe(selected.includes(id));
  }
  return { plan, changes, after, made };
}

describe("New circle for these (K-529)", () => {
  it("draws the smallest circle around the cards and moves nothing when no other card is inside", () => {
    const state = world([circle("her", 0, 0, 600)], { a: { x: -100, y: 0 }, b: { x: 100, y: 0 }, far: { x: 0, y: 500 } });
    const { plan, made } = apply(state, ["a", "b"]);
    expect(plan.moved).toBe(0);
    expect(made).toMatchObject({ x: 0, y: 0, members: [] });
  });

  it("moves an unselected card out to its nearest spot in its own circles", () => {
    const state = world([circle("her", 0, 0, 800)], { a: { x: -200, y: 0 }, b: { x: 200, y: 0 }, middle: { x: 0, y: 0 } });
    const { plan, after } = apply(state, ["a", "b"]);
    expect(plan.moved).toBe(1);
    expect(after.places.get("a")).toEqual({ x: -200, y: 0 });
  });

  it("pulls spread cards together when that moves fewer cards than pushing others out", () => {
    const others = Object.fromEntries([-300, -150, 0, 150, 300].map((x) => [`o${x}`, { x, y: 40 }]));
    const state = world([circle("her", 0, 0, 1000)], { a: { x: -700, y: 0 }, b: { x: 700, y: 0 }, ...others });
    const { plan, after } = apply(state, ["a", "b"]);
    expect(plan.moved).toBeLessThan(5);
    expect(after.places.get("o0")).toBeDefined();
  });

  it("keeps a card in no circle in no other circle, and an unselected one out of the new circle", () => {
    const state = world([circle("her", 0, 0, 300)], { a: { x: 600, y: 0 }, b: { x: 800, y: 0 }, loose: { x: 700, y: 0 }, inside: { x: 0, y: 0 } });
    apply(state, ["a", "b"]);
    apply(state, ["a", "inside"]);
  });

  it("takes the whole stack when one of its cards is selected", () => {
    const state = world([circle("her", 0, 0, 600)], { a: { x: -100, y: 0 }, s1: { x: 100, y: 0 }, s2: { x: 100, y: 0 } }, { st: ["s1", "s2"] });
    const plan = circleForCards(state, ["a", "s1"], template);
    if ("refused" in plan) throw new Error(plan.refused);
    const after = applyChanges(state, resolveEdits(state, plan.edits));
    expect(insideCircle(after.places.get("s2") as Point, after.circles.get("new") as Circle)).toBe(true);
  });

  it("refuses, and changes nothing, when an unselected card cannot leave without changing its circles", () => {
    const state = world([circle("small", 0, 0, 150)], { a: { x: -60, y: 0 }, b: { x: 60, y: 0 }, trapped: { x: 0, y: 60 } });
    const plan = circleForCards(state, ["a", "b"], template);
    expect(plan).toEqual({ refused: expect.stringContaining("trapped cannot leave the new circle") });
  });

  it("refuses a circle wider than 3 times the widest circle", () => {
    // Each card sits in its own small circle, far apart, so no plan can bring them close.
    const state = world([circle("left", -2000, 0, 100), circle("right", 2000, 0, 100)], { a: { x: -2000, y: 0 }, b: { x: 2000, y: 0 } });
    expect(circleForCards(state, ["a", "b"], template)).toEqual({ refused: expect.stringContaining("wider than 3 times") });
  });

  it("is undone as one change: every moved card goes back and the circle goes", () => {
    const state = world([circle("her", 0, 0, 800)], { a: { x: -200, y: 0 }, b: { x: 200, y: 0 }, middle: { x: 0, y: 0 } });
    const { changes, after } = apply(state, ["a", "b"]);
    const undone = applyChanges(after, invert(changes));
    expect(undone.circles.has("new")).toBe(false);
    expect([...undone.places]).toEqual([...state.places]);
  });

  it("finds the smallest enclosing circle", () => {
    expect(enclosingCircle([{ x: 0, y: 0 }])).toEqual({ x: 0, y: 0, r: 0 });
    expect(enclosingCircle([{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0.5 }])).toMatchObject({ x: 0, y: 0, r: 1 });
    const triangle = enclosingCircle([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }]);
    expect(triangle.r).toBeCloseTo(2.5);
  });
});
