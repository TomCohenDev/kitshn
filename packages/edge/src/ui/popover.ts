/** Pure logic of the tooltip and the menu in controls.tsx: placement, tooltip timing, menu keys. */

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  readonly left: number;
  readonly top: number;
  readonly side: Side;
}

export type Side = "top" | "bottom" | "right";

const GAP = 8;
const MARGIN = 4;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/**
 * Fixed-position coordinates for a floating card next to an anchor. It goes on the preferred side, flips
 * to the other side when only that one has room, and stays inside the viewport. A tooltip is centred on
 * its anchor; a menu starts at the left edge of its anchor. "right" puts it beside the anchor (a menu
 * item), and flips to the left side.
 */
export function placeFloating(
  anchor: Rect,
  size: Size,
  viewport: Size,
  prefer: { readonly side: Side; readonly align: "center" | "start" },
): Placement {
  if (prefer.side === "right") {
    const right = anchor.left + anchor.width + GAP;
    const left = right + size.width <= viewport.width - MARGIN ? right : anchor.left - GAP - size.width;
    return {
      side: "right",
      left: clamp(left, MARGIN, viewport.width - size.width - MARGIN),
      top: clamp(
        anchor.top + anchor.height / 2 - size.height / 2,
        MARGIN,
        viewport.height - size.height - MARGIN,
      ),
    };
  }
  const above = anchor.top - GAP - size.height;
  const below = anchor.top + anchor.height + GAP;
  const fitsAbove = above >= MARGIN;
  const fitsBelow = below + size.height <= viewport.height - MARGIN;
  const side =
    prefer.side === "top"
      ? fitsAbove || !fitsBelow
        ? "top"
        : "bottom"
      : fitsBelow || !fitsAbove
        ? "bottom"
        : "top";
  const left = prefer.align === "center" ? anchor.left + anchor.width / 2 - size.width / 2 : anchor.left;
  return {
    side,
    left: clamp(left, MARGIN, viewport.width - size.width - MARGIN),
    top: clamp(side === "top" ? above : below, MARGIN, viewport.height - size.height - MARGIN),
  };
}

export const TIP_DELAY_MS = 300;
/** After a tooltip closes by a leave, a hover this soon after shows at once, so neighbours switch fast. */
export const TIP_GRACE_MS = 200;

/**
 * When a tooltip shows: hover after a delay, keyboard focus at once, and hide on leave, blur, Escape or a
 * press. Moving from one tooltip to a neighbour switches at once. `onChange` gets the anchor to show, or
 * null to hide.
 */
export function tipTimer<T>(onChange: (anchor: T | null) => void, delayMs = TIP_DELAY_MS) {
  let shown: T | null = null;
  let pending: { readonly anchor: T; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  const endGrace = () => {
    if (grace !== null) clearTimeout(grace);
    grace = null;
  };
  const set = (anchor: T | null) => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
    if (anchor === shown) return;
    shown = anchor;
    onChange(anchor);
  };
  return {
    hover(anchor: T) {
      if (anchor === shown || anchor === pending?.anchor) return;
      if (shown !== null || grace !== null) {
        endGrace();
        return set(anchor);
      }
      if (pending) clearTimeout(pending.timer);
      pending = { anchor, timer: setTimeout(() => set(anchor), delayMs) };
    },
    focus(anchor: T) {
      endGrace();
      set(anchor);
    },
    /** The pointer or the focus left `anchor`; null means it is over no anchor at all. */
    leave(anchor: T | null) {
      if (anchor !== null && anchor !== shown && anchor !== pending?.anchor) return;
      const wasShown = shown !== null;
      set(null);
      if (!wasShown) return;
      endGrace();
      grace = setTimeout(() => (grace = null), TIP_GRACE_MS);
    },
    hide() {
      endGrace();
      set(null);
    },
  };
}

/**
 * The menu item that a key moves to, from the item labels and the current index (-1 for none). Arrows wrap,
 * Home and End jump, and a letter jumps to the next item that starts with it. Returns null for other keys.
 */
export function menuMove(key: string, current: number, labels: ReadonlyArray<string>): number | null {
  const count = labels.length;
  if (count === 0) return null;
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return current <= 0 ? count - 1 : current - 1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if ([...key].length !== 1 || key === " ") return null;
  const letter = key.toLowerCase();
  for (let step = 1; step <= count; step++) {
    const index = (current + step) % count;
    if (labels[index]?.trim().toLowerCase().startsWith(letter)) return index;
  }
  return null;
}
