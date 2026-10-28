import { describe, expect, it } from "vitest";
import type { Circle } from "../core/model.ts";
import { type Box, cardBox, fitView, headAngle, headBox, mapBox, openArea, panInto } from "./layout.ts";

const circle = (x: number, y: number, r: number, name = "Agents"): Circle => ({
  id: name,
  name,
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

const inside = (box: Box, area: Box, view: { x: number; y: number; s: number }) =>
  box.left * view.s + view.x >= area.left - 0.001 &&
  box.right * view.s + view.x <= area.right + 0.001 &&
  box.top * view.s + view.y >= area.top - 0.001 &&
  box.bottom * view.s + view.y <= area.bottom + 0.001;

describe("fit and pan leave an open panel free", () => {
  const screen = { width: 1440, height: 900, top: 70, left: 0, narrow: false };

  it("fits every circle head and card left of the panel", () => {
    const circles = [circle(0, 0, 200), circle(900, 0, 200, "Her")];
    const box = mapBox(circles, [{ x: 1100, y: 100 }]);
    if (!box) throw new Error("A map with circles has a box.");
    const area = openArea({ ...screen, panelLeft: 960 });
    const view = fitView(box, area, 0.15, 2);
    expect(area.right).toBeLessThan(960);
    for (const item of circles) expect(inside(headBox(item, 0), area, view)).toBe(true);
    expect(inside(cardBox({ x: 1100, y: 100 }), area, view)).toBe(true);
  });

  it("keeps the minimum zoom, so a big map is centred in the area instead of shown whole", () => {
    const box = mapBox([circle(0, 0, 3000)], []);
    if (!box) throw new Error("A map with circles has a box.");
    const area = openArea({ ...screen, panelLeft: 960 });
    const view = fitView(box, area, 0.85, 2);
    expect(view.s).toBe(0.85);
    expect(((box.left + box.right) / 2) * view.s + view.x).toBeCloseTo((area.left + area.right) / 2);
  });

  it("uses the upper half on a narrow screen, where the panel is a bottom sheet", () => {
    const area = openArea({ ...screen, width: 400, height: 800, narrow: true, panelLeft: 12 });
    expect(area.right).toBe(380);
    expect(area.bottom).toBe(380);
  });

  it("does not move a box that is in the area already, and centres one that is under the panel", () => {
    const area = openArea({ ...screen, panelLeft: 960 });
    const view = { x: 0, y: 0, s: 1 };
    const free = cardBox({ x: 400, y: 400 });
    expect(panInto(free, area, view)).toBe(view);
    const under = cardBox({ x: 1200, y: 400 });
    const moved = panInto(under, area, view);
    expect(moved.s).toBe(1);
    expect(inside(under, area, moved)).toBe(true);
  });
});

describe("a circle head slides along its edge off the cards", () => {
  const her = circle(0, 0, 220, "Her");

  it("stays at the top when no card is there", () => {
    expect(headAngle(her, [cardBox({ x: 0, y: 100 })])).toBe(0);
  });

  it("moves to the first free spot beside a card that sits on the top of the edge", () => {
    const card = cardBox({ x: 0, y: -220 });
    const angle = headAngle(her, [card]);
    expect(angle).not.toBe(0);
    const head = headBox(her, angle);
    expect(head.right <= card.left || head.left >= card.right || head.bottom <= card.top).toBe(true);
  });

  it("stays at the top when every spot covers a card, where it draws above them", () => {
    const cards = [-300, -200, -100, 0, 100, 200, 300].flatMap((x) =>
      [-240, -200, -160, -120].map((y) => cardBox({ x, y })),
    );
    expect(headAngle(her, cards)).toBe(0);
  });
});
