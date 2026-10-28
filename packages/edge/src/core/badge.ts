import { openToEveryone } from "./listing.ts";
import type { Resource, State } from "./model.ts";

export type BadgeState = "deployed" | "deploying" | "failed" | "unknown";

const STATES: Record<string, BadgeState> = {
  planned: "deploying",
  running: "deploying",
  done: "deployed",
  failed: "failed",
};

/**
 * K-1119: the badge of the newest deploy (`deployState`, null for none) of `resource`. Any card that anyone may not
 * open now gives "unknown", the same as a repo kitshn never saw, so a badge never shows that a private app exists.
 */
export function badgeState(
  state: State,
  resource: Resource | undefined,
  deployState: string | null,
  now: number,
): BadgeState {
  if (!resource || deployState === null || !openToEveryone(state, resource, now)) return "unknown";
  return STATES[deployState] ?? "unknown";
}

const COLORS: Record<BadgeState, string> = {
  deployed: "#3a8a4f",
  deploying: "#b7791f",
  failed: "#c53030",
  unknown: "#8a8f98",
};

/** K-1119: a flat badge in the shields.io shape. 7 px per character fits Verdana 11 for these few words. */
export function badgeSvg(value: BadgeState): string {
  const label = "kitshn";
  const left = Math.round(label.length * 7) + 12;
  const right = Math.round(value.length * 7) + 12;
  const width = left + right;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${label}: ${value}">
<title>${label}: ${value}</title>
<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#2f3532"/><rect x="${left}" width="${right}" height="20" fill="${COLORS[value]}"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${left / 2}" y="14">${label}</text><text x="${left + right / 2}" y="14">${value}</text>
</g>
</svg>
`;
}
