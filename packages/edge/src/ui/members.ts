import type { Member } from "../core/model.ts";
import { ipInRange } from "../core/visitor.ts";

/** The kinds the "Add member" input can make. Devices come from the device list; machines from the map. */
export const TYPED_KINDS = ["auto", "email", "domain", "ip", "everyone"] as const;
export type TypedKind = (typeof TYPED_KINDS)[number];

/** An address or a CIDR range that the Worker can match (K-202). */
function networkRange(text: string): string | null {
  const range = text.includes("/") ? text : `${text}/${text.includes(":") ? 128 : 32}`;
  const base = range.split("/")[0] ?? "";
  return ipInRange(base, range) ? range : null;
}

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
        : network
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
