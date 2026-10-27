import type { Machine } from "./machine.ts";
import {
  type Circle,
  type Level,
  type Member,
  type Resource,
  type State,
  activeShares,
  isPublicCircle,
  levelRank,
} from "./model.ts";

/** Who sent a request, as Access and Cloudflare tell the Worker (K-404). */
export interface Visitor {
  readonly email: string | null;
  /** The service token client id, from the `common_name` claim. */
  readonly clientId: string | null;
  readonly ip: string | null;
}

function ipBytes(ip: string): Array<number> | null {
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".").map(Number);
    return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
      ? parts
      : null;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tail];
  if (all.length !== 8 || !all.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  return all.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

export function ipInRange(ip: string, range: string): boolean {
  const [base, bitsText] = range.split("/");
  const address = ipBytes(ip);
  const network = base ? ipBytes(base) : null;
  const bits = Number(bitsText);
  if (!address || !network || address.length !== network.length) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > network.length * 8) return false;
  for (let bit = 0; bit < bits; bit++) {
    const mask = 0x80 >> (bit % 8);
    if (((address[bit >> 3] ?? 0) & mask) !== ((network[bit >> 3] ?? 0) & mask)) return false;
  }
  return true;
}

export function memberMatches(
  member: Member,
  visitor: Visitor,
  machines: ReadonlyMap<string, Machine>,
): boolean {
  const email = visitor.email?.toLowerCase() ?? null;
  switch (member._tag) {
    case "email":
      return email !== null && email === member.email.toLowerCase();
    case "domain":
      return email !== null && email.endsWith(`@${member.domain.toLowerCase()}`);
    case "ip":
      return typeof visitor.ip === "string" && ipInRange(visitor.ip, member.range);
    case "device":
      return visitor.clientId !== null && visitor.clientId === member.clientId;
    case "machine": {
      const machine = machines.get(member.machineId);
      return machine !== undefined && visitor.clientId === machine.clientId;
    }
    case "everyone":
      return true;
  }
}

/** K-203. An empty circle matches nobody. The passkey check runs in Access, not here (K-103). */
export function circleMatches(
  circle: Circle,
  visitor: Visitor,
  machines: ReadonlyMap<string, Machine>,
): boolean {
  if (circle.members.length === 0) return false;
  return circle.match === "all"
    ? circle.members.every((member) => memberMatches(member, visitor, machines))
    : circle.members.some((member) => memberMatches(member, visitor, machines));
}

/** K-207: the highest level of the shares whose circle matches the visitor, or null. */
export function visitorLevel(state: State, resource: Resource, visitor: Visitor, now: number): Level | null {
  let best: Level | null = null;
  for (const share of activeShares(state, resource, now)) {
    // K-1504: during a pause only people and public circles pass, as in Access: no device, machine or network-only visitor.
    if (state.paused && visitor.email === null && !isPublicCircle(share.circle)) continue;
    if (!circleMatches(share.circle, visitor, state.machines)) continue;
    if (best === null || levelRank(share.level) > levelRank(best)) best = share.level;
  }
  return best;
}
