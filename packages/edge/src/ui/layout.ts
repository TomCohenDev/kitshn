import type { Circle, Point, ResourceKind, State } from "../core/model.ts";

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

/** The cards that the map draws, for the head rule: every placed card of a shown kind. */
export const shownCardBoxes = (
  state: Pick<State, "places" | "resources">,
  hidden: ReadonlySet<ResourceKind>,
) =>
  [...state.places].flatMap(([id, place]) => {
    const kind = state.resources.get(id)?.kind;
    return kind !== undefined && !hidden.has(kind) ? [cardBox(place)] : [];
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

/** The zoom range of a fit (K-514): it zooms out as far as the map needs, down to the wheel's 0.15. */
const FIT_SCALE = { min: 0.15, max: 2 } as const;

/** K-514: the view that shows every circle with its heads and every card whole in the free `area`. */
export function fitMap(circles: Iterable<Circle>, places: Iterable<Point>, area: Box): View | null {
  const box = mapBox(circles, places);
  return box && fitView(box, area, FIT_SCALE.min, FIT_SCALE.max);
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

/** K-525: the widths that the owner can drag for the side panel and the shelf, in px. */
export interface WidthLimits {
  readonly min: number;
  readonly max: number;
  /** The width of a device that never resized. */
  readonly initial: number;
}

/** K-525: the map keeps at least this much width between the shelf and the panel. */
export const MAP_MIN_WIDTH = 360;
/** The shelf sits 10 px from the left, the panel 12 px from the right. */
const SIDE_GAPS = 22;
/** On a screen too narrow for both minimums, neither gets narrower than this. */
const FLOOR = 120;

const clamp = (value: number, low: number, high: number) => Math.round(Math.max(low, Math.min(value, high)));

/**
 * K-525: the widths that show. The owner's wanted widths stay stored; the screen, the other element and
 * `MAP_MIN_WIDTH` of map cut them down. A hidden element (null) takes no room. The panel goes first, and the
 * shelf takes what is left; on a cramped screen both may go below their minimums, down to `FLOOR`.
 */
export function shownWidths(
  screen: number,
  wanted: { readonly panel: number | null; readonly tray: number | null },
  limits: { readonly panel: WidthLimits; readonly tray: WidthLimits },
): { readonly panel: number; readonly tray: number } {
  const room = screen - SIDE_GAPS - MAP_MIN_WIDTH;
  const trayFloor = wanted.tray === null ? 0 : limits.tray.min;
  const panelRoom = Math.max(FLOOR, room - trayFloor);
  const panel =
    wanted.panel === null
      ? 0
      : clamp(wanted.panel, Math.min(limits.panel.min, panelRoom), Math.min(limits.panel.max, panelRoom));
  const trayRoom = Math.max(FLOOR, room - panel);
  const tray =
    wanted.tray === null ? 0 : clamp(wanted.tray, Math.min(limits.tray.min, trayRoom), Math.min(limits.tray.max, trayRoom));
  return { panel, tray };
}

/** A stored width, or the initial one when the device stored none or something broken. */
export function storedWidth(raw: string | null, limits: WidthLimits): number {
  const width = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(width) ? clamp(width, limits.min, limits.max) : limits.initial;
}

/** The width after a key on a resize edge, or null for a key that does not resize. */
export function keyWidth(key: string, width: number, limits: WidthLimits, grows: "left" | "right"): number | null {
  const step = 24;
  const wider = grows === "left" ? "ArrowLeft" : "ArrowRight";
  const narrower = grows === "left" ? "ArrowRight" : "ArrowLeft";
  if (key === wider) return width + step;
  if (key === narrower) return width - step;
  if (key === "Home") return limits.min;
  if (key === "End") return limits.max;
  return null;
}
