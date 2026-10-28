import { describe, expect, it } from "vitest";
import type { Circle } from "../core/model.ts";
import {
  type Box,
  cardBox,
  circleBox,
  clampWidth,
  fitMap,
  fitView,
  headAngle,
  headBox,
  keyWidth,
  mapBox,
  openArea,
  panInto,
  storedWidth,
} from "./layout.ts";

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

  it("fits a map wider than the free area whole: every head and card is left of the panel and right of the tray", () => {
    // The demo map on a 1512×982 laptop, with the tray, a two-row toolbar and the panel open.
    const circles = [
      circle(-200, 0, 520, "Owner"),
      circle(1150, -150, 380, "Everyone"),
      circle(500, 600, 400, "Her"),
      circle(-900, 900, 450, "Qlik"),
      circle(1250, 900, 300, "Agents"),
    ];
    const places = [
      { x: -500, y: -300 },
      { x: 0, y: -350 },
      { x: 1100, y: -100 },
      { x: 300, y: 100 },
    ];
    const area = openArea({ width: 1512, height: 982, top: 104, left: 220, panelLeft: 1032, narrow: false });
    const view = fitMap(circles, places, area);
    if (!view) throw new Error("A map with circles fits.");
    expect(view.s).toBeLessThan(0.85);
    for (const item of circles) expect(inside(circleBox(item), area, view)).toBe(true);
    for (const place of places) expect(inside(cardBox(place), area, view)).toBe(true);
    expect(area.left).toBeGreaterThan(220);
    expect(area.right).toBeLessThan(1032);
  });

  it("keeps a given minimum zoom, so a big map is centred in the area instead of shown whole", () => {
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

describe("resizable widths (K-525)", () => {
  const limits = { min: 160, max: 420, initial: 210 };
  it("keeps a dragged width inside its limits and the room on screen", () => {
    expect(clampWidth(100, limits, 2000)).toBe(160);
    expect(clampWidth(900, limits, 2000)).toBe(420);
    expect(clampWidth(400, limits, 300)).toBe(300);
    expect(clampWidth(250.6, limits, 2000)).toBe(251);
  });
  it("falls back to the initial width for a missing or broken stored value", () => {
    expect(storedWidth(null, limits)).toBe(210);
    expect(storedWidth("wide", limits)).toBe(210);
    expect(storedWidth("9999", limits)).toBe(420);
    expect(storedWidth("300", limits)).toBe(300);
  });
  it("moves the edge with the arrow keys towards the side the element grows to", () => {
    expect(keyWidth("ArrowLeft", 300, limits, "left")).toBe(324);
    expect(keyWidth("ArrowLeft", 300, limits, "right")).toBe(276);
    expect(keyWidth("Home", 300, limits, "left")).toBe(160);
    expect(keyWidth("End", 300, limits, "right")).toBe(420);
    expect(keyWidth("a", 300, limits, "left")).toBeNull();
  });
});
