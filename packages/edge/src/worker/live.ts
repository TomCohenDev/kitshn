import { RESERVED_SITE_NAMES } from "../core/library.ts";
import type { LiveSiteReport } from "../core/machine.ts";

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

/** K-603, K-607, K-1105: the ingress of a machine's tunnel from its live sites. */
export function tunnelConfig(sites: ReadonlyArray<LiveSite>) {
  return {
    config: {
      ingress: [
        ...[...sites]
          .sort((a, b) => a.address.localeCompare(b.address))
          .map((site) => ({
            hostname: site.address,
            service: site.target,
            ...(site.dev ? { originRequest: { httpHostHeader: "localhost" } } : {}),
          })),
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
