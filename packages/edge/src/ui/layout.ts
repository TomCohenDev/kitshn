import type { CardKind, Circle, Point, State } from "../core/model.ts";
import { type Box, cardBox, circleBox, union } from "../core/place.ts";

/** Map geometry for fit, pan and circle heads. Pure, so the rules are testable without a DOM. */

export interface View {
  readonly x: number;
  readonly y: number;
  readonly s: number;
}

/** The cards that the map draws, for the head rule: every placed card of a shown kind. */
export const shownCardBoxes = (state: Pick<State, "places" | "resources">, hidden: ReadonlySet<CardKind>) =>
  [...state.places].flatMap(([id, place]) => {
    const kind = state.resources.get(id)?.kind;
    return kind !== undefined && !hidden.has(kind) ? [cardBox(place)] : [];
  });

/** Everything on the map: circles with their heads, and placed cards. Null for an empty map. */
export function mapBox(circles: Iterable<Circle>, places: Iterable<Point>): Box | null {
  const boxes = [...[...circles].map(circleBox), ...[...places].map(cardBox)];
  return boxes.length === 0 ? null : union(boxes);
}

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
  if (
    screen.left >= area.left &&
    screen.right <= area.right &&
    screen.top >= area.top &&
    screen.bottom <= area.bottom
  )
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
    wanted.tray === null
      ? 0
      : clamp(wanted.tray, Math.min(limits.tray.min, trayRoom), Math.min(limits.tray.max, trayRoom));
  return { panel, tray };
}

/** A stored width, or the initial one when the device stored none or something broken. */
export function storedWidth(raw: string | null, limits: WidthLimits): number {
  const width = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(width) ? clamp(width, limits.min, limits.max) : limits.initial;
}

/** The width after a key on a resize edge, or null for a key that does not resize. */
export function keyWidth(
  key: string,
  width: number,
  limits: WidthLimits,
  grows: "left" | "right",
): number | null {
  const step = 24;
  const wider = grows === "left" ? "ArrowLeft" : "ArrowRight";
  const narrower = grows === "left" ? "ArrowRight" : "ArrowLeft";
  if (key === wider) return width + step;
  if (key === narrower) return width - step;
  if (key === "Home") return limits.min;
  if (key === "End") return limits.max;
  return null;
}

/** The zoom range of the wheel and of a pinch. */
export const ZOOM = { min: 0.15, max: 2.5 } as const;

/** Two fingers on the screen. */
export interface Fingers {
  readonly a: Point;
  readonly b: Point;
}

/**
 * K-516: the view after a pinch. The spread of the fingers zooms, inside `ZOOM`, and the map point that sat
 * between them at the start stays between them, so the same move also pans with two fingers.
 */
export function pinchView(start: View, from: Fingers, to: Fingers): View {
  const spread = (fingers: Fingers) => Math.hypot(fingers.a.x - fingers.b.x, fingers.a.y - fingers.b.y);
  const middle = (fingers: Fingers) => ({
    x: (fingers.a.x + fingers.b.x) / 2,
    y: (fingers.a.y + fingers.b.y) / 2,
  });
  const before = spread(from);
  const s = Math.min(ZOOM.max, Math.max(ZOOM.min, start.s * (before > 0 ? spread(to) / before : 1)));
  const was = middle(from);
  const now = middle(to);
  const world = { x: (was.x - start.x) / start.s, y: (was.y - start.y) / start.s };
  return { s, x: now.x - world.x * s, y: now.y - world.y * s };
}

/**
 * The stacking layer of a card on the map: a dragged card first, then selected cards, then cards that show a live
 * frame, which reaches over the cards below. Null leaves the card in document order. A card with keyboard focus
 * (also inside its frame) takes `FOCUS_LAYER` in CSS (`:focus-within`), unless its own layer is higher.
 */
export function cardLayer(card: {
  readonly dragging: boolean;
  readonly selected: boolean;
  readonly framed: boolean;
}): number | null {
  if (card.dragging) return 6;
  if (card.selected) return 4;
  if (card.framed) return 3;
  return null;
}

/** The layer of a card with keyboard focus; styles.css repeats it in its `:focus-within` rule. */
export const FOCUS_LAYER = 5;

/** K-506: circle heads draw above every card layer, so a card or its frame never hides a head. */
export const HEAD_LAYER = 7;

/**
 * K-503: where the toast goes so that it keeps clear of the changed card at screen height `target`: at the top of
 * the open `area` (under the toolbar) when the card is in its lower half, else at its bottom (above the hint line,
 * or above a phone's card sheet). `screen` is the window height, for the bottom offset.
 */
export function toastPlace(
  target: number,
  area: { readonly top: number; readonly bottom: number },
  screen: number,
): { readonly top: number } | { readonly bottom: number } {
  const gap = 10;
  return target > (area.top + area.bottom) / 2
    ? { top: area.top + gap }
    : { bottom: screen - area.bottom + gap };
}

/**
 * K-508, K-521: the offset of each card of an open stack below its top card. Each step is `row`, or the height of
 * the card above plus `gap` when that card is taller, such as a card that shows a preview frame; a card not
 * measured yet steps by `row`. So no card covers the one below it.
 */
export function stackOffsets(
  heights: ReadonlyArray<number | undefined>,
  row: number,
  gap: number,
): Array<number> {
  const offsets: Array<number> = [];
  let y = 0;
  for (const height of heights) {
    offsets.push(y);
    y += Math.max(row, (height ?? 0) + gap);
  }
  return offsets;
}

/** K-532: a card that the map draws now, around its place, and the height of the frame that it shows now, if any. */
export interface DrawnCard {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** The height of its preview frame with the margin, or 0 without one. */
  readonly frame: number;
  /** Whether Previews can give it a frame (K-520). */
  readonly framable: boolean;
}

/**
 * K-532: the box of a card, or of an open stack with its cards in column order, as if every framable card showed a
 * frame of `frameRoom`, spaced as `stackOffsets` spaces a column. So the box does not depend on which cards show a
 * frame now.
 */
export function steadyBox(cards: ReadonlyArray<DrawnCard>, frameRoom: number, row: number, gap: number): Box {
  const first = cards[0];
  if (!first) throw new Error("steadyBox needs a card.");
  const heights = cards.map((card) => card.height - card.frame + (card.framable ? frameRoom : 0));
  const offsets = cards.length > 1 ? stackOffsets(heights, row, gap) : [0];
  return union(
    cards.map((card, index) => {
      const top = first.top + (offsets[index] ?? 0);
      return { left: card.left, right: card.left + card.width, top, bottom: top + (heights[index] ?? 0) };
    }),
  );
}
