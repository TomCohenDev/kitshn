import type { Edit } from "./changes.ts";
import { type Circle, type Point, type State, insideCircle } from "./model.ts";

/** A card on the map, around its place: the width and the top margin come from `.card` in styles.css. */
export const CARD_BOX = { half: 95, above: 36, below: 50 } as const;

/** Two cards whose boxes overlap on the map; a card keeps this clear of the spots in `taken`. */
const cardsOverlap = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) < 2 * CARD_BOX.half && Math.abs(a.y - b.y) < CARD_BOX.above + CARD_BOX.below;

/** Distance a card centre keeps from every circle edge, so a small move does not change its shares. */
const EDGE_MARGIN = 24;

const fits = (point: Point, circles: Iterable<Circle>, wanted: ReadonlySet<string>) => {
  for (const circle of circles) {
    const distance = Math.hypot(point.x - circle.x, point.y - circle.y);
    if (Math.abs(distance - circle.r) < EDGE_MARGIN) return false;
    if (insideCircle(point, circle) !== wanted.has(circle.id)) return false;
  }
  return true;
};

/**
 * Finds the point nearest to `from` that sits inside exactly the wanted circles (K-511, K-209), and, when
 * `taken` names card spots, where the card box overlaps none of them. Returns null when no candidate fits.
 * It tries a fixed set of candidates, so it can miss a very thin overlap. Revisit if users report that.
 */
export function placeInside(
  state: State,
  from: Point,
  wanted: ReadonlySet<string>,
  taken: ReadonlyArray<Point> = [],
): Point | null {
  const circles = [...state.circles.values()];
  const candidates: Array<Point> = [from];
  const anchors = wanted.size > 0 ? circles.filter((circle) => wanted.has(circle.id)) : circles;
  for (const anchor of anchors) {
    for (const fraction of [0, 0.25, 0.5, 0.7, 0.85]) {
      for (let step = 0; step < 24; step++) {
        const angle = (step / 24) * 2 * Math.PI;
        candidates.push({
          x: anchor.x + Math.cos(angle) * anchor.r * fraction,
          y: anchor.y + Math.sin(angle) * anchor.r * fraction,
        });
      }
    }
  }
  if (wanted.size === 0 || taken.length > 0) {
    // Outside every circle, or clear of other cards: walk outward from the card on rings.
    for (let ring = 1; ring <= 40; ring++) {
      for (let step = 0; step < 16; step++) {
        const angle = (step / 16) * 2 * Math.PI;
        candidates.push({ x: from.x + Math.cos(angle) * ring * 60, y: from.y + Math.sin(angle) * ring * 60 });
      }
    }
  }
  let best: Point | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (!fits(candidate, circles, wanted) || taken.some((spot) => cardsOverlap(candidate, spot))) continue;
    const distance = Math.hypot(candidate.x - from.x, candidate.y - from.y);
    if (distance < bestDistance) {
      best = { x: Math.round(candidate.x), y: Math.round(candidate.y) };
      bestDistance = distance;
    }
  }
  return best;
}

/** K-529: how far past a card's centre the new circle reaches, so the whole card shows inside it. */
const CARD_REACH = EDGE_MARGIN + 100;
/** K-529: the new circle is at most this many times as wide as the widest circle on the map. */
export const NEW_CIRCLE_CAP = 3;

/** The smallest circle around the points (Welzl's algorithm, iterative; fine for the cards of one selection). */
export function enclosingCircle(points: ReadonlyArray<Point>): { x: number; y: number; r: number } {
  const first = points[0];
  if (!first) throw new Error("enclosingCircle needs at least one point.");
  const inside = (c: { x: number; y: number; r: number }, p: Point) => Math.hypot(p.x - c.x, p.y - c.y) <= c.r + 1e-7;
  const two = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: Math.hypot(a.x - b.x, a.y - b.y) / 2 });
  const three = (a: Point, b: Point, c: Point) => {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    // Points on one line: the widest pair holds the third.
    if (Math.abs(d) < 1e-9) return [two(a, b), two(a, c), two(b, c)].reduce((wide, next) => (next.r > wide.r ? next : wide));
    const sq = (p: Point) => p.x * p.x + p.y * p.y;
    const x = (sq(a) * (b.y - c.y) + sq(b) * (c.y - a.y) + sq(c) * (a.y - b.y)) / d;
    const y = (sq(a) * (c.x - b.x) + sq(b) * (a.x - c.x) + sq(c) * (b.x - a.x)) / d;
    return { x, y, r: Math.hypot(a.x - x, a.y - y) };
  };
  let circle = { x: first.x, y: first.y, r: 0 };
  points.forEach((p, i) => {
    if (inside(circle, p)) return;
    circle = { x: p.x, y: p.y, r: 0 };
    for (let j = 0; j < i; j++) {
      const q = points[j] as Point;
      if (inside(circle, q)) continue;
      circle = two(p, q);
      for (let k = 0; k < j; k++) {
        const s = points[k] as Point;
        if (!inside(circle, s)) circle = three(p, q, s);
      }
    }
  });
  return circle;
}

/**
 * K-529: one new circle that holds the selected cards (with their stacks, K-521), with each card still in exactly
 * the circles it is in now. Unselected cards that fall inside move out to their nearest spot in exactly their own
 * circles. Of two plans (the cards where they are, or each pulled towards the middle of the selection) the one
 * that moves fewer cards wins, then the smaller circle. Refuses when no plan works, and changes nothing.
 */
export function circleForCards(
  state: State,
  selected: Iterable<string>,
  template: Omit<Circle, "x" | "y" | "r">,
): { readonly edits: Array<Edit>; readonly moved: number; readonly cards: number } | { readonly refused: string } {
  const ids = new Set(selected);
  for (const stack of state.stacks.values()) if (stack.members.some((id) => ids.has(id))) for (const id of stack.members) ids.add(id);
  const placed = [...ids].map((id) => ({ id, place: state.places.get(id) }));
  const missing = placed.find((card) => !card.place);
  if (missing) return { refused: `Place ${state.resources.get(missing.id)?.name ?? missing.id} on the map first.` };
  const circles = [...state.circles.values()];
  const cap = NEW_CIRCLE_CAP * Math.max(0, ...circles.map((circle) => circle.r));
  const holding = (id: string) => new Set(circles.filter((circle) => insideCircle(state.places.get(id) as Point, circle)).map((circle) => circle.id));

  type Plan = { readonly circle: Circle; readonly moves: Map<string, Point> } | { readonly refused: string };
  const plan = (moves: ReadonlyMap<string, Point>): Plan => {
    const points = [...ids].map((id) => moves.get(id) ?? (state.places.get(id) as Point));
    const around = enclosingCircle(points);
    const r = Math.ceil(around.r + CARD_REACH);
    if (circles.length > 0 && r > cap)
      return { refused: `The new circle would be wider than ${NEW_CIRCLE_CAP} times the widest circle. Select cards that sit closer together.` };
    const circle: Circle = { ...template, x: Math.round(around.x), y: Math.round(around.y), r };
    const withCircle: State = { ...state, circles: new Map(state.circles).set(circle.id, circle) };
    const out = new Map<string, Point>();
    for (const [id, place] of state.places) {
      if (ids.has(id) || !insideCircle(place, circle)) continue;
      const to = placeInside(withCircle, place, holding(id));
      if (!to) return { refused: `${state.resources.get(id)?.name ?? id} cannot leave the new circle without changing its circles. Move it, then try again.` };
      out.set(id, to);
    }
    return { circle, moves: new Map([...moves, ...out]) };
  };

  const asIs = plan(new Map());
  const middle = enclosingCircle(placed.map((card) => card.place as Point));
  const distance = (point: Point) => Math.hypot(point.x - middle.x, point.y - middle.y);
  // A stack sits on one spot, so it moves as one unit; the units nearest to the middle choose first.
  const units = new Map<string, Array<string>>();
  for (const { id } of placed) {
    const stack = [...state.stacks.values()].find((each) => each.members.includes(id));
    const key = stack ? `stack:${stack.id}` : id;
    units.set(key, [...(units.get(key) ?? []), id]);
  }
  const ordered = [...units.values()].sort(
    (a, b) => distance(state.places.get(a[0] as string) as Point) - distance(state.places.get(b[0] as string) as Point),
  );
  // Pulled cards keep clear of every other card on the map and of each other.
  const taken: Array<Point> = [...state.places].filter(([id]) => !ids.has(id)).map(([, place]) => place);
  const pulled = new Map<string, Point>();
  for (const unit of ordered) {
    const first = unit[0] as string;
    const place = state.places.get(first) as Point;
    const to = placeInside(state, middle, holding(first), taken);
    // A card that sits as close to the middle as it could get stays where it is, so the count of moves is honest.
    const stays = !to || distance(to) >= distance(place);
    taken.push(stays ? place : to);
    if (!stays) for (const id of unit) pulled.set(id, to);
  }
  const together = pulled.size > 0 ? plan(pulled) : asIs;
  const options = [asIs, together].flatMap((option) => ("refused" in option ? [] : [option]));
  const best = options.sort((a, b) => a.moves.size - b.moves.size || a.circle.r - b.circle.r)[0];
  if (!best) {
    // Both plans refused; the plan with the cards where they are names the reason the owner can act on.
    const reason = "refused" in asIs ? asIs : "refused" in together ? together : null;
    if (!reason) throw new Error("circleForCards: no plan and no reason.");
    return reason;
  }
  return {
    edits: [
      { _tag: "circle", id: best.circle.id, after: best.circle },
      ...[...best.moves].map(([id, after]): Edit => ({ _tag: "place", id, after })),
    ],
    moved: best.moves.size,
    cards: ids.size,
  };
}
