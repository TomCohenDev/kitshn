import type { Point } from "../core/model.ts";

/** K-516, K-523: a touch held this long without a move opens the context menu and arms a card drag. */
export const HOLD_MS = 350;
/** A pointer that moves further than this, in screen pixels, pans or drags instead of a press. */
export const SLOP_PX = 8;

/**
 * One press that can open a context menu: a touch that waits for `HOLD_MS`, or a right button that opens
 * the menu on release. "held" means the menu is open; a move past the slop after that closes it.
 */
export interface Press {
  readonly phase: "waiting" | "held" | "moved";
  readonly start: Point;
}

export type PressEvent = { readonly type: "elapsed" } | { readonly type: "move"; readonly at: Point };

export const startPress = (start: Point): Press => ({ phase: "waiting", start });

export function stepPress(press: Press, event: PressEvent): Press {
  if (press.phase === "moved") return press;
  if (event.type === "elapsed") return { ...press, phase: "held" };
  const far = Math.hypot(event.at.x - press.start.x, event.at.y - press.start.y) > SLOP_PX;
  return far ? { ...press, phase: "moved" } : press;
}

/**
 * K-516: the fingers on the map after one touches it, and the two of a pinch, or null. A primary touch is the
 * first finger of a new gesture, so every finger before it is gone, also one whose release the page never got.
 */
export function fingerDown(
  fingers: Map<number, Point>,
  id: number,
  at: Point,
  primary: boolean,
): { readonly a: Point; readonly b: Point } | null {
  if (primary) fingers.clear();
  fingers.set(id, at);
  const [a, b] = [...fingers.values()];
  return a && b ? { a, b } : null;
}
