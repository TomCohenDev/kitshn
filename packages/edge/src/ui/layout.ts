import type { Circle, Point } from "../core/model.ts";

/** Map geometry for fit, pan and circle heads. Pure, so the rules are testable without a DOM. */

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface View {
  readonly x: number;
  readonly y: number;
  readonly s: number;
}

/** A card on the map, around its place: the width and the top margin come from `.card` in styles.css. */
const CARD = { half: 95, above: 36, below: 50 } as const;
/** A circle head sits this far above the circle edge and is about this tall (`.circle .head`). */
const HEAD = { above: 20, below: 16 } as const;

/**
 * The width of a circle head, estimated from its name: about 11px for each letter at 1rem, and 130px for the
 * level sticker, the "⋯" button and the padding. Known limit: very wide or narrow letters miss by a few
 * pixels. Revisit when heads get more stickers or a different font size.
 */
export const headWidth = (circle: Circle) =>
  11 * circle.name.length + 130 + (circle.needsPasskey ? 24 : 0) + (circle.match === "all" ? 24 : 0);

export const cardBox = (at: Point): Box => ({
  left: at.x - CARD.half,
  top: at.y - CARD.above,
  right: at.x + CARD.half,
  bottom: at.y + CARD.below,
});

/** The head of a circle at `angle` (radians from the top, positive to the right), in map units. */
export const headBox = (circle: Circle, angle: number): Box => {
  const x = circle.x + circle.r * Math.sin(angle);
  const y = circle.y - circle.r * Math.cos(angle);
  const half = headWidth(circle) / 2;
  return { left: x - half, top: y - HEAD.above, right: x + half, bottom: y + HEAD.below };
};

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The spots that a head tries along its circle edge, in this order: the top, then further to each side. */
const HEAD_ANGLES = [0, -30, 30, -55, 55].map((degrees) => (degrees * Math.PI) / 180);

/**
 * Where a circle head sits (K-506): the first spot along the top of the edge whose head covers no card. When
 * every spot covers a card, the head stays at the top; heads draw above cards, so the head stays readable.
 */
export function headAngle(circle: Circle, cards: ReadonlyArray<Box>): number {
  return HEAD_ANGLES.find((angle) => !cards.some((card) => overlaps(headBox(circle, angle), card))) ?? 0;
}

/** A circle with its head at every spot that the head can slide to (`headAngle`). */
export const circleBox = (circle: Circle): Box =>
  union([
    { left: circle.x - circle.r, top: circle.y - circle.r, right: circle.x + circle.r, bottom: circle.y + circle.r },
    ...HEAD_ANGLES.map((angle) => headBox(circle, angle)),
  ]);

/** Everything on the map: circles with their heads, and placed cards. Null for an empty map. */
export function mapBox(circles: Iterable<Circle>, places: Iterable<Point>): Box | null {
  const boxes = [...[...circles].map(circleBox), ...[...places].map(cardBox)];
  return boxes.length === 0 ? null : union(boxes);
}

export const union = (boxes: ReadonlyArray<Box>): Box => ({
  left: Math.min(...boxes.map((box) => box.left)),
  top: Math.min(...boxes.map((box) => box.top)),
  right: Math.max(...boxes.map((box) => box.right)),
  bottom: Math.max(...boxes.map((box) => box.bottom)),
});

/**
 * The part of the screen that the map shows clear of the toolbar, the tray and an open panel. On a wide
 * screen the panel floats at the right; on a narrow one it is a bottom sheet over the lower half.
 */
export function openArea(screen: {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly left: number;
  /** The left edge of the open panel, or null without one. */
  readonly panelLeft: number | null;
  readonly narrow: boolean;
}): Box {
  const gap = 20;
  const panel = screen.panelLeft !== null;
  return {
    left: screen.left + gap,
    top: screen.top + gap,
    right: panel && !screen.narrow ? screen.panelLeft - gap : screen.width - gap,
    bottom: panel && screen.narrow ? screen.height / 2 - gap : screen.height - gap,
  };
}

/** The view that shows `box` whole and centred in `area`, at a scale between `min` and `max`. */
export function fitView(box: Box, area: Box, min: number, max: number): View {
  const width = Math.max(area.right - area.left, 100);
  const height = Math.max(area.bottom - area.top, 100);
  const s = Math.min(
    max,
    Math.max(min, Math.min(width / (box.right - box.left), height / (box.bottom - box.top))),
  );
  return {
    s,
    x: area.left + (width - (box.right - box.left) * s) / 2 - box.left * s,
    y: area.top + (height - (box.bottom - box.top) * s) / 2 - box.top * s,
  };
}

/**
 * A pan that brings `box` into `area` at the same zoom: no move when it is inside already, else the box is
 * centred. A box too big for the area is centred too, so its middle shows.
 */
export function panInto(box: Box, area: Box, view: View): View {
  const screen = {
    left: box.left * view.s + view.x,
    top: box.top * view.s + view.y,
    right: box.right * view.s + view.x,
    bottom: box.bottom * view.s + view.y,
  };
  if (screen.left >= area.left && screen.right <= area.right && screen.top >= area.top && screen.bottom <= area.bottom)
    return view;
  return {
    s: view.s,
    x: view.x + (area.left + area.right) / 2 - (screen.left + screen.right) / 2,
    y: view.y + (area.top + area.bottom) / 2 - (screen.top + screen.bottom) / 2,
  };
}
