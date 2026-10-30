import { circlePolicies } from "../core/access.ts";
import type { Edit } from "../core/changes.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  type Member,
  type State,
  circlesHolding,
  isPublicCircle,
} from "../core/model.ts";
import { ipInRange } from "../core/visitor.ts";

/** The kinds the "Add member" input can make. Devices come from the device list; machines from the map. */
export const TYPED_KINDS = ["auto", "email", "domain", "ip", "everyone"] as const;
export type TypedKind = (typeof TYPED_KINDS)[number];

/** An address or a CIDR range that the Worker can match (K-202). */
function networkRange(text: string): string | null {
  const parts = text.split("/");
  if (parts.length > 2) return null;
  const [base = "", bits] = parts;
  if (
    bits !== undefined &&
    (bits.length === 0 || bits.length > 3 || ![...bits].every((c) => c >= "0" && c <= "9"))
  )
    return null;
  const range = `${base}/${bits ?? (base.includes(":") ? 128 : 32)}`;
  return ipInRange(base, range) ? range : null;
}

/** Text that can only be meant as a network: digits and dots, or a colon or a slash. */
const looksLikeNetwork = (text: string) =>
  text.includes(":") || text.includes("/") || [...text].every((c) => c === "." || (c >= "0" && c <= "9"));

/**
 * What the owner typed, as a member. With `auto`, the text decides: `name@x.com` is a person, `@x.com` or
 * `x.com` is an email domain, an address or a CIDR range is a network. Returns a reason string otherwise.
 */
export function memberFrom(kind: TypedKind, value: string): Member | string {
  const text = value.trim().toLowerCase();
  if (kind === "everyone") return { _tag: "everyone" };
  if (!text) return "Type an email, a domain or a network first.";
  const at = text.indexOf("@");
  const network = networkRange(text);
  const resolved: TypedKind =
    kind !== "auto"
      ? kind
      : at > 0
        ? "email"
        : network || looksLikeNetwork(text)
          ? "ip"
          : at === 0 || text.includes(".")
            ? "domain"
            : "auto";
  switch (resolved) {
    case "email":
      return at > 0 && text.indexOf(".", at) > at + 1 && !text.includes(" ")
        ? { _tag: "email", email: text }
        : "An email looks like name@example.com.";
    case "domain": {
      const domain = text.startsWith("@") ? text.slice(1) : text;
      return domain.includes(".") && !domain.includes("@") && !domain.includes(" ")
        ? { _tag: "domain", domain }
        : "A domain looks like example.com.";
    }
    case "ip":
      return network ? { _tag: "ip", range: network } : "A network looks like 10.0.0.0/8 or 203.0.113.9.";
    default:
      return "kitshn cannot tell what this is. Type an email, a domain or a network, or pick the kind.";
  }
}

/** Whether the machine `machineId` is a member of `circle`. */
export const machineMember = (circle: Circle, machineId: string) =>
  circle.members.some((member) => member._tag === "machine" && member.machineId === machineId);

/** K-1730: an agent circle holds devices and machines only, so only there do rights of a machine count. */
export const isAgentCircle = (circle: Circle) =>
  circle.members.every((member) => member._tag === "device" || member._tag === "machine");

/** What a machine joining a circle does: the edit, what to say, and a question for a circle that holds kitshn itself. */
export type JoinPlan =
  | {
      readonly edits: Array<Edit>;
      readonly done: string;
      /** The rights of the machines are in this circle's panel; null when the circle gives none. */
      readonly rightsIn: string | null;
      readonly ask: string | null;
    }
  | { readonly refused: string };

/**
 * K-539: every outcome of a machine joining a circle, for a drop on the title, the menus and the panels. A change of
 * what joining means is a change here. A member joins with no right set, so its agents gain nothing yet (K-1730).
 */
export function joinPlan(
  state: State,
  machines: ReadonlyArray<string>,
  circle: Circle,
  now = Date.now(),
): JoinPlan {
  if (isPublicCircle(circle))
    return {
      refused: `${circle.name} is public: anyone opens what it holds, so a machine needs no membership there.`,
    };
  const added = machines.map((machineId): Member => ({ _tag: "machine", machineId }));
  const after: Circle = { ...circle, members: [...circle.members, ...added] };
  const names = machines.map((id) => state.resources.get(id)?.name ?? id).join(", ");
  // K-402: Access has no policy for a machine and a person who must match together, so no one would get in.
  if (circlePolicies(after, state.machines).size === 0)
    return {
      refused: `${circle.name} must match all its members, and a machine and a person cannot match together, so no one would get in.`,
    };
  const one = machines.length === 1;
  const opens =
    circle.endsAt !== null && circle.endsAt <= now
      ? `${circle.name} has ended, so ${one ? "it opens" : "they open"} nothing.`
      : circle.match === "all"
        ? `${one ? "It opens" : "They open"} what ${circle.name} holds only together with its other members.`
        : `${one ? "It opens" : "They open"} what ${circle.name} holds.`;
  const agents = isAgentCircle(circle);
  const holdsAdmin = circlesHolding(state, ADMIN_RESOURCE_ID).some((held) => held.id === circle.id);
  return {
    edits: [{ _tag: "circle", id: circle.id, after }],
    done: `${names} joined ${circle.name}. ${opens} ${agents ? "No agent rights yet." : "A circle with people gives no agent rights."}`,
    rightsIn: agents ? circle.id : null,
    ask: holdsAdmin
      ? `${circle.name} holds kitshn itself, so ${names} would change everything in kitshn. Add ${one ? "it" : "them"} anyway?`
      : null,
  };
}

/** The edit that takes a machine out of a circle; Undo puts it back with its rights. */
export const leaveEdit = (circle: Circle, machineId: string): Edit => ({
  _tag: "circle",
  id: circle.id,
  after: {
    ...circle,
    members: circle.members.filter(
      (member) => !(member._tag === "machine" && member.machineId === machineId),
    ),
  },
});
