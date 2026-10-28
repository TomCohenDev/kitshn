import { RESERVED_SITE_NAMES } from "../core/library.ts";
import type { LiveSiteReport } from "../core/machine.ts";
import type { Resource } from "../core/model.ts";
import { type AccessRow, appliesBypass } from "./access-sync.ts";

/** One live site of a machine (K-1104), as the Durable Object keeps it. */
export interface LiveSite {
  readonly id: string;
  readonly machineId: string;
  readonly name: string;
  readonly address: string;
  /** `http://localhost:<port>` or `unix:<path>` (K-607). */
  readonly target: string;
  /** K-1105: a dev server gets the Host header `localhost`. */
  readonly dev: boolean;
  readonly up: boolean;
  /** When the site or its machine was last seen up. */
  readonly lastUp: number;
  /** "checking" until kitshn knows that nothing else uses the address; "refused" when something does. */
  readonly state: "checking" | "ok" | "refused";
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TARGET = /^(http:\/\/localhost:(\d{1,5})|unix:\/[^\s]{1,200})$/;

/** FNV-1a, 32 bits, as 8 hex characters. */
const fnv = (text: string) => {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
};

/** A long id keeps a hash of the machine and the name instead of being cut, so two sites never meet. */
export const liveSiteId = (machineId: string, name: string) => {
  const full = `live-${machineId}-${name}`;
  return full.length <= 63 ? full : `live-${fnv(`${machineId}/${name}`)}-${name}`.slice(0, 63);
};

/** Checks the sites that a daemon reports. Returns the valid ones and a reason for each refused one. */
export function parseSites(value: unknown): { sites: Array<LiveSiteReport>; refused: Array<string> } {
  const sites: Array<LiveSiteReport> = [];
  const refused: Array<string> = [];
  if (!Array.isArray(value)) return { sites, refused: ["The site list is not a list."] };
  for (const item of value.slice(0, 50)) {
    const site = item as Partial<Record<keyof LiveSiteReport, unknown>>;
    if (typeof site.name !== "string" || !LABEL.test(site.name))
      refused.push(`The name ${String(site.name)} is not valid.`);
    else if (RESERVED_SITE_NAMES.has(site.name))
      refused.push(`${site.name}: kitshn itself uses this name on the zone.`);
    else if (typeof site.target !== "string" || !validTarget(site.target))
      refused.push(`${site.name}: the target is not valid.`);
    else sites.push({ name: site.name, target: site.target, dev: site.dev === true, up: site.up === true });
  }
  return { sites, refused };
}

const validTarget = (target: string) => {
  const match = TARGET.exec(target);
  if (!match) return false;
  const port = match[2];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
};

/**
 * K-603: how cloudflared guards the ingress rule of a site. "check": it drops a request without a valid
 * Access JWT of the application. "bypass": the application lets everyone in and issues no JWT (K-403).
 * "pending": kitshn cannot build the check yet (`reason` says why), so the rule goes without it until a
 * later tunnel write. A site never leaves the tunnel for this.
 */
export type IngressAccess =
  | { readonly kind: "check"; readonly teamName: string; readonly aud: string }
  | { readonly kind: "bypass" }
  | { readonly kind: "pending"; readonly reason: string };

/**
 * K-603, K-403: the Access check of a site's ingress rule, from its application `app:<site>:<address>`
 * as Cloudflare last accepted it. The check comes on only once the application no longer bypasses, and
 * goes off only once it does.
 */
export function ingressAccess(
  site: LiveSite,
  rows: ReadonlyMap<string, AccessRow>,
  teamDomain: string,
): IngressAccess {
  const row = rows.get(`app:${site.id}:${site.address}`);
  if (!row?.cfId) return { kind: "pending", reason: "its Access application is not made yet" };
  const bypass = appliesBypass(row, rows);
  if (bypass === true) return { kind: "bypass" };
  // A check on a site that still bypasses would refuse every public visitor.
  if (bypass === null) return { kind: "pending", reason: "kitshn does not know if its application bypasses" };
  if (!row.aud) return { kind: "pending", reason: "its audience tag is not known yet" };
  const teamName = teamDomain.split(".")[0];
  if (!teamName) return { kind: "pending", reason: "ACCESS_TEAM_DOMAIN is empty" };
  return { kind: "check", teamName, aud: row.aud };
}

/**
 * K-817: one entry for each address that serves a live site. The socket of a Compose app serves every address of
 * its card, each with its own ingress rule, DNS record and Access application; any other site serves its own.
 */
export function servedSites(
  site: LiveSite,
  card: Pick<Resource, "kind" | "addresses"> | undefined,
): Array<LiveSite> {
  if (card?.kind !== "site.compose" || card.addresses[0] !== site.address) return [site];
  return card.addresses.map((address) => ({ ...site, address }));
}

/**
 * K-410, K-817: the live sites that may get ingress, a DNS record and an offline route: checked sites, one entry for
 * each address that serves them, and only the addresses whose Access application exists.
 */
export function protectedLiveSites(
  sites: Iterable<LiveSite>,
  cardOf: (id: string) => Pick<Resource, "kind" | "addresses"> | undefined,
  hasApplication: (site: LiveSite) => boolean,
): Array<LiveSite> {
  return [...sites]
    .filter((site) => site.state === "ok")
    .flatMap((site) => servedSites(site, cardOf(site.id)))
    .filter(hasApplication);
}

/**
 * K-817, K-410: the addresses of an existing card after a deploy. A Compose card takes the new list at once, because
 * its tunnel sync drops an old address in order. A static card keeps its old addresses until the deploy has taken
 * their custom domains off, so their Access applications stay meanwhile.
 */
export function nextCardAddresses(
  kind: Resource["kind"],
  addresses: ReadonlyArray<string>,
  existing: ReadonlyArray<string>,
): Array<string> {
  if (kind === "site.compose") return [...addresses];
  return [...addresses, ...existing.filter((address) => !addresses.includes(address))];
}

/** K-603, K-607, K-1105: the ingress of a machine's tunnel from its live sites. */
export function tunnelConfig(sites: ReadonlyArray<LiveSite>, accessOf: (site: LiveSite) => IngressAccess) {
  return {
    config: {
      ingress: [
        ...[...sites]
          .sort((a, b) => a.address.localeCompare(b.address))
          .map((site) => {
            const access = accessOf(site);
            const originRequest = {
              ...(site.dev ? { httpHostHeader: "localhost" } : {}),
              ...(access.kind === "check"
                ? { access: { required: true, teamName: access.teamName, audTag: [access.aud] } }
                : {}),
            };
            return {
              hostname: site.address,
              service: site.target,
              ...(Object.keys(originRequest).length > 0 ? { originRequest } : {}),
            };
          }),
        { service: "http_status:404" },
      ],
    },
  };
}

/** K-1108: the live sites that need the offline route: the site is down, or its machine is offline. */
export function sitesNeedingRoutes(sites: Iterable<LiveSite>, online: ReadonlySet<string>): Array<LiveSite> {
  return [...sites].filter((site) => !site.up || !online.has(site.machineId));
}

/** K-1106: the sentence of the offline page. */
export function offlineReason(machineName: string, machineOnline: boolean): string {
  return machineOnline
    ? `${machineName} is on, but the cook stepped out: nothing answers on its port. It comes back when the server on ${machineName} starts again.`
    : `The cook went home. ${machineName} is off, so this dish is off the menu for now. It comes back when ${machineName} is on.`;
}

export const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** "12 minutes ago" for the offline page. */
export function seenText(time: number | null, now: number): string {
  if (time === null) return "a while ago";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** K-1109: an answer that means the origin is down: a bad gateway, or the tunnel error 1033. */
export const originDown = (status: number) => status === 502 || status === 530;

/**
 * K-006: the addresses that a route can still reach: hostnames in tunnel ingress that Cloudflare
 * accepted, DNS records and Worker routes that kitshn made. An Access application stays while its
 * address is here.
 */
export function reachableAddresses(input: {
  readonly ingress: Iterable<string>;
  readonly records: Iterable<{ readonly address: string; readonly record_id: string }>;
  readonly routes: Iterable<{ readonly address: string; readonly route_id: string }>;
}): Set<string> {
  const reachable = new Set<string>();
  for (const body of input.ingress) {
    if (!body) continue;
    const config = JSON.parse(body) as { config?: { ingress?: Array<{ hostname?: string }> } };
    for (const rule of config.config?.ingress ?? []) if (rule.hostname) reachable.add(rule.hostname);
  }
  for (const record of input.records) if (record.record_id) reachable.add(record.address);
  for (const route of input.routes) if (route.route_id) reachable.add(route.address);
  return reachable;
}

/**
 * K-817, K-1404: why a deploy may not take an address with DNS records, or null. A record that kitshn made for this
 * same card does not block; one that kitshn made for another card, also one that waits for removal, does until it
 * is gone, and so does a record of anything else.
 */
export function dnsRecordRefusal(
  address: string,
  records: number,
  kitshnRow: { readonly card_id: string | null } | undefined,
  cardId: string,
): string | null {
  if (kitshnRow?.card_id === cardId || records === 0) return null;
  if (kitshnRow)
    return `${address} still has the DNS record of another kitshn card; it goes when that card lets go of ${address}. Deploy again then.`;
  return `${address} already has a DNS record.`;
}
