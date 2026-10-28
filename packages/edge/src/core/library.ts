import { newJoinCode } from "./machine.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  type Member,
  type Resource,
  type State,
  activeShares,
  isPublicCircle,
} from "./model.ts";
import { type Visitor, circleMatches, memberMatches } from "./visitor.ts";

/** Names on the zone that kitshn itself uses (K-1003, K-1102, K-1208); a live site cannot take them. */
export { RESERVED_SITE_NAMES } from "kitshn/names";

/** K-1101: the largest file or page that kitshn takes. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** A page or a file in R2 (sections 10 and 11). The card on the map is the resource with the same id. */
export interface LibraryItem {
  readonly id: string;
  readonly kind: "page" | "file";
  readonly title: string;
  /** The file name in the address of a file; null for a page. */
  readonly fileName: string | null;
  readonly thread: string | null;
  readonly machine: string | null;
  readonly size: number;
  readonly contentType: string;
  readonly createdAt: number;
}

/** K-1003: 20 random characters, about 100 bits. */
export const newLibraryId = newJoinCode;

export const isLibraryId = (id: string) => /^[23456789abcdefghjkmnpqrstuvwxyz]{20}$/.test(id);

/** The R2 key of the bytes of an item. */
export const objectKey = (item: Pick<LibraryItem, "id" | "kind" | "fileName">) =>
  item.kind === "page" ? `pages/${item.id}.html` : `files/${item.id}/${item.fileName ?? ""}`;

/** A file name that is safe as one path segment of `files.<zone>/<id>/<name>`. */
export function fileNameError(name: string): string | null {
  if (name.length === 0 || name.length > 200) return "A file name has 1 to 200 characters.";
  const control = [...name].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || control)
    return "A file name cannot be . or .., or have a slash or a control character.";
  return null;
}

/** A visitor of `pages.<zone>` or `files.<zone>`. `passkey` is true after the passkey login (K-103). */
export interface ContentVisitor extends Visitor {
  readonly passkey: boolean;
  /** When Access issued the login, in seconds; null for an anonymous visitor. K-110 ends older logins. */
  readonly issuedAt: number | null;
}

const isPerson = (member: Member) => member._tag === "email" || member._tag === "domain";

/**
 * K-103, K-402: Access asks for the passkey only in the people policy. In an "any" circle, a visitor
 * who matches a network, device or machine member comes in through the Service Auth policy, without it.
 */
function passkeyNeeded(circle: Circle, visitor: ContentVisitor, state: State): boolean {
  if (!circle.needsPasskey || visitor.passkey) return false;
  if (circle.match === "all") return circle.members.some(isPerson);
  return !circle.members.some(
    (member) => !isPerson(member) && memberMatches(member, visitor, state.machines),
  );
}

/**
 * K-1004: what the Worker does with a request for a page or a file.
 * - `allow`: serve it.
 * - `login`: send the visitor to the login.
 * - `passkey`: send the visitor to the passkey login, because only a "needs passkey" circle matches.
 * - `deny`: the visitor is logged in and no circle gives access.
 *
 * The admin (K-104) opens every item, also a private one in the tray (K-1002).
 */
export function contentAccess(
  state: State,
  resource: Resource,
  visitor: ContentVisitor,
  now: number,
): "allow" | "login" | "passkey" | "deny" {
  const admin = state.resources.get(ADMIN_RESOURCE_ID);
  const decisions = [resource, ...(admin ? [admin] : [])].map((target) => {
    const shares = activeShares(state, target, now);
    // In an "all must match" circle, "everyone" adds nothing, as in Access (access.ts).
    if (
      target === resource &&
      shares.some((share) => isPublicCircle(share.circle) && share.circle.match === "any")
    )
      return "allow";
    // K-1504: during a pause Access keeps only the people policies, so only an email can match.
    if (state.paused && visitor.email === null) return "deny";
    const who = state.paused ? { ...visitor, ip: null, clientId: null } : visitor;
    const matching = shares.filter((share) => circleMatches(share.circle, who, state.machines));
    if (matching.some((share) => !passkeyNeeded(share.circle, who, state))) return "allow";
    return matching.length > 0 ? "passkey" : "deny";
  });
  if (decisions.includes("allow")) return "allow";
  if (decisions.includes("passkey")) return "passkey";
  return visitor.email === null && visitor.clientId === null ? "login" : "deny";
}

/**
 * K-1004: the login step that a decision sends the visitor to, or "explain" when the visitor just came back
 * from that same step: Access let them in, but kitshn still cannot read the login, and a redirect would loop.
 */
export function loginStep(
  decision: "allow" | "login" | "passkey" | "deny" | "missing",
  cameBackFrom: string | null,
): "login" | "passkey" | "explain" | null {
  if (decision !== "login" && decision !== "passkey") return null;
  // After the passkey login every step is done; after the login only the passkey step may follow. So the
  // two steps can never take turns forever.
  if (cameBackFrom === "passkey" || (cameBackFrom === "login" && decision === "login")) return "explain";
  return decision;
}

/** The HTML page header of the T3 render route: an opaque origin with scripts, so a page reads no cookie. */
export const contentSecurityPolicy = (adminHost: string) =>
  // Only the map may frame a page or a file (its live previews), so no other site can overlay one.
  `sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self' https://${adminHost}`;
