import { zoneOfAddress } from "kitshn/recipe";
import type { Api } from "./access-sync.ts";
import type { Env } from "./env.ts";

export interface Zone {
  readonly name: string;
  readonly id: string;
}

/**
 * K-1111, K-817: the zones that kitshn publishes on, the kitshn zone first. A broken KITSHN_ZONES fails, so kitshn
 * never guesses a zone (K-006).
 */
export function zonesOf(env: Pick<Env, "KITSHN_ZONE" | "CLOUDFLARE_ZONE_ID" | "KITSHN_ZONES">): Array<Zone> {
  const main = { name: env.KITSHN_ZONE, id: env.CLOUDFLARE_ZONE_ID };
  if (!env.KITSHN_ZONES) return [main];
  const parsed: unknown = JSON.parse(env.KITSHN_ZONES);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("KITSHN_ZONES is not a JSON object of zone names and ids.");
  const others = Object.entries(parsed).map(([name, id]) => {
    if (typeof id !== "string" || id === "" || name === "")
      throw new Error(`KITSHN_ZONES has no id for ${name}.`);
    return { name, id };
  });
  return [main, ...others.filter((zone) => zone.name !== main.name)];
}

/** K-817: the zone of an address, or null when kitshn does not publish there. */
export function zoneFor(address: string, zones: ReadonlyArray<Zone>): Zone | null {
  const name = zoneOfAddress(
    address,
    zones.map((zone) => zone.name),
  );
  return zones.find((zone) => zone.name === name) ?? null;
}

/**
 * K-1111, K-817: the zone of an address as the Worker uses it. An address on the kitshn zone does not depend on
 * KITSHN_ZONES, so a broken value never stops the kitshn zone (K-006 still fails the other addresses).
 */
export function zoneOfAddressIn(
  address: string,
  env: Pick<Env, "KITSHN_ZONE" | "CLOUDFLARE_ZONE_ID" | "KITSHN_ZONES">,
): Zone | null {
  let zones: Array<Zone>;
  try {
    zones = zonesOf(env);
  } catch (error) {
    if (zoneOfAddress(address, [env.KITSHN_ZONE]))
      return { name: env.KITSHN_ZONE, id: env.CLOUDFLARE_ZONE_ID };
    throw error;
  }
  return zoneFor(address, zones);
}

/**
 * K-817, K-410: takes the custom domains of a static site's script off that are not in `addresses`, and confirms
 * with a second read that none is left. Only then may the card drop those addresses and their Access applications.
 */
export async function removeStaleDomains(
  api: Api,
  account: string,
  script: string,
  addresses: ReadonlyArray<string>,
): Promise<void> {
  const list = `${account}/workers/domains?service=${script}`;
  const stale = (await api<Array<{ id: string; hostname: string }>>("GET", list)).filter(
    (domain) => !addresses.includes(domain.hostname),
  );
  for (const domain of stale) await api("DELETE", `${account}/workers/domains/${domain.id}`);
  const left = (await api<Array<{ hostname: string }>>("GET", list)).filter(
    (domain) => !addresses.includes(domain.hostname),
  );
  if (left.length > 0)
    throw new Error(
      `${left.map((domain) => domain.hostname).join(", ")} still serve ${script}; deploy again.`,
    );
}
