import { type Circle, type Point, type State, insideCircle } from "./model.ts";

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
 * Finds the point nearest to `from` that sits inside exactly the wanted circles (K-511, K-209).
 * Returns null when the circles do not overlap that way.
 * It tries a fixed set of candidates, so it can miss a very thin overlap. Revisit if users report that.
 */
export function placeInside(state: State, from: Point, wanted: ReadonlySet<string>): Point | null {
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
  if (wanted.size === 0) {
    // Outside every circle: walk outward from the card on rings.
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
    if (!fits(candidate, circles, wanted)) continue;
    const distance = Math.hypot(candidate.x - from.x, candidate.y - from.y);
    if (distance < bestDistance) {
      best = { x: Math.round(candidate.x), y: Math.round(candidate.y) };
      bestDistance = distance;
    }
  }
  return best;
}
