import type { Machine } from "./machine.ts";

/** All levels in one order, lowest first. A resource kind uses a subset (K-301, K-206). */
export const LEVELS = ["view", "use", "control"] as const;
export type Level = (typeof LEVELS)[number];

export const RESOURCE_KINDS = {
  "kitshn.admin": ["control"],
  machine: ["view", "use", "control"],
  "site.static": ["view"],
  "site.worker": ["view"],
  "site.compose": ["view"],
  "site.live": ["view"],
  page: ["view"],
  file: ["view"],
  repo: ["view"],
} as const satisfies Record<string, ReadonlyArray<Level>>;
export type ResourceKind = keyof typeof RESOURCE_KINDS;

export const ADMIN_RESOURCE_ID = "kitshn-admin";
export const OWNER_CIRCLE_ID = "owner";
export const EVERYONE_CIRCLE_ID = "everyone";

/** Milliseconds since the epoch. */
type Time = number;

export type Member =
  | { readonly _tag: "email"; readonly email: string }
  | { readonly _tag: "domain"; readonly domain: string }
  | { readonly _tag: "ip"; readonly range: string }
  /** An Access service token (K-106). `tokenId` is the token id; `clientId` is what the JWT carries. */
  | { readonly _tag: "device"; readonly tokenId: string; readonly clientId: string; readonly name: string }
  | { readonly _tag: "machine"; readonly machineId: string }
  | { readonly _tag: "everyone" };

export interface Circle {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly level: Level;
  readonly members: ReadonlyArray<Member>;
  readonly match: "any" | "all";
  readonly needsPasskey: boolean;
  readonly endsAt: Time | null;
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

export const RESOURCE_STATUSES = ["running", "stopped", "deploying", "failed", "offline", "unknown"] as const;

export interface Resource {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly name: string;
  readonly addresses: ReadonlyArray<string>;
  readonly status: (typeof RESOURCE_STATUSES)[number];
  /** Cards with the same group stack together (K-508). */
  readonly group: string | null;
  readonly machine: string | null;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** An override and an end date for one card in one circle (K-205, K-209). */
export interface ShareSetting {
  readonly level: Level | null;
  readonly endsAt: Time | null;
}

export const shareKey = (resourceId: string, circleId: string) => `${resourceId}/${circleId}`;

/**
 * K-521: a stack that the owner makes. Its cards sit on one point, so they share the same circles (K-204),
 * move as one, and show as one list card. A card is in at most one stack.
 */
export interface Stack {
  readonly id: string;
  readonly name: string;
  readonly members: ReadonlyArray<string>;
}

export interface State {
  readonly circles: ReadonlyMap<string, Circle>;
  readonly resources: ReadonlyMap<string, Resource>;
  /** Card centres. A resource without a place sits in the tray (K-509). */
  readonly places: ReadonlyMap<string, Point>;
  readonly shareSettings: ReadonlyMap<string, ShareSetting>;
  readonly stacks: ReadonlyMap<string, Stack>;
  /** K-1504: while paused, only the Owner circle keeps its share of the admin. */
  readonly paused: boolean;
  /** Joined machines (K-602); a machine member matches its service token (K-107). */
  readonly machines: ReadonlyMap<string, Machine>;
}

export const levelRank = (level: Level) => LEVELS.indexOf(level);

/** K-206: the highest level of the kind that is not above the wanted level, or null for none. */
export function levelForKind(kind: ResourceKind, wanted: Level): Level | null {
  const levels: ReadonlyArray<Level> = RESOURCE_KINDS[kind];
  let best: Level | null = null;
  for (const level of levels) if (levelRank(level) <= levelRank(wanted)) best = level;
  return best;
}

export const insideCircle = (point: Point, circle: Circle) =>
  Math.hypot(point.x - circle.x, point.y - circle.y) < circle.r;

/** K-204: a card is shared with every circle that it sits inside. */
export function circlesHolding(state: State, resourceId: string): Array<Circle> {
  const place = state.places.get(resourceId);
  if (!place) return [];
  return [...state.circles.values()].filter((circle) => insideCircle(place, circle));
}

/** The level that one circle gives on one resource (K-205, K-206), or null for none. */
export function shareLevel(state: State, resource: Resource, circle: Circle): Level | null {
  const override = state.shareSettings.get(shareKey(resource.id, circle.id))?.level;
  return levelForKind(resource.kind, override ?? circle.level);
}

export interface Share {
  readonly circle: Circle;
  readonly level: Level;
}

/** Every share of a resource with a level above none. */
export function sharesOf(state: State, resource: Resource): Array<Share> {
  return circlesHolding(state, resource.id).flatMap((circle) => {
    const level = shareLevel(state, resource, circle);
    return level ? [{ circle, level }] : [];
  });
}

/**
 * The shares that give access now: not past an end date (K-209, K-201), and during a pause only the
 * admin share of the Owner circle (K-1504).
 */
export function activeShares(state: State, resource: Resource, now: number): Array<Share> {
  return sharesOf(state, resource).filter((share) => {
    if (share.circle.endsAt !== null && share.circle.endsAt <= now) return false;
    const shareEnds = state.shareSettings.get(shareKey(resource.id, share.circle.id))?.endsAt ?? null;
    if (shareEnds !== null && shareEnds <= now) return false;
    return !state.paused || (resource.id === ADMIN_RESOURCE_ID && share.circle.id === OWNER_CIRCLE_ID);
  });
}

export const isPublicCircle = (circle: Circle) => circle.members.some((member) => member._tag === "everyone");

export const memberLabel = (member: Member): string => {
  switch (member._tag) {
    case "email":
      return member.email;
    case "domain":
      return `@${member.domain}`;
    case "ip":
      return member.range;
    case "device":
      return member.name;
    case "machine":
      return member.machineId;
    case "everyone":
      return "everyone";
  }
};
